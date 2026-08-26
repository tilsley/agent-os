# Linkerd locally — full-mode mesh-trust authn (ADR-0026/0027)

The "cheap full-mode": Linkerd (far lighter than Istio) does pod-to-pod **mTLS + workload
identity**, so the gateway trusts a **mesh-forwarded identity** instead of verifying a token —
and the **agent carries no credential at all**. The `Authenticator` swap from the cheap-mode
JWKS self-verify; same gateway + agent code.

## Install (Linkerd is its own thing, like Crossplane/LiteLLM)

```bash
colima start --cpu 4 --memory 6                 # control plane + sidecars need headroom (>4Gi)
curl -sL https://run.linkerd.io/install | sh && export PATH=$HOME/.linkerd2/bin:$PATH
kubectl apply --server-side -f \
  https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml
linkerd install --crds | kubectl apply -f -
linkerd install --set proxyInit.runAsRoot=true | kubectl apply -f -   # docker runtime needs root
linkerd check
```

**Gotchas (colima/k3s):** Linkerd edge requires the **Gateway API CRDs** first; on the **docker**
runtime `proxyInit` must run as **root** (`--set proxyInit.runAsRoot=true`); and `linkerd install`
validates the **current** kube context — `kubectl config use-context colima` first (ours kept
defaulting to a dead EKS context).

## Mesh-trust the gateway + run a token-less agent

```bash
kubectl annotate ns agentos-gw linkerd.io/inject=enabled --overwrite        # mesh the namespace
# gateway in mesh mode: AUTHN=mesh-id, MESH_IDENTITY_HEADER=l5d-client-id (no token verification)
helm upgrade inference-gateway deploy/helm/inference-gateway -n agentos-gw \
  --set env.AUTHN=mesh-id --set env.MESH_IDENTITY_HEADER=l5d-client-id --set env.CLAIM_SOURCE=static \
  --set-string 'env.CLAIMS_STATIC={"system:serviceaccount:agentos-gw:spine-agent":{"model":"claude-haiku","monthlyBudgetUsd":5}}'
kubectl -n agentos-gw rollout restart deploy/inference-gateway     # re-injected, now 2/2
kubectl -n agentos-gw apply -f examples/spine-agent/k8s-pod-mesh.yaml   # NO token, NO projected volume
kubectl -n agentos-gw logs spine-agent-mesh -c agent
```

## What it proves (validated)

`status=completed`, output `Paris.`, gateway `POST /v1/chat/completions 200 OK` — with the agent
sending **no credential**. Linkerd mTLS-authenticated it; the gateway's inbound proxy stamped
`l5d-client-id` (`<sa>.<ns>.serviceaccount.identity.linkerd.cluster.local`), which `auth_hook`
maps to `system:serviceaccount:<ns>:<sa>` — the **same claim** the JWKS path uses. So:

| | cheap mode (no mesh) | full mode (Linkerd) |
|---|---|---|
| agent | reads + forwards a projected token | **no token — plain call** |
| gateway authn | self-verify the token vs cluster JWKS | trust the mesh's `l5d-client-id` |
| `auth_hook` env | `JWT_JWKS_URL` | `MESH_IDENTITY_HEADER` |

Header-trust caveat: `l5d-client-id` is only trustworthy because the meshed inbound proxy *sets*
it and strips client-supplied copies — so the gateway must only be reachable through the mesh.

**Teardown** (reclaim the VM): `kubectl delete ns agentos-gw; linkerd uninstall | kubectl delete -f -`.
