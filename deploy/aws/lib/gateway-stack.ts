import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { SpecRestApiEdge } from "./spec-rest-api";

export interface GatewayStackProps extends cdk.StackProps {
  /** Caller authn (ADR-0032/0039): delegated agents present the run's forwarded
   *  Cognito id token; the gateway verifies it against the pool. */
  cognito: { issuer: string; clientId: string };
  /** The spec-driven custom-domain edge (ADR-0043). Unset ⇒ fall back to the
   *  bare Function URL (the pre-0043 posture, kept for context-less synth). */
  edge?: { domainName: string; hostedZone: { id: string; name: string } };
}

/**
 * GatewayStack — the inference gateway on the serverless substrate (ADR-0039):
 * ADR-0019's identity-bound choke point as a scale-to-zero Lambda + Function URL,
 * packaged exactly like the front door (ADR-0031: container image, native Runtime
 * API loop, no HTTP server).
 *
 * Who calls it: DELEGATED agents (kind=sandboxed/custom) — their only sanctioned
 * model egress. The loop's own think stays direct-Bedrock (0031); routing it here
 * too is the documented one-env-var graduation, not this stack's concern.
 *
 * What the role holds is the point: Bedrock invoke (the scoped shared policy) and
 * the budgets ledger — model credentials and the meter live HERE, so the caller
 * can hold nothing and still think. R1 = the verified run token; R2 = reserve →
 * invoke → settle against the SAME agent-os-budgets table the loop meters into.
 */
export class GatewayStack extends cdk.Stack {
  /** The choke point's address — what the executor hands delegated agents (AGENT_GATEWAY_URL). */
  readonly gatewayUrl: string;

  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    // Same build-context shape as the runtime image (repo root; the Dockerfile
    // COPYs the workspace). One image, two entrypoints: server.ts (pod) / lambda.ts.
    const image = new ecrAssets.DockerImageAsset(this, "Image", {
      directory: path.join(__dirname, "..", "..", ".."),
      file: "services/inference-gateway/Dockerfile",
      platform: ecrAssets.Platform.LINUX_AMD64,
    });

    const budgets = dynamodb.Table.fromTableName(this, "BudgetsTable", "agent-os-budgets");

    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: "/agent-os/gateway",
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, "Role", {
      roleName: "agent-os-gateway",
      description: "agent-os inference gateway - Bedrock invoke + budgets ledger (ADR-0039)",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    budgets.grantReadWriteData(role); // R2: reserve → settle on the shared ledger
    role.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyName(this, "BedrockInvoke", "agent-os-bedrock-invoke"));
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"));

    const fn = new lambda.DockerImageFunction(this, "Gateway", {
      functionName: "agent-os-gateway",
      description: "agent-os inference gateway - governed think for delegated agents (ADR-0039)",
      code: lambda.DockerImageCode.fromEcr(image.repository, {
        tagOrDigest: image.imageTag,
        cmd: ["bun", "run", "services/inference-gateway/lambda.ts"], // the Runtime API loop
      }),
      architecture: lambda.Architecture.X86_64,
      role,
      memorySize: 512,
      timeout: cdk.Duration.seconds(120), // one generate turn, not a loop
      logGroup,
      environment: {
        REGION: this.region,
        // R1: verify the delegated agent's forwarded run token (ADR-0032 adapter)
        AUTHN: "cognito",
        COGNITO_ISSUER: props.cognito.issuer,
        COGNITO_CLIENT_ID: props.cognito.clientId,
        // R2: durable admission on the shared ledger (reserve → invoke → settle)
        GATE: "local",
        SPEND_STORE: "dynamodb",
        SPEND_TABLE: "agent-os-budgets",
        // model routing: request model / MODEL_ID fallback; per-claim routing joins
        // when a serverless claims table exists (ADR-0039 open)
        INFERENCE_PROVIDER: "bedrock",
        MODEL_ID: "amazon.nova-lite-v1:0",
        // friendly model names → Bedrock ids (ADR-0028 app.ts). "claude-haiku" is the
        // Anthropic-wire model for delegated agents; it resolves to the `eu.` cross-region
        // inference profile (grant lives in agent-os-bedrock-invoke, region-wildcard).
        MODEL_ALIASES: JSON.stringify({ "claude-haiku": "eu.anthropic.claude-haiku-4-5-20251001-v1:0" }),
        // this process IS the gateway — never set INFERENCE_GATEWAY_URL here
      },
    });

    // The edge (ADR-0043): the pure OpenAPI contract + custom domain, with the
    // raw Function URL retired — API Gateway invokes the Lambda directly, so no
    // public URL exists besides the domain. Auth stays app-layer (ADR-0026);
    // the edge validates shape and owns TLS/DNS.
    if (props.edge) {
      const edge = new SpecRestApiEdge(this, "Edge", {
        specPath: path.join(__dirname, "..", "..", "..", "services", "inference-gateway", "openapi.yaml"),
        handler: fn,
        domainName: props.edge.domainName,
        hostedZone: props.edge.hostedZone,
        apiName: "agent-os-inference",
      });
      this.gatewayUrl = edge.url;
    } else {
      // pre-0043 fallback: open at transport, gated at the app layer (ADR-0031)
      const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
      this.gatewayUrl = fnUrl.url;
    }

    new cdk.CfnOutput(this, "GatewayUrl", { value: this.gatewayUrl });
  }
}
