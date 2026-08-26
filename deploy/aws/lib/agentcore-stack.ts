import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";

/**
 * AgentCoreStack — the managed profile's loop hosting (ADR-0042, phase 1): the
 * SAME agent-runtime image the serverless profile runs on Fargate, hosted as an
 * AgentCore Runtime instead — one microVM session per run, scale-to-zero,
 * active-CPU billing (LLM-wait is typically free, vs Fargate's wall-clock).
 *
 * What leans in here is HOSTING only. The run's providers are the same cheap-
 * profile bundle (DynamoDB stores, Bedrock think, Code Interpreter sandbox), the
 * gate stays at the front door, and the router still creates the queued Run —
 * it just dispatches via InvokeAgentRuntime (DISPATCH=agentcore) instead of
 * ecs:RunTask. The claude-code lane deliberately stays on Fargate (§15 of the
 * service comparison: no sidecar seat, hard 2vCPU/8GB, no domain egress).
 *
 * Image trick: CfnRuntime has NO command override, so the Dockerfile's CMD is
 * shell-form over RUNTIME_ENTRYPOINT and this stack selects the agentcore.ts
 * entrypoint via an environment variable. Same DockerImageAsset parameters as
 * ServerlessStack ⇒ same content hash ⇒ the ONE image is built and pushed once.
 *
 * Envelope accepted (ADR-0042): ≤8h sessions, ≤2vCPU/8GB — fine for the loop,
 * whose heavy work (think, do) is remote. idleRuntimeSessionTimeout is tuned
 * LOW because sessions are per-run: once the run finishes the session is idle
 * garbage, and memory GB-hours bill across idle time within a session.
 */
export class AgentCoreStack extends cdk.Stack {
  /** What the router needs to dispatch here (AGENTCORE_RUNTIME_ARN). */
  readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Field-trip finding #6: AgentCore Runtime is Graviton-only — CreateRuntime
    // rejects amd64 images ("Supported platforms: [arm64]"). So the Runtime gets
    // its OWN arm64 build of the same Dockerfile (QEMU cross-build on an Intel
    // host — slow but one-time per change); Fargate + Lambda keep the amd64
    // asset in ServerlessStack. The "one image" story survives as "one
    // Dockerfile"; the single-build story does not.
    const image = new ecrAssets.DockerImageAsset(this, "RuntimeImageArm64", {
      directory: path.join(__dirname, "..", "..", ".."),
      file: "services/agent-runtime/Dockerfile",
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    // Reuse the durable stores from StateStack (imported by name — no new tables).
    const runs = dynamodb.Table.fromTableName(this, "RunsTable", "agent-os-runs");
    const budgets = dynamodb.Table.fromTableName(this, "BudgetsTable", "agent-os-budgets");
    const agents = dynamodb.Table.fromTableName(this, "AgentsTable", "agent-os-agents");

    // The session's cloud identity — the same least-privilege set as the Fargate
    // task role (ADR-0031), assumed by the AgentCore service instead of ECS.
    const runtimeRole = new iam.Role(this, "RuntimeRole", {
      roleName: "agent-os-agentcore-runtime",
      description: "agent-os loop on AgentCore Runtime - runs+budgets tables, Bedrock invoke, Code Interpreter",
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
    });
    runs.grantReadWriteData(runtimeRole); // persist conversation/status per turn
    budgets.grantReadWriteData(runtimeRole); // durable per-turn spend (SPEND_STORE=dynamodb)
    agents.grantReadData(runtimeRole); // resolve the named agent's spec (read-only)
    runtimeRole.addManagedPolicy(
      iam.ManagedPolicy.fromManagedPolicyName(this, "BedrockInvoke", "agent-os-bedrock-invoke"),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AgentCoreCodeInterpreter",
        actions: [
          "bedrock-agentcore:StartCodeInterpreterSession",
          "bedrock-agentcore:InvokeCodeInterpreter",
          "bedrock-agentcore:StopCodeInterpreterSession",
        ],
        resources: ["*"],
      }),
    );
    // Runtime pulls the image with THIS role — unlike ECS there is no separate
    // execution role, so the runtime role needs ECR pull (field-trip finding:
    // CreateRuntime 400s naming ecr:GetAuthorizationToken/BatchGetImage/
    // GetDownloadUrlForLayer without it).
    image.repository.grantPull(runtimeRole);
    // Runtime writes its own service logs/telemetry to CloudWatch on our behalf.
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "RuntimeLogs",
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"],
        resources: ["*"],
      }),
    );

    // ---- Custom Code Interpreter: PUBLIC network mode --------------------
    // The built-in aws.codeinterpreter.v1 has NO network (field-tested: pip
    // fails on DNS to pypi.org) — installing tools at runtime needs a custom
    // interpreter in PUBLIC mode. Deliberately a SECOND interpreter, not the
    // default: public = full internet (AgentCore has no domain-allowlist mode;
    // the governed middle ground is VPC + our own egress control). Select per
    // run/profile via CODE_INTERPRETER_ID.
    const publicCi = new agentcore.CfnCodeInterpreterCustom(this, "PublicCodeInterpreter", {
      name: "agent_os_ci_public",
      description: "agent-os sandbox with internet (pip/npm installs) - PUBLIC egress, use knowingly",
      networkConfiguration: { networkMode: "PUBLIC" },
    });

    // ---- Gateway (ADR-0042 phase 3): tools via AgentCore Gateway -----------
    // One MORE ToolProvider adapter behind the same port — the hand-rolled
    // tool-gateway (ADR-0011/0029) remains the preferred self-hosted answer;
    // this exists to feel out the managed one. Inbound authorizer = AWS_IAM
    // (keyless: the loop signs with its runtime role via sigv4Fetch). First
    // target: a tiny utility Lambda (utc_time/echo) — credential-free, so the
    // wire is proven before any Identity-vault credential enters the picture.
    const toolFn = new lambda.Function(this, "GatewayToolFn", {
      functionName: "agent-os-agentcore-gateway-tools",
      description: "agent-os AgentCore Gateway demo target - utc_time + echo",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(
        // Gateway lambda-target contract: tool args arrive as the event; the
        // invoked tool's name rides in context.clientContext.custom.
        `exports.handler = async (event, context) => {
          const raw = context.clientContext?.custom?.bedrockAgentCoreToolName ?? "";
          const tool = raw.split("___").pop();
          if (tool === "utc_time") return { time: new Date().toISOString() };
          if (tool === "echo") return { echo: event?.text ?? "" };
          return { error: "unknown tool: " + raw };
        };`,
      ),
    });

    const gatewayRole = new iam.Role(this, "GatewayRole", {
      roleName: "agent-os-agentcore-gateway",
      description: "agent-os AgentCore Gateway - invokes its Lambda targets + evaluates Cedar",
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
    });
    toolFn.grantInvoke(gatewayRole);
    // Policy evaluation (field-trip finding: attaching an engine FAILS CreateGateway
    // without these on the EXECUTION role — "Access denied while calling
    // GetPolicyEngine"). gateway/* because the gateway's own id doesn't exist until
    // create; the docs' example uses the same wildcard. Tighten post-create if wanted.
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "EvaluateCedarPolicies",
        actions: [
          "bedrock-agentcore:GetPolicyEngine",
          "bedrock-agentcore:AuthorizeAction",
          "bedrock-agentcore:PartiallyAuthorizeActions",
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:policy-engine/*`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
        ],
      }),
    );

    // ---- Policy (ADR-0042 phase 4): Cedar at the tool boundary --------------
    // A policy engine attached to the Gateway intercepts EVERY tool call before
    // execution — more tool-boundary authz than the cheap profile has ever run
    // (AllowAll). Cedar is default-deny, so the permit-all statement is what
    // makes the demo tools callable; real per-tenant/per-tool rules replace it.
    // Scope honesty (comparison §8): this governs the Gateway's tools only —
    // front-door authz (run:create, agent:register) stays on OUR Authorizer port.
    const policyEngine = new agentcore.CfnPolicyEngine(this, "PolicyEngine", {
      name: "agent_os_policy",
      description: "agent-os Cedar policy engine on the AgentCore Gateway (ADR-0042 phase 4)",
    });
    const gateway = new agentcore.CfnGateway(this, "Gateway", {
      name: "agent-os-tools",
      description: "agent-os tools via AgentCore Gateway (ADR-0042 phase 3) - MCP, IAM inbound",
      authorizerType: "AWS_IAM",
      protocolType: "MCP",
      roleArn: gatewayRole.roleArn,
      policyEngineConfiguration: { arn: policyEngine.attrPolicyEngineArn, mode: "ENFORCE" },
    });
    // CreateGateway validates GetPolicyEngine with the execution role at create
    // time — same race as the Runtime/ECR one: depend on the role's DefaultPolicy.
    gateway.node.addDependency(gatewayRole);

    new agentcore.CfnGatewayTarget(this, "UtilityTarget", {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: "utility",
      description: "credential-free demo tools proving the Gateway wire",
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: toolFn.functionArn,
            toolSchema: {
              inlinePayload: [
                {
                  name: "utc_time",
                  description: "Current UTC time (ISO 8601).",
                  inputSchema: { type: "object" },
                },
                {
                  name: "echo",
                  description: "Echo the given text back.",
                  inputSchema: {
                    type: "object",
                    properties: { text: { type: "string", description: "Text to echo." } },
                    required: ["text"],
                  },
                },
              ],
            },
          },
        },
      },
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
    });

    // ---- Memory (ADR-0042 phase 2): the managed `remember` backend ----------
    // One memory resource, SEMANTIC built-in strategy extracting long-term
    // records into per-tenant namespaces (/tenants/{actorId}) — the feature no
    // other managed memory has: isolation enforceable by IAM condition keys
    // (bedrock-agentcore:namespace), not adapter code. Extraction is async;
    // events expire after 30 days, extracted records persist.
    const memory = new agentcore.CfnMemory(this, "Memory", {
      name: "agent_os_memory",
      description: "agent-os managed remember backend (ADR-0042 phase 2) - per-tenant IAM namespaces",
      eventExpiryDuration: 30,
      memoryStrategies: [
        {
          semanticMemoryStrategy: {
            name: "semantic",
            namespaces: ["/tenants/{actorId}"],
          },
        },
      ],
    });

    const runtime = new agentcore.CfnRuntime(this, "Runtime", {
      agentRuntimeName: "agent_os_runtime", // pattern forbids dashes
      description: "agent-os L1 loop on AgentCore Runtime - session-per-run (ADR-0042 phase 1)",
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: image.imageUri },
      },
      roleArn: runtimeRole.roleArn,
      // PUBLIC egress matches the no-NAT cheap posture: the loop talks out to
      // DynamoDB/Bedrock/AgentCore over public AWS APIs, nothing dials in except
      // InvokeAgentRuntime. VPC mode is the graduation when egress must be walled.
      networkConfiguration: { networkMode: "PUBLIC" },
      protocolConfiguration: "HTTP",
      // Sessions are per-run: after the run finishes the session is idle garbage,
      // and memory GB-hours bill across in-session idle — reap fast (60s, vs the
      // 15-min default). maxLifetime stays the 8h ceiling for long runs.
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 60 },
      environmentVariables: {
        // the CMD selector (no command override on CfnRuntime — see the Dockerfile)
        RUNTIME_ENTRYPOINT: "services/agent-runtime/agentcore.ts",
        PORT: "8080", // Runtime's HTTP contract port
        REGION: this.region,
        // the SAME cheap-profile adapter bundle as the Fargate executor (ADR-0031):
        RUN_STORE: "dynamodb",
        RUNS_TABLE: "agent-os-runs",
        SPEND_STORE: "dynamodb",
        SPEND_TABLE: "agent-os-budgets",
        AGENT_REGISTRY: "dynamodb",
        AGENTS_TABLE: "agent-os-agents",
        GATE: "local",
        INFERENCE_PROVIDER: "bedrock",
        MODEL_ID: "amazon.nova-lite-v1:0",
        SANDBOX_PROVIDER: "agentcore",
        // TELEMETRY=otel without an endpoint = console exporter (spans → the
        // Runtime's CloudWatch logs). Grafana OTLP needs its auth header, which is
        // an SSM SecureString — CfnRuntime env vars are plaintext, so wiring that
        // in is a follow-up (fetch-at-start via SSM read), not a template value.
        TELEMETRY: "otel",
        // tools via the AgentCore Gateway (phase 3): the loop's McpToolProvider
        // signs each MCP call with the runtime role (auth=sigv4) — keyless.
        MCP_SERVERS: JSON.stringify({
          gw: { transport: "http", url: gateway.attrGatewayUrl, auth: "sigv4", region: this.region },
        }),
        // remember via AgentCore Memory (phase 2): selects the managed adapter.
        AGENTCORE_MEMORY_ID: memory.attrMemoryId,
      },
    });
    // memory data plane: write events, list + search records — scoped to OUR
    // memory resource. (The per-tenant namespace condition key is the next
    // tightening: bedrock-agentcore:namespace StringEquals /tenants/<t> once
    // per-tenant runtime roles exist; one shared loop role can't vary it.)
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AgentCoreMemoryDataPlane",
        actions: [
          "bedrock-agentcore:CreateEvent",
          "bedrock-agentcore:ListMemoryRecords",
          "bedrock-agentcore:RetrieveMemoryRecords",
        ],
        resources: [memory.attrMemoryArn],
      }),
    );
    // the loop calls the Gateway's MCP endpoint as itself (SigV4)
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeAgentCoreGateway",
        actions: ["bedrock-agentcore:InvokeGateway"],
        resources: [gateway.attrGatewayArn, `${gateway.attrGatewayArn}/*`],
      }),
    );

    // CreateRuntime VALIDATES ECR pull access at create time, and referencing
    // roleArn only orders the Runtime after the Role — not after the Role's
    // DefaultPolicy (a separate CFN resource carrying the ECR grant). Without
    // this, creation races the policy and 400s "Access denied while validating
    // ECR URI" (second field-trip finding).
    runtime.node.addDependency(runtimeRole);

    // The Cedar statement, created LAST. Two field-trip findings baked in:
    // (1) automated reasoning REJECTS unbounded statements — a bare permit-all
    //     ("wildcard resource") and even resource-type-scoped-but-any-action
    //     ("Overly Permissive ... Any Future Tools") both fail CreatePolicy;
    //     the permit must name its actions (targetName___toolName) and pin the
    //     gateway ARN. Cedar stays default-deny for anything not listed.
    // (2) fast-failing resources wedge rollbacks: a CreatePolicy failure while
    //     Memory/Runtime are still CREATING leaves DeleteMemory "in
    //     transitional state" → ROLLBACK_FAILED. Depending on both makes the
    //     flakiest resource the last one standing.
    const toolsPolicy = new agentcore.CfnPolicy(this, "PermitUtilityToolsPolicy", {
      name: "permit_utility_tools",
      description: "permit IAM-authenticated callers the two utility tools; everything else default-deny",
      policyEngineId: policyEngine.attrPolicyEngineId,
      definition: {
        cedar: {
          statement:
            `permit(principal is AgentCore::IamEntity, ` +
            `action in [AgentCore::Action::"utility___utc_time", AgentCore::Action::"utility___echo"], ` +
            `resource == AgentCore::Gateway::"${gateway.attrGatewayArn}");`,
        },
      },
    });
    toolsPolicy.node.addDependency(memory);
    toolsPolicy.node.addDependency(runtime);

    this.runtimeArn = runtime.attrAgentRuntimeArn;

    new cdk.CfnOutput(this, "RuntimeArn", { value: runtime.attrAgentRuntimeArn });
    new cdk.CfnOutput(this, "RuntimeId", { value: runtime.attrAgentRuntimeId });
    new cdk.CfnOutput(this, "RuntimeRoleArn", { value: runtimeRole.roleArn });
    new cdk.CfnOutput(this, "GatewayUrl", { value: gateway.attrGatewayUrl });
    new cdk.CfnOutput(this, "GatewayArn", { value: gateway.attrGatewayArn });
    new cdk.CfnOutput(this, "MemoryId", { value: memory.attrMemoryId });
    new cdk.CfnOutput(this, "PolicyEngineArn", { value: policyEngine.attrPolicyEngineArn });
    new cdk.CfnOutput(this, "PublicCodeInterpreterId", { value: publicCi.attrCodeInterpreterId });

    // ---- BYO-container Runtime: the Java box (postures §4.3, proven) --------
    // Same loop, same entrypoint, plus a JDK — deployed as a SECOND Runtime.
    // SANDBOX_PROVIDER=local: the microVM IS the sandbox (co-located shape) —
    // the agent compiles/tests in its own box, no per-tool-call network hop.
    // Trust shape is Model B's (loop + code share the box): acceptable because
    // the box holds only this run's session and the runtime role.
    const javaImage = new ecrAssets.DockerImageAsset(this, "JavaRuntimeImageArm64", {
      directory: path.join(__dirname, "..", "..", ".."),
      file: "services/agent-runtime/Dockerfile.java",
      platform: ecrAssets.Platform.LINUX_ARM64,
    });
    image.repository.grantPull(runtimeRole); // same CDK assets repo either way
    const javaRuntime = new agentcore.CfnRuntime(this, "JavaRuntime", {
      agentRuntimeName: "agent_os_runtime_java",
      description: "agent-os loop + JDK17 in one microVM - the BYO-container box (ADR-0042)",
      agentRuntimeArtifact: { containerConfiguration: { containerUri: javaImage.imageUri } },
      roleArn: runtimeRole.roleArn,
      networkConfiguration: { networkMode: "PUBLIC" },
      protocolConfiguration: "HTTP",
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 60 },
      environmentVariables: {
        PORT: "8080",
        REGION: this.region,
        RUN_STORE: "dynamodb",
        RUNS_TABLE: "agent-os-runs",
        SPEND_STORE: "dynamodb",
        SPEND_TABLE: "agent-os-budgets",
        AGENT_REGISTRY: "dynamodb",
        AGENTS_TABLE: "agent-os-agents",
        GATE: "local",
        INFERENCE_PROVIDER: "bedrock",
        MODEL_ID: "amazon.nova-lite-v1:0", // agents override via spec.model
        SANDBOX_PROVIDER: "local", // the microVM is the sandbox (co-located)
        AGENTCORE_MEMORY_ID: memory.attrMemoryId,
        TELEMETRY: "otel",
      },
    });
    javaRuntime.node.addDependency(runtimeRole);
    new cdk.CfnOutput(this, "JavaRuntimeArn", { value: javaRuntime.attrAgentRuntimeArn });
  }
}
