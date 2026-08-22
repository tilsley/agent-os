/**
 * The ports/adapters seam as config (ADR-0003): build the four building blocks
 * from environment variables. Shared by the example CLI and the services so
 * there's one wiring, not a copy per consumer.
 *
 * Call ONCE per process — the OTel telemetry sink registers a global provider.
 */
import { BedrockInferenceProvider } from "./adapters/bedrock-inference";
import { VertexGeminiInferenceProvider } from "./adapters/vertex-gemini-inference";
import { OllamaInferenceProvider } from "./adapters/ollama-inference";
import { ScriptedInferenceProvider } from "./adapters/scripted-inference";
import { AdmissionInferenceProvider } from "./adapters/admission-inference";
import { GatewayInferenceProvider } from "./adapters/gateway-inference";
import { OpenAIGatewayInferenceProvider } from "./adapters/openai-gateway-inference";
import { AgentCoreSandboxProvider } from "./adapters/agentcore-sandbox";
import { E2BSandboxProvider } from "./adapters/e2b-sandbox";
import { AgentSandboxProvider } from "./adapters/agent-sandbox";
import { LocalSandboxProvider } from "./adapters/local-sandbox";
import { BedrockContentGuard } from "./adapters/bedrock-guard";
import { NoopContentGuard } from "./adapters/noop-guard";
import { ConsoleTelemetrySink } from "./adapters/console-telemetry";
import { OtelTelemetrySink } from "./adapters/otel-telemetry";
import { LocalGate } from "./adapters/local-gate";
import { NoopGate } from "./adapters/noop-gate";
import { StaticTokenAuthenticator } from "./adapters/static-token-authenticator";
import { MeshTrustAuthenticator } from "./adapters/mesh-trust-authenticator";
import { MeshIdentityAuthenticator } from "./adapters/mesh-identity-authenticator";
import { OidcServiceAccountAuthenticator, KubeTokenReviewer } from "./adapters/oidc-sa-authenticator";
import { CognitoJwtAuthenticator } from "./adapters/cognito-jwt-authenticator";
import { CognitoM2mAuthenticator } from "./adapters/cognito-m2m-authenticator";
import { GcpOidcAuthenticator } from "./adapters/gcp-oidc-authenticator";
import { CompositeAuthenticator } from "./adapters/composite-authenticator";
import { NoopAuthenticator } from "./adapters/noop-authenticator";
import { AllowAllAuthorizer } from "./adapters/allow-all-authorizer";
import { OpaAuthorizer } from "./adapters/opa-authorizer";
import { KubeClaimSource } from "./adapters/kube-claim-source";
import { DynamoClaimSource } from "./adapters/dynamo-claim-source";
import { StaticClaimSource } from "./adapters/static-claim-source";
import type { ClaimSource, ClaimWrite } from "./claims";
import { DynamoSpendStore } from "./adapters/dynamo-spend-store";
import { FirestoreSpendStore } from "./adapters/firestore-spend-store";
import { PostgresSpendStore } from "./adapters/postgres-spend-store";
import { InMemorySpendStore, type SpendStore } from "./gate";
import { KubeStsTenantCredentials, type TenantCredentials } from "./adapters/sts-tenant-credentials";
import { LocalCredentialBroker } from "./adapters/local-credential-broker";
import { NoopCredentialBroker } from "./adapters/noop-credential-broker";
import { OboTokenVaultBroker } from "./adapters/obo-token-vault-broker";
import { McpToolProvider, type McpServers } from "./adapters/mcp-tool-provider";
import { GatewayToolProvider } from "./adapters/gateway-tool-provider";
import { BuiltinToolProvider, CompositeToolProvider, type ToolProvider } from "./tool-gateway";
import { DynamoDBRunStore } from "./adapters/dynamodb-run-store";
import { FirestoreRunStore } from "./adapters/firestore-run-store";
import { InMemoryRunStore, type RunStore } from "./runs";
import { InMemoryAgentRegistry, type AgentRegistry, type AgentSpec } from "./agents";
import { KubeAgentRegistry } from "./adapters/kube-agent-registry";
import { DynamoAgentRegistry } from "./adapters/dynamo-agent-registry";
import { FilesMemory } from "./adapters/files-memory";
import { VectorMemory } from "./adapters/vector-memory";
import { AgentCoreMemory } from "./adapters/agentcore-memory";
import { VertexMemoryBank } from "./adapters/vertex-memory-bank";
import { GcpSessionRecorder, type SessionRecorder } from "./adapters/gcp-session-recorder";
import { BedrockEmbeddings } from "./adapters/bedrock-embeddings";
import type { MemoryAdapter } from "./memory";
import type { InferenceProvider, SandboxProvider, ContentGuard, TelemetrySink } from "./ports";
import type { Gate, Authenticator, Authorizer } from "./gate";
import type { CredentialBroker } from "./credentials";

export interface Providers {
  inference: InferenceProvider;
  sandbox: SandboxProvider;
  guard: ContentGuard;
  telemetry: TelemetrySink;
  gate: Gate;
  /** authn (who is the caller) — ADR-0015, swappable per stack. */
  authenticator: Authenticator;
  /** authz (may they do this) — ADR-0015; AllowAll today, OPA next. */
  authorizer: Authorizer;
  credentials: CredentialBroker;
  toolProvider: ToolProvider;
  runStore: RunStore;
  agentRegistry: AgentRegistry;
  /** Inference provider scoped to a tenant's assumed role (ADR-0014), or the shared
   *  provider when per-tenant identity is off / the role isn't provisioned yet. */
  inferenceForTenant: (tenant: string, token?: string, scopeId?: string, model?: string) => Promise<InferenceProvider>;
  /** The claim reader (ADR-0021), when configured — lets the gateway route per-claim model. */
  claimSource?: ClaimSource;
  /** Self-service write deps for `POST /claims` (tenant = identity, 1:1), when the dynamo write
   *  path + an identity verifier are configured. */
  claimWrite?: ClaimWrite;
  /** Per-tenant assume-role AWS creds (ADR-0014), when TENANT_ASSUME_ROLE is on — lets the
   *  gateway's passthrough wire (ADR-0028) scope its Bedrock client to the tenant's role. */
  tenantCredentials?: TenantCredentials;
  /** Durable per-tenant long-term memory (ADR-0030), when AGENT_MEMORY_DIR is set; undefined
   *  disables it (the runtime then injects no memory and offers no `remember` tools). */
  memory?: MemoryAdapter;
  /** GCP-only observer (ADR-0044 phase 5b): mirrors a finished run into a Vertex Agent Engine
   *  Session so it surfaces in the console. Off unless GCP_SESSION_ENGINE_ID is set. */
  sessionRecorder?: SessionRecorder;
}

type Env = Record<string, string | undefined>;

export function providersFromEnv(env: Env = process.env): Providers {
  const region = env.REGION ?? "eu-west-2";

  const inferenceKind = env.INFERENCE_PROVIDER ?? "bedrock";
  const inference: InferenceProvider = (() => {
    switch (inferenceKind) {
      case "bedrock":
        return new BedrockInferenceProvider(env.MODEL_ID ?? "amazon.nova-lite-v1:0", region);
      case "vertex": {
        // GCP-native model path (Agent Runtime profile). Project from the standard
        // GOOGLE_CLOUD_PROJECT (Vertex injects it) or GCP_PROJECT; ADC auth, so no key.
        const project = env.GOOGLE_CLOUD_PROJECT ?? env.GCP_PROJECT;
        if (!project) throw new Error("INFERENCE_PROVIDER=vertex requires GOOGLE_CLOUD_PROJECT (or GCP_PROJECT)");
        return new VertexGeminiInferenceProvider(
          env.VERTEX_MODEL ?? "gemini-2.5-flash",
          project,
          env.GCP_LOCATION ?? "europe-west2",
          env.VERTEX_THINKING_BUDGET ? Number(env.VERTEX_THINKING_BUDGET) : 0,
        );
      }
      case "ollama":
        return new OllamaInferenceProvider(env.OLLAMA_MODEL ?? "llama3.1", env.OLLAMA_HOST);
      case "scripted": // deterministic demo/test driver (ADR-0017 A2A); SCRIPTED_TURNS = JSON
        return new ScriptedInferenceProvider(env.SCRIPTED_TURNS ? JSON.parse(env.SCRIPTED_TURNS) : []);
      default:
        throw new Error(`unknown INFERENCE_PROVIDER: ${env.INFERENCE_PROVIDER}`);
    }
  })();

  const sandbox: SandboxProvider = (() => {
    switch (env.SANDBOX_PROVIDER ?? "agentcore") {
      case "agentcore":
        return new AgentCoreSandboxProvider(
          env.CODE_INTERPRETER_ID ?? "aws.codeinterpreter.v1",
          region,
          env.AGENTCORE_ENDPOINT,
        );
      case "e2b": // remote Firecracker microVM per session (ADR-0019); needs E2B_API_KEY
        return new E2BSandboxProvider({ apiKey: env.E2B_API_KEY, template: env.E2B_TEMPLATE });
      case "agent-sandbox":
        // in-cluster pod-per-session via kubernetes-sigs/agent-sandbox (prototype closing
        // ADR-0003's "K8s adapter -> k3s" gap). AGENT_SANDBOX_API_SERVER_URL (a `kubectl
        // proxy` URL) lets an off-cluster process reach local k3s around Bun's client-cert
        // mTLS gap (ADR-0012); in-cluster callers leave it unset.
        return new AgentSandboxProvider({
          namespace: env.AGENT_SANDBOX_NAMESPACE,
          image: env.AGENT_SANDBOX_IMAGE,
          apiServerUrl: env.AGENT_SANDBOX_API_SERVER_URL,
          startupTimeoutMs: env.AGENT_SANDBOX_STARTUP_TIMEOUT_MS ? Number(env.AGENT_SANDBOX_STARTUP_TIMEOUT_MS) : undefined,
        });
      case "local":
        return new LocalSandboxProvider(); // ⚠ DEMO ONLY — runs code on host, no isolation
      default:
        throw new Error(`unknown SANDBOX_PROVIDER: ${env.SANDBOX_PROVIDER}`);
    }
  })();

  const guard: ContentGuard = env.GUARDRAIL_ID
    ? new BedrockContentGuard(env.GUARDRAIL_ID, env.GUARDRAIL_VERSION ?? "DRAFT", region)
    : new NoopContentGuard();

  // remember (ADR-0030): durable, per-tenant long-term memory, files-first. Enabled by AGENT_MEMORY_DIR
  // (a durable mount in-cluster; a host dir locally) — unset disables it. MEMORY_RETRIEVAL=keyword
  // (cheap default) or =vector (Bedrock Titan embeddings, semantic recall). Writes are screened by the
  // SAME guard as the loop (ADR-0008), since a remembered note re-enters future sessions.
  // AGENTCORE_MEMORY_ID selects the AWS managed backend (ADR-0042 phase 2): AgentCore Memory
  // with per-tenant namespaces enforceable by IAM. MEMORY_BANK_ENGINE_ID selects the GCP managed
  // backend (ADR-0044 phase 5): Vertex AI Agent Engine Memory Bank under a reasoningEngine parent,
  // per-tenant isolation by the immutable `scope` map — one more adapter behind the same port.
  const memory: MemoryAdapter | undefined = (() => {
    if (env.MEMORY_BANK_ENGINE_ID) {
      const project = env.GCP_PROJECT ?? env.GOOGLE_CLOUD_PROJECT;
      if (!project) throw new Error("MEMORY_BANK_ENGINE_ID requires GCP_PROJECT (the project ID)");
      return new VertexMemoryBank(project, env.GCP_LOCATION ?? "europe-west2", env.MEMORY_BANK_ENGINE_ID, guard);
    }
    if (env.AGENTCORE_MEMORY_ID) return new AgentCoreMemory(env.AGENTCORE_MEMORY_ID, guard, region);
    if (!env.AGENT_MEMORY_DIR) return undefined;
    return (env.MEMORY_RETRIEVAL ?? "keyword") === "vector"
      ? new VectorMemory(env.AGENT_MEMORY_DIR, new BedrockEmbeddings(undefined, region), guard)
      : new FilesMemory(env.AGENT_MEMORY_DIR, guard);
  })();

  // console visibility (ADR-0044 phase 5b): GCP_SESSION_ENGINE_ID names the reasoningEngine
  // whose console should show our runs — the engine mirrors each finished run into a managed
  // Vertex Session (best-effort observer, off the run's critical path). Unset ⇒ no mirroring.
  const sessionRecorder: SessionRecorder | undefined = (() => {
    if (!env.GCP_SESSION_ENGINE_ID) return undefined;
    const project = env.GCP_PROJECT ?? env.GOOGLE_CLOUD_PROJECT;
    if (!project) throw new Error("GCP_SESSION_ENGINE_ID requires GCP_PROJECT (the project ID)");
    return new GcpSessionRecorder(project, env.GCP_LOCATION ?? "europe-west2", env.GCP_SESSION_ENGINE_ID);
  })();

  const telemetry: TelemetrySink = (() => {
    switch (env.TELEMETRY ?? "console") {
      case "console":
        return new ConsoleTelemetrySink();
      case "otel":
        return new OtelTelemetrySink();
      default:
        throw new Error(`unknown TELEMETRY: ${env.TELEMETRY}`);
    }
  })();

  // gate defaults to open (noop) so direct loop consumers are unaffected; the
  // runtime opts into token auth + budget via GATE=local (ADR-0009). With
  // GATE_BUDGET_SOURCE=kube the per-tenant cap is read from each TenantInferenceProfile
  // claim's monthlyBudgetUsd (ADR-0013); GATE_BUDGET_USD is then the fallback default.
  // SPEND_STORE=dynamodb makes the monthly spend counter durable (survives restarts);
  // SPEND_TABLE_ENDPOINT → DynamoDB Local. Defaults to in-memory (lost on restart).
  // TENANT_CLAIM_* overrides the CRD the SA->tenant binding + cap are read from — e.g. a
  // standalone binding CRD where the canonical TenantInferenceProfile is Crossplane-owned
  // (and would otherwise try to provision). Defaults to the TenantInferenceProfile claim.
  const claimCrd = env.TENANT_CLAIM_PLURAL
    ? {
        group: env.TENANT_CLAIM_GROUP,
        version: env.TENANT_CLAIM_VERSION,
        plural: env.TENANT_CLAIM_PLURAL,
        scope: env.TENANT_CLAIM_SCOPE === "Namespaced" ? ("Namespaced" as const) : ("Cluster" as const),
      }
    : undefined;
  // ONE claim reader (ADR-0021) serves both the gate's budget cap and the authn SA→tenant
  // resolver — built only when something needs it (kube budget source or oidc-sa authn).
  // CLAIM_SOURCE picks where grants are read from (ADR-0021): kube (CRD, default) or dynamo (a
  // table, for non-k8s tenants — next to the spend counter). Built only when something needs it.
  // CLAIM_SOURCE=static (CLAIMS_STATIC env map, no k8s/AWS) is an explicit opt-in, so it
  // always builds — it exists precisely for runs where nothing else would need claims.
  // mesh-id authn resolves tenant from the claim binding too (ADR-0028), so it needs claims.
  const needClaims =
    env.GATE_BUDGET_SOURCE === "kube" || env.AUTHN === "oidc-sa" || env.AUTHN === "mesh-id" || env.CLAIM_SOURCE === "static";
  const claimSource = !needClaims
    ? undefined
    : env.CLAIM_SOURCE === "dynamo"
      ? new DynamoClaimSource(env.CLAIMS_TABLE ?? "agent-os-claims", { region, endpoint: env.CLAIMS_TABLE_ENDPOINT })
      : env.CLAIM_SOURCE === "static"
        ? new StaticClaimSource(env.CLAIMS_STATIC)
        : new KubeClaimSource(claimCrd);
  const budgetSource = env.GATE_BUDGET_SOURCE === "kube" ? claimSource : undefined;
  // identity verifier (shared by oidc-sa authn + the POST /claims write): TokenReview the SA token.
  const reviewer = env.AUTHN === "oidc-sa" ? new KubeTokenReviewer(env.OIDC_SA_AUDIENCE) : undefined;
  // self-service write (ADR-0021, tenant=identity 1:1): enabled for the dynamo claim store when an
  // identity verifier + a default allowance (CLAIMS_DEFAULT_MAX_USD) are present.
  const claimWrite: ClaimWrite | undefined =
    env.CLAIM_SOURCE === "dynamo" && reviewer && env.CLAIMS_DEFAULT_MAX_USD && claimSource instanceof DynamoClaimSource
      ? {
          verifyIdentity: async (token) => {
            const r = await reviewer.review(token);
            return r.authenticated && r.username?.startsWith("system:serviceaccount:") ? r.username : undefined;
          },
          allowance: {
            maxMonthlyUsd: Number(env.CLAIMS_DEFAULT_MAX_USD),
            allowedModels: (env.CLAIMS_ALLOWED_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
          },
          putClaim: (claim) => (claimSource as DynamoClaimSource).putClaim(claim),
        }
      : undefined;
  // SPEND_STORE: memory (dev, lost on restart) · dynamodb (cheap mode, ~$0 idle) ·
  // postgres (full mode — ACID conditional-UPDATE reserve, ADR-0023/0026/0028).
  const spendStore: SpendStore = (() => {
    switch (env.SPEND_STORE ?? "memory") {
      case "dynamodb":
        return new DynamoSpendStore(env.SPEND_TABLE ?? "agent-os-budgets", region, env.SPEND_TABLE_ENDPOINT);
      case "firestore": {
        // GCP managed profile (ADR-0044 4b): the front door and the engine run in
        // different processes, so per-tenant spend must live in ONE Firestore ledger both
        // see. Same project-ID caveat as the run store (a project NUMBER 404s).
        const project = env.GCP_PROJECT ?? env.GOOGLE_CLOUD_PROJECT;
        if (!project) throw new Error("SPEND_STORE=firestore requires GCP_PROJECT (the project ID; a project number will not resolve)");
        return new FirestoreSpendStore(project, {
          database: env.FIRESTORE_DATABASE,
          collection: env.FIRESTORE_BUDGETS_COLLECTION,
          endpoint: env.FIRESTORE_ENDPOINT,
        });
      }
      case "postgres":
        if (!env.SPEND_DATABASE_URL) throw new Error("SPEND_STORE=postgres requires SPEND_DATABASE_URL");
        return new PostgresSpendStore(env.SPEND_DATABASE_URL);
      default:
        return new InMemorySpendStore();
    }
  })();
  // GATE_SESSION_BUDGET_USD adds a per-session cap alongside the monthly one — the
  // runaway-session stop (ADR-0019). Unset ⇒ only the tenant/month cap is enforced.
  const sessionLimitUsd = env.GATE_SESSION_BUDGET_USD ? Number(env.GATE_SESSION_BUDGET_USD) : undefined;
  // GATE_CLAUDE_CODE_QUOTA caps runs/period for subscription/foreign-L1 agents (ADR-0036/0037) —
  // the admission R2-equivalent where dollars are meaningless. Unset ⇒ quota off.
  const runQuota = env.GATE_CLAUDE_CODE_QUOTA ? Number(env.GATE_CLAUDE_CODE_QUOTA) : undefined;
  const gate: Gate =
    (env.GATE ?? "noop") === "local"
      ? new LocalGate(env.GATE_BUDGET_USD, { source: budgetSource, spendStore, sessionLimitUsd, runQuota })
      : new NoopGate();

  // authn (ADR-0015): AUTHN picks the identity adapter. Default tracks the old
  // behaviour — token auth under GATE=local, open otherwise — so existing wiring is
  // unchanged; AUTHN=mesh trusts edge-verified claims (Istio/IAP), simulated locally.
  const authnKind = env.AUTHN ?? ((env.GATE ?? "noop") === "local" ? "token" : "noop");
  const authenticator: Authenticator = (() => {
    switch (authnKind) {
      case "token":
        return new StaticTokenAuthenticator(env.GATE_TOKENS);
      case "mesh":
        return new MeshTrustAuthenticator({
          header: env.MESH_IDENTITY_HEADER,
          tenantClaim: env.MESH_TENANT_CLAIM,
          groupsClaim: env.MESH_GROUPS_CLAIM,
        });
      case "mesh-id":
        // full-mode workload authn (ADR-0028): the mesh's inbound proxy stamps the
        // caller's mTLS-verified identity (Linkerd l5d-client-id / Istio XFCC —
        // MESH_IDENTITY_HEADER picks, unset = auto); tenant from the claim binding.
        return new MeshIdentityAuthenticator({ header: env.MESH_IDENTITY_HEADER, resolver: claimSource });
      case "oidc-sa":
        // verified workload identity (ADR-0019): TokenReview-validate the caller's
        // ServiceAccount token; tenant comes from the SA→claim binding, not the token.
        return new OidcServiceAccountAuthenticator({ audience: env.OIDC_SA_AUDIENCE, resolver: claimSource, reviewer });
      case "cognito": {
        // verified identity from one pool, two credential kinds (ADR-0032 + 0041):
        // humans present the console's id token (tenant from custom:tenant); machines
        // present a client_credentials ACCESS token (tenant from a resource-server
        // scope grant). Composite: first authenticator that recognizes the credential
        // wins; both fail closed without a tenant grant.
        if (!env.COGNITO_ISSUER || !env.COGNITO_CLIENT_ID)
          throw new Error("AUTHN=cognito requires COGNITO_ISSUER and COGNITO_CLIENT_ID");
        return new CompositeAuthenticator([
          new CognitoJwtAuthenticator({
            issuer: env.COGNITO_ISSUER,
            clientId: env.COGNITO_CLIENT_ID,
            tenantClaim: env.COGNITO_TENANT_CLAIM,
          }),
          new CognitoM2mAuthenticator({
            issuer: env.COGNITO_ISSUER,
            tenantScopePrefix: env.COGNITO_M2M_TENANT_SCOPE_PREFIX,
          }),
        ]);
      }
      case "gcp-oidc": {
        // verified machine identity on GCP (ADR-0044, the GCP sibling of 0041's Cognito
        // M2M): a service account presents a Google-signed OIDC ID token; subject = its
        // verified email, tenant = an external SA→tenant grant (ID tokens can't carry a
        // Cognito-scope analog). GCP_OIDC_AUDIENCE is the audience the caller must mint
        // the token for (the front door's identifier); GCP_SA_TENANT_GRANTS is the
        // JSON {email: tenant} binding map — adding an entry IS tenant onboarding.
        if (!env.GCP_OIDC_AUDIENCE) throw new Error("AUTHN=gcp-oidc requires GCP_OIDC_AUDIENCE");
        return new GcpOidcAuthenticator({
          audience: env.GCP_OIDC_AUDIENCE,
          grants: env.GCP_SA_TENANT_GRANTS ? (JSON.parse(env.GCP_SA_TENANT_GRANTS) as Record<string, string>) : {},
          allowedEmailDomains: env.GCP_OIDC_ALLOWED_EMAIL_DOMAINS
            ? env.GCP_OIDC_ALLOWED_EMAIL_DOMAINS.split(",").map((s) => s.trim()).filter(Boolean)
            : undefined,
          issuer: env.GCP_OIDC_ISSUER,
        });
      }
      case "noop":
        return new NoopAuthenticator();
      default:
        throw new Error(`unknown AUTHN: ${env.AUTHN}`);
    }
  })();

  // authz (ADR-0015): allow/deny policy seam. AUTHZ=opa delegates to an OPA instance
  // (the user's org model — policy in Rego, owned per service); default AllowAll stub.
  const authorizer: Authorizer =
    env.AUTHZ === "opa"
      ? new OpaAuthorizer(env.OPA_URL ?? "http://localhost:8181/v1/data/agentos/authz")
      : new AllowAllAuthorizer();

  // per-tenant workload identity (ADR-0014): TENANT_ASSUME_ROLE=kube makes the runtime
  // assume each tenant's IAM role (agentos-<tenant>, ARN from the claim) per run, so
  // calls act AS the tenant. Bedrock-only (it's the AWS-cred injection point); other
  // providers ignore it and use the shared instance.
  const tenantCredentials: TenantCredentials | undefined =
    env.TENANT_ASSUME_ROLE === "kube" && inferenceKind === "bedrock"
      ? new KubeStsTenantCredentials(region)
      : undefined;
  // INFERENCE_GATEWAY_URL set ⇒ this process is a gateway CLIENT: forward generate over
  // HTTP to the standalone gateway (ADR-0019). It then holds no model creds and does no
  // local budget admission — the gateway enforces both. Unset ⇒ DIRECT: assume the
  // tenant's role, call Bedrock, and wrap with the worst-case budget admission here
  // (ADR-0013), so admission always runs wherever the *real* model call happens.
  const gatewayUrl = env.INFERENCE_GATEWAY_URL;
  // Which wire the gateway speaks: "bespoke" = the Bun /v1/generate gateway (default,
  // back-compat / cheap mode); "openai" = an OpenAI-compatible gateway like LiteLLM
  // (full mode, ADR-0024/0026). Both sit behind the same InferenceProvider port.
  const gatewayWire = env.INFERENCE_GATEWAY_WIRE ?? "bespoke";
  const inferenceForTenant = async (tenant: string, token?: string, scopeId?: string, model?: string): Promise<InferenceProvider> => {
    if (gatewayUrl) {
      const clientOpts = { token, tenant, sessionId: scopeId };
      // openai/LiteLLM: the client names the model (LiteLLM routes by alias + enforces the
      // claim's allow-list). bespoke/Bun: the gateway resolves the claim's model server-side.
      return gatewayWire === "openai"
        ? new OpenAIGatewayInferenceProvider(gatewayUrl, model ?? inference.model, clientOpts)
        : new GatewayInferenceProvider(gatewayUrl, inference.model, clientOpts);
    }
    // direct: route to the claim's model (ADR-0021) when given — Bedrock only; scripted/ollama ignore it.
    const creds = tenantCredentials ? await tenantCredentials.forTenant(tenant) : undefined;
    const base = creds
      ? new BedrockInferenceProvider(model ?? inference.model, region, creds)
      : model && inferenceKind === "bedrock"
        ? new BedrockInferenceProvider(model, region)
        : inference;
    return new AdmissionInferenceProvider(base, gate, tenant, scopeId);
  };

  // credential broker defaults to deny-all (noop). CRED_BROKER=local grants static
  // per-tenant service-account creds; CRED_BROKER=vault exchanges the caller's token
  // for downstream creds that act AS the user (OBO, RFC 8693 — ADR-0010).
  const credentials: CredentialBroker = (() => {
    switch (env.CRED_BROKER ?? "noop") {
      case "local":
        return new LocalCredentialBroker(env.CRED_BROKER_CONFIG);
      case "vault":
        // OBO_ACTOR = this runtime's agent identity, carried into the act claim (A2A chain)
        return new OboTokenVaultBroker(env.CRED_BROKER_CONFIG, env.OBO_ACTOR ?? "agent-os");
      default:
        return new NoopCredentialBroker();
    }
  })();

  // tool gateway (ADR-0011): built-in tools (workspace + http) always run in-process. External
  // tools come EITHER from the centralized tool gateway (TOOL_GATEWAY_URL — ADR-0011 dir. b /
  // 0029: one shared service holds the MCP connections + creds, the runtime forwards identity and
  // holds neither) OR from MCP servers connected in-process (MCP_SERVERS — dir. a). Both behind
  // the same ToolProvider port; the loop is unchanged.
  const toolProvider: ToolProvider = (() => {
    const providers: ToolProvider[] = [new BuiltinToolProvider(credentials)];
    if (env.TOOL_GATEWAY_URL) {
      providers.push(new GatewayToolProvider(env.TOOL_GATEWAY_URL));
    } else {
      const mcpServers: McpServers = env.MCP_SERVERS ? JSON.parse(env.MCP_SERVERS) : {};
      if (Object.keys(mcpServers).length) providers.push(new McpToolProvider(mcpServers, credentials));
    }
    return new CompositeToolProvider(providers);
  })();

  // remember (State primitive): durable run store. In-memory for dev; DynamoDB
  // (a real AWS resource) for restart-survival; Firestore for the GCP managed profile,
  // where the DISPATCH=agentengine split needs the front door and the engine to share
  // one run. RUNS_TABLE_ENDPOINT → DynamoDB Local; FIRESTORE_* tune the GCP backing.
  const runStore: RunStore = (() => {
    switch (env.RUN_STORE) {
      case "dynamodb":
        return new DynamoDBRunStore(env.RUNS_TABLE ?? "agent-os-runs", region, env.RUNS_TABLE_ENDPOINT);
      case "firestore": {
        // Firestore REST resolves the (default) database ONLY by project ID — a project
        // NUMBER 404s ("database (default) does not exist"). The managed runtime injects
        // GOOGLE_CLOUD_PROJECT as the NUMBER (aiplatform tolerates it, Firestore does not),
        // so prefer an explicit GCP_PROJECT (the ID) and treat GOOGLE_CLOUD_PROJECT as a
        // last resort (correct only when it happens to hold the ID, e.g. local dev).
        const project = env.GCP_PROJECT ?? env.GOOGLE_CLOUD_PROJECT;
        if (!project) throw new Error("RUN_STORE=firestore requires GCP_PROJECT (the project ID; a project number will not resolve)");
        return new FirestoreRunStore(project, {
          database: env.FIRESTORE_DATABASE,
          collection: env.FIRESTORE_RUNS_COLLECTION,
          endpoint: env.FIRESTORE_ENDPOINT,
        });
      }
      default:
        return new InMemoryRunStore();
    }
  })();

  // agent control plane (#5): the registry of agent definitions the runtime reads.
  // memory (seeded from AGENTS_JSON) for dev; dynamodb (cheap mode — edit agents with a
  // PutItem, no redeploy, ADR-0031); kube reads Agent CRs (ADR-0012).
  // AGENTS_TABLE_ENDPOINT → DynamoDB Local.
  const agentRegistry: AgentRegistry = (() => {
    switch (env.AGENT_REGISTRY ?? "memory") {
      case "memory":
        return new InMemoryAgentRegistry(env.AGENTS_JSON ? (JSON.parse(env.AGENTS_JSON) as AgentSpec[]) : []);
      case "dynamodb":
        return new DynamoAgentRegistry(env.AGENTS_TABLE ?? "agent-os-agents", region, env.AGENTS_TABLE_ENDPOINT);
      case "kube":
        return new KubeAgentRegistry(env.AGENTS_NAMESPACE ?? "agent-os");
      default:
        throw new Error(`unknown AGENT_REGISTRY: ${env.AGENT_REGISTRY}`);
    }
  })();

  return { inference, sandbox, guard, telemetry, gate, authenticator, authorizer, credentials, toolProvider, runStore, agentRegistry, inferenceForTenant, claimSource, claimWrite, tenantCredentials, memory, sessionRecorder };
}
