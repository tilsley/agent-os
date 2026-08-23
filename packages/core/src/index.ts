/**
 * @agent-os/core — the platform runtime.
 *
 * Ports (contracts) + the L1 agent loop + adapters. Consumed by examples and
 * (soon) the real services, so there's one contract, not a copy per app.
 */
export * from "./ports";
export * from "./loop";
export * from "./sandboxed-agent"; // sandboxed-agent kind (ADR-0019, Model B)
export * from "./config";
export * from "./tools";
export * from "./tool-gateway"; // #4: assemble per-run toolset from sources
export * from "./http"; // withCors — app-owned CORS across all substrates (ADR-0043)
export * from "./runs"; // State primitive (remember): persisted runs
export * from "./agents"; // #5: agent control plane — the registry data model
export * from "./gate"; // gate control: identity + budget
export * from "./credentials"; // gate control: downstream credential broker

// think
export * from "./adapters/bedrock-inference";
export * from "./adapters/ollama-inference";
export * from "./adapters/scripted-inference"; // deterministic demo/test driver (ADR-0017)
export * from "./adapters/admission-inference"; // cost hard-stop decorator (ADR-0013)
export * from "./adapters/gateway-inference"; // inference-gateway client (ADR-0019)
// do
export * from "./adapters/agentcore-sandbox";
export * from "./adapters/e2b-sandbox";
export * from "./adapters/local-sandbox";
export * from "./adapters/gcp-secrets"; // GCP Secret Manager resolver — secret refs at boot (ADR-0047)
// guard
export * from "./adapters/bedrock-guard";
export * from "./adapters/noop-guard";
// gate: budget governance
export * from "./adapters/local-gate";
export * from "./adapters/noop-gate";
// authn (ADR-0015): who is the caller — swappable per stack
export * from "./adapters/static-token-authenticator";
export * from "./adapters/mesh-trust-authenticator";
export * from "./adapters/mesh-identity-authenticator"; // full-mode workload authn — Linkerd/Istio stamped identity (ADR-0028)
export * from "./adapters/cognito-jwt-authenticator"; // verified human identity — OIDC user pool JWT (ADR-0032)
export * from "./adapters/cognito-m2m-authenticator"; // verified machine identity — client_credentials access token (ADR-0041)
export * from "./adapters/gcp-oidc-authenticator"; // verified machine identity on GCP — Google SA OIDC ID token (ADR-0044)
export * from "./adapters/composite-authenticator"; // first-match-wins across credential kinds (ADR-0041)
export * from "./adapters/noop-authenticator";
// authz (ADR-0015): allow/deny policy seam
export * from "./adapters/allow-all-authorizer";
export * from "./adapters/opa-authorizer";
export * from "./claims"; // ClaimSource port — inference grant is policy, not provisioning (ADR-0021)
export * from "./adapters/kube-claim-source"; // unified claim reader: budget cap + SA→tenant (ADR-0021)
export * from "./adapters/dynamo-claim-source"; // the non-k8s ClaimSource — grants in DynamoDB (ADR-0021)
export * from "./adapters/static-claim-source"; // dev/test ClaimSource from CLAIMS_STATIC (mirror of the LiteLLM hook's)
export * from "./adapters/dynamo-spend-store"; // durable monthly spend counter (ADR-0013)
export * from "./adapters/firestore-spend-store"; // shared monthly spend counter for the GCP split (ADR-0044 4b)
export * from "./adapters/postgres-spend-store"; // full-mode ACID budget reserve — one conditional UPDATE (ADR-0023/0026/0028)
export * from "./adapters/sts-tenant-credentials"; // per-tenant assume-role identity (ADR-0014)
export * from "./adapters/local-credential-broker";
export * from "./adapters/noop-credential-broker";
export * from "./adapters/obo-token-vault-broker"; // on-behalf-of token exchange (ADR-0010)
// tools (#4): MCP gateway
export * from "./adapters/mcp-tool-provider";
export * from "./adapters/gateway-tool-provider"; // centralized tool-gateway client (ADR-0011 dir. b, 0029)
// remember: semantic memory (ADR-0030) — the port + files-first (keyword) and vector (Bedrock) adapters
export * from "./memory";
export * from "./adapters/files-memory";
export * from "./adapters/bedrock-embeddings";
export * from "./adapters/vector-memory";
export * from "./adapters/vertex-memory-bank"; // GCP managed memory — Vertex Agent Engine Memory Bank (ADR-0044 phase 5)
export * from "./adapters/gcp-session-recorder"; // GCP console visibility — mirror runs into Vertex Sessions (ADR-0044 phase 5b)
// remember: durable run store
export * from "./adapters/dynamodb-run-store";
export * from "./adapters/firestore-run-store"; // GCP managed profile: shared store for the DISPATCH=agentengine split
// #5: agent control plane — CRD-backed registry (full mode) + DynamoDB registry (cheap mode)
export * from "./adapters/kube-agent-registry";
export * from "./adapters/dynamo-agent-registry"; // register agents with a PutItem, no redeploy (ADR-0031)
// record
export * from "./adapters/console-telemetry";
export * from "./adapters/otel-telemetry";
