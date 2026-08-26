import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { SpecRestApiEdge } from "./spec-rest-api";

/**
 * ServerlessStack — the cheap-profile compute substrate for the agent run loop
 * (ADR-0031): the loop runs as a **Fargate task-per-run**, not on always-on EKS.
 * This stack provisions the executor half + the dispatch contract the front door
 * (the router, DISPATCH=runtask) consumes. It REUSES StateStack's DynamoDB tables
 * and BedrockStack's invoke policy — no duplication.
 *
 * Cost shape (the whole point): no NAT gateway and no ALB. Tasks run in PUBLIC
 * subnets with a public IP so they reach Bedrock / DynamoDB / ECR directly; the
 * cluster holds zero running tasks at rest. Idle cost ≈ log retention ≈ $0. A run
 * costs only for the seconds its task is alive.
 *
 * The agent-runtime image is a **CDK DockerImageAsset**: `cdk deploy` builds it and
 * pushes it to the CDK-managed assets ECR repo, then BOTH the Fargate task and the
 * Lambda reference that one image (different CMDs). So the whole thing — image build,
 * push, and every resource — is one `cdk deploy`; no manual docker push, no repo to
 * manage. (Trade-off: deploy needs Docker running, since it builds the image.)
 *
 * What's deployed:
 *   - the agent-runtime image (DockerImageAsset — built + pushed by CDK).
 *   - a minimal public VPC + Fargate cluster + a task security group (egress only).
 *   - the executor task definition: the image with the task.ts CMD, RUN_ID injected
 *     per run via a container override at RunTask time.
 *   - a least-privilege task role (runs+budgets tables, Bedrock invoke, AgentCore).
 *   - the claude-code runner (ADR-0033): a second image + task def for
 *     kind="claude-code" agents — headless Claude Code per run, subscription token
 *     from an SSM SecureString (default aws/ssm key, $0), its own minimal task role.
 *   - a router role: ecs:RunTask + iam:PassRole — what the front door assumes to
 *     dispatch a task-per-run, plus tables access for create + budget checks.
 *   - the front-door COMPUTE: a Lambda (the SAME image, lambda.ts CMD → a native
 *     Runtime API loop, no HTTP server / no Web Adapter) with a Function URL. It
 *     runs the router (DISPATCH=runtask) and dispatches Fargate tasks. This is the
 *     always-reachable half; it too scales to zero (no idle cost between requests).
 *
 * You can also run the router locally against this stack instead of the Lambda:
 * assume AgentOsServerlessRouterRole, export the ECS_* outputs, and
 * `DISPATCH=runtask bun run services/agent-runtime/server.ts`.
 */
export interface ServerlessStackProps extends cdk.StackProps {
  /** Wire the front door to a Cognito user pool (ADR-0032): AUTHN=cognito with these
   *  values. Unset ⇒ the pre-0032 static-token gate (context `-c gateTokens=...`). */
  cognito?: { issuer: string; clientId: string };
  /** The inference gateway's URL (ADR-0039) — handed to DELEGATED agents as their only
   *  sanctioned think-path (AGENT_GATEWAY_URL on the executor). Deliberately NOT
   *  INFERENCE_GATEWAY_URL: that would flip the loop's own think into gateway mode. */
  agentGatewayUrl?: string;
  /** The managed profile (ADR-0042): offer this AgentCore Runtime as a per-run
   *  substrate choice (`dispatch: "agentcore"` on POST /runs; Fargate stays the
   *  default). cc runs ALWAYS ride Fargate. Unset ⇒ Fargate is the only substrate. */
  agentcore?: { runtimeArn: string };
  /** The spec-driven custom-domain edge (ADR-0043). Unset ⇒ fall back to the
   *  bare Function URL (the pre-0043 posture, kept for context-less synth). */
  edge?: { domainName: string; hostedZone: { id: string; name: string } };
}

export class ServerlessStack extends cdk.Stack {
  /** The front door's public address — what the console's config.json points at (ADR-0032). */
  readonly frontDoorUrl: string;

  constructor(scope: Construct, id: string, props?: ServerlessStackProps) {
    super(scope, id, props);

    // Optional demo bearer tokens for the front door's LocalGate, injected at deploy
    // (`-c gateTokens=...`) so nothing static is committed. See the FrontDoor env below.
    const gateTokens = this.node.tryGetContext("gateTokens");
    // Runs/period quota for kind=claude-code agents (ADR-0036/0037), off unless set.
    const claudeCodeQuota = this.node.tryGetContext("claudeCodeQuota");

    // The agent-runtime image, built + pushed by CDK at deploy time (one image, three
    // entrypoints: server.ts / task.ts / lambda.ts — the consumer picks via CMD). The
    // build context is the repo root (the Dockerfile's `COPY . .`); .dockerignore there
    // strips node_modules/.git/venvs. x86_64 to match the Intel build host (native, no
    // QEMU); switch to LINUX_ARM64 + arm64 task/Lambda when building on Graviton.
    const image = new ecrAssets.DockerImageAsset(this, "Image", {
      directory: path.join(__dirname, "..", "..", ".."),
      file: "services/agent-runtime/Dockerfile",
      platform: ecrAssets.Platform.LINUX_AMD64,
    });

    // Minimal public VPC: 2 AZs, public subnets only, NO NAT gateway (~$32/mo
    // saved). Tasks get a public IP and egress straight to AWS APIs.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: "agent-os-serverless",
      vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED, // POC: skip the CloudWatch cost
    });

    // Egress-only SG for the task ENI (talks out to Bedrock/DynamoDB/ECR; nothing
    // dials in — the task is not a server).
    const taskSg = new ec2.SecurityGroup(this, "TaskSg", {
      vpc,
      description: "agent-os serverless task-per-run - egress only",
      allowAllOutbound: true,
    });

    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: "/agent-os/serverless",
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Reuse the durable stores from StateStack (imported by name — no new tables).
    const runs = dynamodb.Table.fromTableName(this, "RunsTable", "agent-os-runs");
    const budgets = dynamodb.Table.fromTableName(this, "BudgetsTable", "agent-os-budgets");
    const agents = dynamodb.Table.fromTableName(this, "AgentsTable", "agent-os-agents");

    // The task's cloud identity — least privilege for what a run actually does.
    const taskRole = new iam.Role(this, "TaskRole", {
      roleName: "agent-os-serverless-task",
      description: "agent-os task-per-run - runs+budgets tables, Bedrock invoke, AgentCore sandbox",
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    runs.grantReadWriteData(taskRole); // persist conversation/status per turn
    budgets.grantReadWriteData(taskRole); // durable per-turn spend (SPEND_STORE=dynamodb)
    agents.grantReadData(taskRole); // resolve the named agent's spec (read-only)
    // Bedrock invoke — reuse BedrockStack's scoped managed policy (specific models +
    // ApplyGuardrail), not a fresh "bedrock:*".
    taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromManagedPolicyName(this, "BedrockInvoke", "agent-os-bedrock-invoke"),
    );
    // AgentCore Code Interpreter sandbox — exactly the 3 commands the adapter calls.
    // Resource "*": the built-in interpreter is AWS-owned; scope to a specific
    // code-interpreter ARN once a custom one is used.
    taskRole.addToPolicy(
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

    // The executor task def. cpu/mem sized for the loop (think is remote; the
    // sandbox is AgentCore, also remote) — small is fine.
    const taskDef = new ecs.FargateTaskDefinition(this, "ExecutorTaskDef", {
      family: "agent-os-runtime-task",
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      // x86_64 (the default): the image builds natively on the Intel build host, no
      // QEMU emulation. arm64/Graviton would be ~cheaper at runtime but needs an arm64
      // builder; revisit if building on Apple Silicon or in CI with buildx.
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    // record (ADR-0035): the loop's spans export OTLP DIRECT to Grafana Cloud —
    // no collector, per-span flush fits a task-per-run. Opt in at deploy:
    //   -c otelEndpoint=https://otlp-gateway-<zone>.grafana.net/otlp
    // with the auth header ("Authorization=Basic <base64 instance:token>") in an
    // SSM SecureString (same $0 pattern as the runner tokens, ADR-0033):
    //   aws ssm put-parameter --name /agent-os/otel/otlp-headers --type SecureString --value '…'
    // Unset ⇒ TELEMETRY=otel still runs the console exporter (spans → CloudWatch).
    // (Replaces the dead RECORD env — config.ts reads TELEMETRY, so RECORD=otel
    // had silently disabled spans since the first serverless deploy.)
    const otelEndpoint = this.node.tryGetContext("otelEndpoint");
    const otelHeaders = otelEndpoint
      ? ssm.StringParameter.fromSecureStringParameterAttributes(this, "OtelHeaders", {
          parameterName: "/creance/otel/otlp-headers",
        })
      : undefined;

    taskDef.addContainer("agent-runtime-task", {
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      command: ["bun", "run", "services/agent-runtime/task.ts"], // the task-per-run entrypoint
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "task" }),
      environment: {
        // RUN_ID is injected per run via a RunTask container override (not here).
        REGION: this.region,
        // serverless / cheap-profile adapter bundle (ADR-0027/0031):
        RUN_STORE: "dynamodb",
        RUNS_TABLE: "agent-os-runs",
        SPEND_STORE: "dynamodb",
        SPEND_TABLE: "agent-os-budgets",
        AGENT_REGISTRY: "dynamodb", // resolve the run's named agent from the catalog table
        AGENTS_TABLE: "agent-os-agents",
        GATE: "local",
        INFERENCE_PROVIDER: "bedrock",
        MODEL_ID: "amazon.nova-lite-v1:0",
        SANDBOX_PROVIDER: "agentcore",
        TELEMETRY: "otel", // the record control (ADR-0035)
        ...(otelEndpoint ? { OTEL_EXPORTER_OTLP_ENDPOINT: String(otelEndpoint) } : {}),
        // delegated agents' think-path (ADR-0039): sandboxed/custom runs hand this to
        // the foreign agent; the loop's OWN think stays direct (INFERENCE_GATEWAY_URL unset)
        ...(props?.agentGatewayUrl ? { AGENT_GATEWAY_URL: props.agentGatewayUrl } : {}),
      },
      ...(otelHeaders ? { secrets: { OTEL_EXPORTER_OTLP_HEADERS: ecs.Secret.fromSsmParameter(otelHeaders) } } : {}),
    });

    // ---- Claude Code runner (ADR-0033) --------------------------------------
    // A SECOND executor for kind="claude-code" agents: one headless Claude Code
    // invocation per run, same RUN_ID-override contract, same runs table. Its own
    // image (the harness binary doesn't belong in the loop image) and its own task
    // role (runs+agents tables only — no Bedrock, no AgentCore: the subscription
    // token is the model credential).
    const ccImage = new ecrAssets.DockerImageAsset(this, "ClaudeCodeImage", {
      directory: path.join(__dirname, "..", "..", ".."),
      file: "services/claude-code-runner/Dockerfile",
      platform: ecrAssets.Platform.LINUX_AMD64,
    });

    // The operator's Claude subscription token (`claude setup-token`), stored as an
    // SSM SecureString under the default aws/ssm key — $0/mo vs Secrets Manager's
    // $0.40. CloudFormation can't create SecureString VALUES, so the parameter is
    // written once out-of-band (see services/claude-code-runner/README.md) and only
    // REFERENCED here. ECS resolves it at task start; it never lands in the template.
    const ccToken = ssm.StringParameter.fromSecureStringParameterAttributes(this, "ClaudeCodeToken", {
      parameterName: "/creance/claude-code/oauth-token",
    });

    const ccTaskRole = new iam.Role(this, "ClaudeCodeTaskRole", {
      roleName: "agent-os-claude-code-task",
      description: "agent-os claude-code runner - runs table RW + agents table R, nothing else",
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    runs.grantReadWriteData(ccTaskRole); // mirror the transcript + terminal status
    agents.grantReadData(ccTaskRole); // resolve the agent spec (systemPrompt/maxSteps/model)

    // Bigger than the loop executor on purpose: think is NOT remote here — the
    // harness plus whatever a coding task builds/tests runs in this container.
    const ccTaskDef = new ecs.FargateTaskDefinition(this, "ClaudeCodeTaskDef", {
      family: "agent-os-claude-code-task",
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole: ccTaskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const ccContainer = ccTaskDef.addContainer("claude-code-runner", {
      image: ecs.ContainerImage.fromDockerImageAsset(ccImage),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "claude-code" }),
      // NO secrets here (ADR-0034, completed): the agent container is fully
      // credential-free. The harness needs *a* token to select OAuth mode, so it
      // gets a dummy; the REAL subscription token lives on the sidecar, which
      // injects it into /v1/* requests remapped via ANTHROPIC_BASE_URL.
      environment: {
        // RUN_ID is injected per run via the RunTask container override (not here).
        REGION: this.region,
        RUNS_TABLE: "agent-os-runs",
        AGENTS_TABLE: "agent-os-agents",
        ANTHROPIC_BASE_URL: "http://localhost:8082",
        CLAUDE_CODE_OAUTH_TOKEN: "sidecar-injected", // placeholder, never reaches the wire
      },
    });

    // The egress sidecar (ADR-0034): SAME image, different CMD — the git choke
    // point. The GitHub App private key is a secret on THIS container only; from it
    // the sidecar mints a per-run installation token down-scoped to JUST the run's
    // repo (contents+PR, ~1h). The agent container reaches GitHub exclusively through
    // localhost:8081, where the sidecar injects that token and enforces repo allowlist
    // + run/*-branch push policy. The PAT is retired — no broad long-lived credential.
    // essential=false: when the runner exits the task stops; a sidecar crash alone
    // doesn't kill a run (the shim's git calls fail visibly instead).
    const ccGithubAppKey = ssm.StringParameter.fromSecureStringParameterAttributes(this, "ClaudeCodeGithubAppKey", {
      parameterName: "/creance/github-app-private-key",
    });
    const ccSidecar = ccTaskDef.addContainer("egress-sidecar", {
      image: ecs.ContainerImage.fromDockerImageAsset(ccImage),
      command: ["bun", "run", "services/claude-code-runner/sidecar.ts"],
      essential: false,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "claude-code-sidecar" }),
      secrets: {
        GITHUB_APP_PRIVATE_KEY: ecs.Secret.fromSsmParameter(ccGithubAppKey), // per-run repo-scoped tokens
        // the subscription token moved HERE from the agent container (ADR-0034
        // completed): the sidecar swaps it into remapped /v1/* inference calls.
        CLAUDE_CODE_OAUTH_TOKEN: ecs.Secret.fromSsmParameter(ccToken),
      },
      environment: {
        // RUN_ID arrives via the same RunTask override; the sidecar reads the
        // run's gate-authorized repo from the runs table (task role covers it).
        REGION: this.region,
        RUNS_TABLE: "agent-os-runs",
        // GitHub App identity (not secret): the App and its install on the org.
        GITHUB_APP_ID: "4232149",
        GITHUB_APP_INSTALLATION_ID: "145860623",
      },
    });
    ccContainer.addContainerDependencies({
      container: ccSidecar,
      condition: ecs.ContainerDependencyCondition.START, // shim polls /healthz before cloning
    });

    // The router's identity (the front door). It does NOT run loops — it dispatches
    // them: create the queued Run, then ecs:RunTask the executor, passing the task +
    // execution roles. Attach this to the Lambda/Fargate that serves POST /runs.
    const routerRole = new iam.Role(this, "RouterRole", {
      roleName: "agent-os-serverless-router",
      description: "agent-os serverless front door - ecs:RunTask + PassRole + tables",
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("lambda.amazonaws.com"),
        new iam.ServicePrincipal("ecs-tasks.amazonaws.com"), // if fronted by a Fargate service
        new iam.AccountRootPrincipal(), // run the router locally against this stack
      ),
    });
    runs.grantReadWriteData(routerRole); // create queued Run + serve GET /runs/{id} polling
    budgets.grantReadData(routerRole); // gate.checkBudget before admitting a run
    agents.grantReadWriteData(routerRole); // reads + the gated agent writes (POST/DELETE /agents, ADR-0038)
    routerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "DispatchRunTask",
        actions: ["ecs:RunTask"],
        // allow any revision of these families, so a redeploy doesn't break dispatch
        resources: [
          `arn:aws:ecs:${this.region}:${this.account}:task-definition/${taskDef.family}:*`,
          `arn:aws:ecs:${this.region}:${this.account}:task-definition/${ccTaskDef.family}:*`,
        ],
        conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
      }),
    );
    routerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassTaskRoles",
        actions: ["iam:PassRole"],
        resources: [
          taskRole.roleArn,
          taskDef.executionRole!.roleArn,
          ccTaskRole.roleArn,
          ccTaskDef.executionRole!.roleArn,
        ],
        conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
      }),
    );
    // We supply the router role, so CDK won't auto-attach Lambda's log permissions.
    routerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
    );
    // The coder loop (ADR-0046): at dispatch the front door mints a per-run GitHub
    // App installation token for kind="coder" runs targeting a repo — the SAME App
    // the egress sidecar uses (ADR-0034), read from the SAME SSM key. The control
    // plane is the only place that can mint for every substrate (the microVM and
    // Vertex can't reach the key); only the ~1h repo-scoped token enters the workspace.
    ccGithubAppKey.grantRead(routerRole);
    // Managed profile (ADR-0042): the router dispatches loop runs via
    // InvokeAgentRuntime. Session-scoped resource: Runtime authorizes the invoke
    // against the runtime ARN and its session subresources.
    if (props?.agentcore) {
      routerRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "DispatchAgentCoreRuntime",
          actions: ["bedrock-agentcore:InvokeAgentRuntime"],
          resources: [props.agentcore.runtimeArn, `${props.agentcore.runtimeArn}/*`],
        }),
      );
    }

    // The front door — the SAME image asset, the lambda.ts entrypoint (a native Lambda
    // Runtime API loop; no HTTP server, no Web Adapter — ADR-0031). It runs the router:
    // DISPATCH=runtask makes POST /runs launch a Fargate task-per-run. NOT in the VPC —
    // it reaches DynamoDB + ecs:RunTask over public AWS APIs, so it needs no NAT (idle
    // cost ~$0). It scales to zero between requests. Referencing the asset's repo+tag
    // (not fromImageAsset) reuses the ONE build the task already uses — no second build.
    const frontDoor = new lambda.DockerImageFunction(this, "FrontDoor", {
      functionName: "agent-os-serverless-router",
      description: "agent-os serverless front door - gate + dispatch a Fargate task-per-run (ADR-0031)",
      code: lambda.DockerImageCode.fromEcr(image.repository, {
        tagOrDigest: image.imageTag,
        cmd: ["bun", "run", "services/agent-runtime/lambda.ts"], // the Runtime API loop
      }),
      architecture: lambda.Architecture.X86_64, // match the x86_64 image asset (native Intel build)
      role: routerRole,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30), // gate + RunTask is quick; the run itself is the task's life
      logGroup,
      environment: {
        REGION: this.region,
        // the substrate seam (dispatch.ts): Fargate task-per-run is the DEFAULT;
        // wiring the AgentCore ARN additionally offers `dispatch: "agentcore"` as a
        // per-run choice on POST /runs (ADR-0042 — an opt-in adapter, chosen in the
        // console, never the silent default). claude-code always rides ECS_CC_*.
        DISPATCH: "runtask",
        ...(props?.agentcore ? { AGENTCORE_RUNTIME_ARN: props.agentcore.runtimeArn } : {}),
        // the RunTask wiring dispatch.ts reads (runTaskConfigFromEnv):
        ECS_CLUSTER: cluster.clusterName,
        ECS_TASK_DEFINITION: taskDef.family,
        ECS_CONTAINER_NAME: "agent-runtime-task",
        ECS_SUBNETS: cdk.Fn.join(",", vpc.publicSubnets.map((s) => s.subnetId)),
        ECS_SECURITY_GROUPS: taskSg.securityGroupId,
        ECS_ASSIGN_PUBLIC_IP: "true", // public subnets, no NAT
        // kind="claude-code" agents dispatch to their own task def (ADR-0033);
        // the sidecar gets RUN_ID too, to resolve its git allowlist (ADR-0034)
        ECS_CC_TASK_DEFINITION: ccTaskDef.family,
        ECS_CC_CONTAINER_NAME: "claude-code-runner",
        ECS_CC_SIDECAR_CONTAINER_NAME: "egress-sidecar",
        // coder workspace credentials (ADR-0046): same App identity as the sidecar;
        // the key stays in SSM and is read at mint time, never baked into env.
        GITHUB_APP_ID: "4232149",
        GITHUB_APP_INSTALLATION_ID: "145860623",
        GITHUB_APP_PRIVATE_KEY_PARAM: "/creance/github-app-private-key",
        // the front door's own adapter bundle: durable stores + offline gate. It does
        // NOT run the loop, so inference/sandbox default and stay unused (no network).
        RUN_STORE: "dynamodb",
        RUNS_TABLE: "agent-os-runs",
        SPEND_STORE: "dynamodb",
        SPEND_TABLE: "agent-os-budgets",
        AGENT_REGISTRY: "dynamodb", // validate the named agent + serve GET /agents from the catalog
        AGENTS_TABLE: "agent-os-agents",
        GATE: "local", // budget admission at the door (ADR-0009/0013)
        // per-tenant runs/period quota for kind=claude-code agents (ADR-0036/0037) — the
        // admission R2-equivalent where dollars are meaningless. Off unless set at deploy
        // (`-c claudeCodeQuota=N`); the dollar budget still governs every other run kind.
        ...(claudeCodeQuota ? { GATE_CLAUDE_CODE_QUOTA: String(claudeCodeQuota) } : {}),
        // authn (ADR-0032): with a Cognito pool wired, verify the console's id token
        // offline against the pool JWKS — human identity, no static tokens. Without
        // one, fall back to the pre-0032 demo tokens injected at deploy via context
        // (`-c gateTokens="tok:tenant:subject,..."`); unset ⇒ every request 401s.
        ...(props?.cognito
          ? { AUTHN: "cognito", COGNITO_ISSUER: props.cognito.issuer, COGNITO_CLIENT_ID: props.cognito.clientId }
          : gateTokens
            ? { GATE_TOKENS: String(gateTokens) }
            : {}),
      },
    });

    // The edge (ADR-0043): the pure OpenAPI contract + custom domain; the raw
    // Function URL is retired (API Gateway invokes the Lambda directly). Auth
    // stays app-layer (ADR-0026); CORS moved into the app (withCors) so the
    // console preflights identically on every substrate.
    if (props?.edge) {
      const edge = new SpecRestApiEdge(this, "Edge", {
        specPath: path.join(__dirname, "..", "..", "..", "services", "agent-runtime", "openapi.yaml"),
        handler: frontDoor,
        domainName: props.edge.domainName,
        hostedZone: props.edge.hostedZone,
        apiName: "agent-os-platform",
      });
      this.frontDoorUrl = edge.url;
    } else {
      // pre-0043 fallback: public Function URL, open at transport, gated at the
      // app layer; CORS now answered by the app itself.
      const fnUrl = frontDoor.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
      this.frontDoorUrl = fnUrl.url;
    }

    // The front door's env contract — wire these into the router (DISPATCH=runtask).
    new cdk.CfnOutput(this, "FrontDoorFunctionName", { value: frontDoor.functionName });
    new cdk.CfnOutput(this, "FrontDoorUrl", { value: this.frontDoorUrl });
    new cdk.CfnOutput(this, "EcsCluster", { value: cluster.clusterName });
    new cdk.CfnOutput(this, "EcsTaskDefinition", { value: taskDef.family });
    new cdk.CfnOutput(this, "EcsContainerName", { value: "agent-runtime-task" });
    new cdk.CfnOutput(this, "EcsSubnets", {
      value: cdk.Fn.join(",", vpc.publicSubnets.map((s) => s.subnetId)),
    });
    new cdk.CfnOutput(this, "EcsSecurityGroups", { value: taskSg.securityGroupId });
    new cdk.CfnOutput(this, "EcsAssignPublicIp", { value: "true" }); // public subnets, no NAT
    new cdk.CfnOutput(this, "RouterRoleArn", { value: routerRole.roleArn });
    new cdk.CfnOutput(this, "TaskRoleArn", { value: taskRole.roleArn });
    new cdk.CfnOutput(this, "ClaudeCodeTaskDefinition", { value: ccTaskDef.family });
    new cdk.CfnOutput(this, "ClaudeCodeTaskRoleArn", { value: ccTaskRole.roleArn });
  }
}
