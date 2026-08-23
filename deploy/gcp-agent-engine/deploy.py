#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["google-cloud-aiplatform>=1.112.0"]
# ///
"""Deploy the agent-runtime container to GCP Vertex **Agent Runtime** and smoke it.

The GCP sibling of ADR-0042's AgentCore deploy. The image is built + pushed by
Cloud Build (cloudbuild.yaml); this creates the managed runtime from that image,
overriding the command to the agent-engine.ts entrypoint ("fourth entrypoint, same
image"), then runs a probe query to prove the invoke path.

    # deploy (build first with cloudbuild.yaml)
    uv run deploy/gcp-agent-engine/deploy.py deploy
    # smoke an existing engine
    uv run deploy/gcp-agent-engine/deploy.py query --engine <RESOURCE_NAME> --probe
    uv run deploy/gcp-agent-engine/deploy.py query --engine <RESOURCE_NAME> --task "say hi"

NOTE: the exact container_spec sub-fields (command/env/ports) for Agent Runtime BYOC
are under-documented; the agent-engine.ts entrypoint LOGS every invocation so the
first live deploy reveals the true contract. Adjust CONTAINER_SPEC below to match.
"""
import argparse
import json
import sys

PROJECT = "decent-decker-270921"
LOCATION = "europe-west2"
IMAGE = "europe-west2-docker.pkg.dev/decent-decker-270921/agent-os/agent-runtime:latest"
SERVICE_ACCOUNT = "agent-runtime@decent-decker-270921.iam.gserviceaccount.com"

# Reasoning-engine container_spec takes ONLY the image (no command/env override — the
# API exposes neither). Everything else is steered by env_vars: the CMD indirection
# selects the agent-engine.ts entrypoint (AGENT_ENTRYPOINT), the runtime hosts the loop
# (DISPATCH=inprocess), and INFERENCE_PROVIDER=vertex points the loop at Gemini on Vertex
# (GCP-native, ADC auth via the runtime service account — no key). GATE is left unset →
# open authn, since the :query call is already GCP-IAM-gated at the platform; per-tenant
# gate/budget wiring (identity → tenant) is a later phase.
ENV_VARS = {
    "AGENT_ENTRYPOINT": "services/agent-runtime/agent-engine.ts",
    "DISPATCH": "inprocess",
    "INFERENCE_PROVIDER": "vertex",
    # GOOGLE_CLOUD_PROJECT is a RESERVED var the platform injects — config.ts reads it
    # (both the Vertex provider and the Firestore run store resolve the project from it).
    "GCP_LOCATION": LOCATION,
    "VERTEX_MODEL": "gemini-2.5-flash",
    # Firestore-backed run store (not in-process): the DISPATCH=agentengine front door
    # creates the run and THIS container executes it — different processes, shared ledger.
    # GCP_PROJECT must be the project ID: Firestore REST 404s on a project NUMBER, and the
    # platform injects GOOGLE_CLOUD_PROJECT as the number (fine for Vertex, not Firestore).
    "RUN_STORE": "firestore",
    "GCP_PROJECT": PROJECT,
    # Per-tenant budget (ADR-0044 4b): the engine meters spend per token via the
    # AdmissionInferenceProvider (reserve→settle). GATE=local + SPEND_STORE=firestore
    # point that at the SAME Firestore ledger the front door's checkBudget admission
    # reads — so a run's cost recorded here is visible to the front door across the
    # DISPATCH=agentengine process split. GATE_BUDGET_USD is the fallback per-tenant cap.
    "GATE": "local",
    "SPEND_STORE": "firestore",
    "GATE_BUDGET_USD": "1.00",
    # Durable per-tenant memory (ADR-0044 phase 5): Vertex Agent Engine Memory Bank behind
    # the MemoryAdapter port. MEMORY_BANK_ENGINE_ID is the reasoningEngine that PARENTS the
    # memories (a stable host — can be a dedicated engine; here the first loop engine), so
    # memories survive loop-engine redeploys. Per-tenant isolation is the immutable scope map.
    "MEMORY_BANK_ENGINE_ID": "2592534069086519296",
    # Console visibility (ADR-0044 phase 5b): after each run the engine mirrors the
    # transcript into a Vertex Agent Engine Session under this reasoningEngine, so runs
    # surface in its console. Same stable managed-state host as the Memory Bank parent.
    "GCP_SESSION_ENGINE_ID": "2592534069086519296",
    # The `do` surface: E2B session-native Model-B sandbox (ADR-0047) — a Firecracker
    # microVM per session with a real Go/JDK/Node toolchain, so the coder loop compiles
    # and tests in-box. E2B_API_KEY is NOT here: only a Secret Manager *reference*; the
    # loop's SA resolves it at startup (resolveSecretEnv), keeping the key out of this
    # config. Build the template first — deploy/e2b-coder/README.md.
    "SANDBOX_PROVIDER": "e2b",
    "E2B_TEMPLATE": "agent-os-coder",
    "E2B_API_KEY_SECRET": f"projects/{PROJECT}/secrets/e2b-api-key/versions/latest",
    "AIP_HTTP_PORT": "8080",
}


def client():
    import vertexai

    return vertexai.Client(project=PROJECT, location=LOCATION)


def deploy(args) -> None:
    c = client()
    image = getattr(args, "image", None) or IMAGE
    display_name = getattr(args, "display_name", None) or "agent-os-loop"
    print(f"creating Agent Runtime '{display_name}' from {image} ...", file=sys.stderr)
    engine = c.agent_engines.create(
        config={
            "display_name": display_name,
            "description": "agent-os L1 loop on Vertex Agent Runtime (ADR-0042 GCP sibling)",
            "container_spec": {"image_uri": image},
            "env_vars": ENV_VARS,
            "service_account": SERVICE_ACCOUNT,
            "min_instances": 0,  # scale to zero — the cost-sensitive win
            "max_instances": 1,
        }
    )
    name = getattr(engine, "resource_name", None) or getattr(engine, "name", None) or str(engine)
    print(f"created: {name}")
    print("smoke it:  uv run deploy/gcp-agent-engine/deploy.py query --engine "
          f"{name} --probe", file=sys.stderr)


def query(args) -> None:
    # A custom/BYOC container has class_methods=None, so the SDK exposes no .query()
    # helper. Call the reasoningEngine :query REST method directly — the platform POSTs
    # our `input` to the container at POST /api/reasoning_engine and relays the
    # container's `{"output": ...}` body back as the :query response (verified 2026-07-14).
    import urllib.request
    import google.auth
    import google.auth.transport.requests

    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(google.auth.transport.requests.Request())
    payload = {"input": {"probe": True} if args.probe else {"task": args.task}}
    url = f"https://{LOCATION}-aiplatform.googleapis.com/v1/{args.engine}:query"
    print(f"POST {url}\n  {payload}", file=sys.stderr)
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {creds.token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        print(json.dumps(json.load(r), indent=2))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("deploy")
    # A second runtime from a different image (e.g. the BYOC/nested-container probe,
    # services/agent-runtime/Dockerfile.gcp-probe → agent-runtime:probe) with a distinct
    # display name, reusing the same ENV_VARS bundle.
    d.add_argument("--image", help="override the container image_uri (default: agent-runtime:latest)")
    d.add_argument("--display-name", dest="display_name", help="override the Agent Runtime display name")
    q = sub.add_parser("query")
    q.add_argument("--engine", required=True, help="reasoningEngine resource name")
    q.add_argument("--probe", action="store_true", help="probe mode (no model call)")
    q.add_argument("--task", default="say hello in five words", help="a real task to run")
    args = ap.parse_args()
    {"deploy": deploy, "query": query}[args.cmd](args)


if __name__ == "__main__":
    main()
