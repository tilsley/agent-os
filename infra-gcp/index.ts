/**
 * agent-os GCP plumbing — the "managed Agent Runtime" profile (ADR-0042's GCP sibling).
 *
 * Phase 1 ("Loop on Agent Runtime") needs only the durable resources AROUND the loop:
 *   - an Artifact Registry repo to hold the agent-runtime image (the loop container),
 *   - the service-account identity the managed Runtime session assumes.
 * The Agent Runtime deploy itself is imperative (client.agent_engines.create with a
 * container_spec.image_uri) — there is no clean IaC resource for it yet, the one
 * sanctioned exception to "provision through IaC, never ad-hoc create".
 *
 * FUTURE REFACTOR: fold this and the AWS CDK stack under infra/gcp + infra/aws for
 * symmetry (per the layout discussion). infra-gcp/ is the interim home.
 */
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

const gcpCfg = new pulumi.Config("gcp");
const project = gcpCfg.require("project");
const region = gcpCfg.get("region") ?? "us-central1";

// Artifact Registry — home for the agent-runtime image (loop container) and any
// sidecars. The Agent Runtime service agent needs Reader here to pull on deploy.
const repo = new gcp.artifactregistry.Repository("agent-os", {
  repositoryId: "agent-os",
  location: region,
  format: "DOCKER",
  description: "agent-os loop + service images for the GCP Agent Runtime profile",
});

// The cloud principal the managed Runtime session runs as. R1 (tenancy stamped from
// verified identity) still happens IN the loop — this is only the GCP-side identity
// the managed runtime assumes to reach Vertex/platform APIs.
const runtimeSa = new gcp.serviceaccount.Account("agent-runtime", {
  accountId: "agent-runtime",
  displayName: "agent-os Agent Runtime loop identity",
});

// The loop invokes Vertex models / platform APIs as this SA.
new gcp.projects.IAMMember("runtime-aiplatform-user", {
  project,
  role: "roles/aiplatform.user",
  member: pulumi.interpolate`serviceAccount:${runtimeSa.email}`,
});

// The Reasoning Engine service agent pulls our custom container from Artifact
// Registry at deploy time — but roles/aiplatform.reasoningEngineServiceAgent carries
// NO artifactregistry permissions (verified 2026-07-14), so the pull fails and the
// deploy dies with code 13 before the container ever runs (no container logs). Grant
// it repo-scoped reader. (The generic aiplatform.serviceAgent already has AR via its
// project role; this covers the -re agent specifically.)
const projectNumber = gcp.organizations.getProject({ projectId: project }).then((p) => p.number);
const reasoningEngineAgent = pulumi
  .output(projectNumber)
  .apply((n) => `serviceAccount:service-${n}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`);
new gcp.artifactregistry.RepositoryIamMember("re-agent-ar-reader", {
  project,
  location: region,
  repository: repo.repositoryId,
  role: "roles/artifactregistry.reader",
  member: reasoningEngineAgent,
});

// Firestore — the shared run store for the DISPATCH=agentengine profile. The front
// door creates a run (queued) and the managed Agent Runtime container executes it;
// they are different processes, so the run ledger must live OUTSIDE either process.
// Firestore is the GCP sibling of the serverless profile's DynamoDB run table:
// serverless, scale-to-zero, on-demand billed → ~$0 idle (the cost-sensitive brief).
const firestoreApi = new gcp.projects.Service("firestore-api", {
  project,
  service: "firestore.googleapis.com",
  disableOnDestroy: false,
});

// The project's (default) Native-mode database, co-located with the loop's region so
// reads/writes stay in-region. Location is permanent once set — europe-west2 mirrors
// the AWS primary region. RunStore rows land in the `runs` collection (FirestoreRunStore).
const runsDb = new gcp.firestore.Database(
  "runs-db",
  {
    project,
    name: "(default)",
    locationId: region,
    type: "FIRESTORE_NATIVE",
    // POC: keep teardown cheap. Flip deleteProtectionState to ENABLED before this holds
    // anything real (Firestore default-DB deletion is already heavily guarded regardless).
    deleteProtectionState: "DELETE_PROTECTION_DISABLED",
    deletionPolicy: "DELETE",
  },
  { dependsOn: [firestoreApi] },
);

// The loop reads/writes runs as its own SA (datastore.user spans Firestore Native).
new gcp.projects.IAMMember("runtime-datastore-user", {
  project,
  role: "roles/datastore.user",
  member: pulumi.interpolate`serviceAccount:${runtimeSa.email}`,
});

// --- E2B coder sandbox credential (ADR-0047) --------------------------------------
// The GCP coder loop's `do` runs on E2B (session-native Model B); E2B authenticates
// with an API key. We keep the key OUT of the Agent Runtime deploy config: Pulumi
// creates the Secret Manager secret + grants the loop SA accessor, and the key VALUE
// is added out-of-band (`gcloud secrets versions add`) so it never lands in Pulumi
// state or git. The loop resolves it at startup via E2B_API_KEY_SECRET (resolveSecretEnv).
const secretManagerApi = new gcp.projects.Service("secretmanager-api", {
  project,
  service: "secretmanager.googleapis.com",
  disableOnDestroy: false,
});

const e2bApiKey = new gcp.secretmanager.Secret(
  "e2b-api-key",
  {
    project,
    secretId: "e2b-api-key",
    replication: { auto: {} },
  },
  { dependsOn: [secretManagerApi] },
);

// Least privilege: the loop SA reads (only) this secret; no project-wide accessor.
new gcp.secretmanager.SecretIamMember("runtime-e2b-key-accessor", {
  project,
  secretId: e2bApiKey.secretId,
  role: "roles/secretmanager.secretAccessor",
  member: pulumi.interpolate`serviceAccount:${runtimeSa.email}`,
});

export const artifactRepo = pulumi.interpolate`${region}-docker.pkg.dev/${project}/${repo.repositoryId}`;
export const e2bApiKeySecret = pulumi.interpolate`projects/${project}/secrets/${e2bApiKey.secretId}/versions/latest`;
export const runtimeServiceAccount = runtimeSa.email;
export const gcpRegion = region;
export const firestoreDatabase = runsDb.name;
