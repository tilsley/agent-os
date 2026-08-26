# agent-controller

The **reconciler** half of the agent control plane (#5, [ADR-0012](../../docs/decisions/0012-agent-control-plane.md)).
A minimal Kubernetes **operator**: it lists `Agent` custom resources, validates each,
and writes `.status.phase` (`Ready` | `Invalid`) + a message. Runs as its **own pod**,
separate from `agent-runtime` — the registry (catalog, read by the runtime) and the
controller (reconciler, writes status) are distinct components.

- **Reconcile model:** level-based resync loop (`RECONCILE_INTERVAL_MS`). A
  production operator would also `watch()` for low-latency reaction; the resync loop
  is robust and enough to learn the pattern.
- **Identity:** in-cluster ServiceAccount token; RBAC grants get/list/watch on
  `agents` and update on `agents/status`.
- **Image:** reuses `agent-runtime:dev` (the whole workspace) with a different
  command — no separate image to maintain.

```bash
make k8s-deploy                          # deployed by the deploy/helm/agent-os Helm chart (controller.enabled)
kubectl -n agent-os get agents          # PHASE column fills in (Ready / Invalid)
kubectl -n agent-os logs deploy/agent-controller
```
