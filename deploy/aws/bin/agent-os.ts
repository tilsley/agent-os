#!/usr/bin/env bun
/**
 * agent-os CDK app entry point.
 *
 * CDK provisions the cheap, always-on AWS resources (state/spend stores, Bedrock,
 * data/log). The EKS control plane is NOT here — it's owned by eksctl as
 * config-as-code (deploy/eks/cluster.yaml: cluster + VPC + Pod Identity), which is
 * tear-down-friendly and native to keyless identity. Untrusted code execution runs
 * in AWS Bedrock AgentCore (ADR-0006). Run with `bunx cdk synth`.
 */
import * as cdk from "aws-cdk-lib";
import { AgentCoreStack } from "../lib/agentcore-stack";
import { AuthStack } from "../lib/auth-stack";
import { BedrockStack } from "../lib/bedrock-stack";
import { ConsoleStack } from "../lib/console-stack";
import { UsEast1CertStack } from "../lib/us-east-1-cert-stack";
import { GatewayStack } from "../lib/gateway-stack";
import { DataLogStack } from "../lib/data-log-stack";
import { StateStack } from "../lib/state-stack";
import { PostgresStack } from "../lib/postgres-stack";
import { ServerlessStack } from "../lib/serverless-stack";

const app = new cdk.App();

// TODO: derive from context/env per environment (dev/staging/prod).
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "eu-west-2", // matches the rest of agent-os
};

// IMPLEMENTED — deployable now (cheap, no EKS): the remember store + guard/inference.
new StateStack(app, "AgentOsState", { env });
new BedrockStack(app, "AgentOsBedrock", { env });

// IMPLEMENTED, OPTIONAL — the full-mode budget/memory store (ADR-0023/0026/0027):
// Aurora Serverless v2 PostgreSQL scaling to 0 ACUs (~$0 idle). Deploy only for
// full-mode trips (`cdk deploy AgentOsPostgres -c dbAllowedCidr=<ip>/32`); destroy cleans up.
new PostgresStack(app, "AgentOsPostgres", { env });

// The spec-driven custom-domain edge (ADR-0043): both public APIs sit behind
// API Gateway REST APIs generated from their PURE OpenAPI contracts, on
// subdomains of the operator's zone. Context lives in cdk.json (never -c flags).
const hostedZoneId = app.node.tryGetContext("hostedZoneId");
const hostedZoneName = app.node.tryGetContext("hostedZoneName");
const hostedZone = hostedZoneId && hostedZoneName ? { id: String(hostedZoneId), name: String(hostedZoneName) } : undefined;
const edgeFor = (ctxKey: string) => {
  const domainName = app.node.tryGetContext(ctxKey);
  return hostedZone && domainName ? { domainName: String(domainName), hostedZone } : undefined;
};

// IMPLEMENTED — the console's human IdP (ADR-0032): a Cognito user pool whose id
// token is the Bearer credential the front door verifies (AUTHN=cognito). ~$0 idle.
// The hosted UI gets its own custom domain (auth.creance.…) — Cognito fronts it
// with CloudFront, hence another us-east-1 cert. FIRST-ROLLOUT ORDER: the console
// stack must deploy its apex alias before Cognito will accept the custom domain
// (parent must resolve) — see AuthStackProps.edge.
const authEdge = edgeFor("authDomain");
const authCert = authEdge
  ? new UsEast1CertStack(app, "AgentOsAuthCert", {
      env: { account: env.account, region: "us-east-1" },
      crossRegionReferences: true,
      domainName: authEdge.domainName,
      hostedZone: authEdge.hostedZone,
    })
  : undefined;
const auth = new AuthStack(app, "AgentOsAuth", {
  env,
  crossRegionReferences: true,
  ...(authEdge && authCert ? { edge: { ...authEdge, certificate: authCert.certificate } } : {}),
});

// IMPLEMENTED — the inference gateway on the serverless substrate (ADR-0039):
// ADR-0019's choke point as a scale-to-zero Lambda behind the spec edge
// (ADR-0043). Delegated agents (kind=sandboxed/custom) think ONLY through
// this; the loop stays direct.
const gateway = new GatewayStack(app, "AgentOsGateway", {
  env,
  cognito: { issuer: auth.issuer, clientId: auth.clientId },
  edge: edgeFor("inferenceDomain"),
});

// IMPLEMENTED, OPT-IN — the managed profile's loop hosting (ADR-0042 phase 1):
// the SAME agent-runtime image as an AgentCore Runtime, session-per-run microVM,
// active-CPU billing. Opt in via persisted context (cdk.json — never CLI -c flags):
//   "agentcoreProfile": true
// which offers `dispatch: "agentcore"` as a PER-RUN choice on the front door
// (console selector); Fargate stays the default substrate. claude-code always
// rides Fargate, and dropping the flag is a redeploy, not a rebuild.
const agentcoreProfile = !!app.node.tryGetContext("agentcoreProfile");
const agentcore = agentcoreProfile ? new AgentCoreStack(app, "AgentOsAgentCore", { env }) : undefined;

// IMPLEMENTED — the cheap-profile serverless compute substrate (ADR-0031): the
// agent loop as a Fargate task-per-run + a Lambda front door. Reuses AgentOsState's
// tables + AgentOsBedrock's invoke policy. ~$0 idle (no NAT, no ALB, zero tasks at rest).
// The image is a CDK DockerImageAsset, so one command builds + pushes + deploys it all:
//   cdk deploy AgentOsServerless        (needs Docker running — it builds the image)
// The front door authenticates the console's Cognito id token (ADR-0032).
const serverless = new ServerlessStack(app, "AgentOsServerless", {
  env,
  cognito: { issuer: auth.issuer, clientId: auth.clientId },
  agentGatewayUrl: gateway.gatewayUrl, // delegated agents' think-path (ADR-0039)
  ...(agentcore ? { agentcore: { runtimeArn: agentcore.runtimeArn } } : {}),
  edge: edgeFor("apiDomain"), // the platform API's custom domain (ADR-0043)
});

// IMPLEMENTED — the web console (ADR-0032): the built SPA on S3+CloudFront, with
// /config.json written at deploy from the other stacks' outputs. Build first:
//   bun run --cwd apps/console build && cdk deploy AgentOsConsole
// The per-run "trace ↗" link (ADR-0035): where traces land, from persisted context
// (cdk.json — NOT a CLI flag; those silently revert). Unset ⇒ no link rendered.
const grafanaUrl = app.node.tryGetContext("grafanaUrl");
// The console's custom domain (ADR-0043 pattern on the UI): CloudFront only takes
// us-east-1 certs, so the cert is its own stack there and the ARN crosses regions
// via crossRegionReferences (both sides must opt in). The bare apex (rootDomain)
// rides on the same cert + distribution — the canonical-host function 301s it to
// the console, and its A record satisfies Cognito's parent-must-resolve rule.
const consoleEdge = edgeFor("consoleDomain");
const rootDomain = app.node.tryGetContext("rootDomain");
const additionalDomains = rootDomain ? [String(rootDomain)] : undefined;
const consoleCert = consoleEdge
  ? new UsEast1CertStack(app, "AgentOsConsoleCert", {
      env: { account: env.account, region: "us-east-1" },
      crossRegionReferences: true,
      domainName: consoleEdge.domainName,
      hostedZone: consoleEdge.hostedZone,
      subjectAlternativeNames: additionalDomains,
    })
  : undefined;
new ConsoleStack(app, "AgentOsConsole", {
  env,
  crossRegionReferences: true,
  ...(consoleEdge && consoleCert
    ? { edge: { ...consoleEdge, certificate: consoleCert.certificate, additionalDomains } }
    : {}),
  apiUrl: serverless.frontDoorUrl,
  auth: { hostedUiBaseUrl: auth.hostedUiBaseUrl, clientId: auth.clientId },
  ...(grafanaUrl
    ? {
        grafana: {
          url: String(grafanaUrl),
          tracesDatasourceUid: String(app.node.tryGetContext("grafanaTracesDatasourceUid") ?? "grafanacloud-traces"),
        },
      }
    : {}),
});

// SKELETON — the data/log plane, not yet implemented.
// (The EKS cluster + VPC are owned by eksctl, not CDK — see deploy/eks/cluster.yaml.)
new DataLogStack(app, "AgentOsDataLog", { env });

app.synth();
