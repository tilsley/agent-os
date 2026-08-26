# Sandbox egress lockdown — the `do` containment control

ADR-0020/0022. The invariant: **no anonymous egress** — a sandbox gets zero internet by
default; the only way out is a named, policied door. **Deployed by the Helm chart
[`deploy/helm/sandbox`](../../deploy/helm/sandbox)** (the maintained source of truth — no ad-hoc yaml).

```
  deploy/helm/sandbox  (helm install sandbox -n agentos-sandbox)
  ├─ NetworkPolicy default-deny-egress   ← the WALL: all pods, deny all egress
  ├─ NetworkPolicy allow-dns             ← DOOR: kube-dns only (no open :53 tunnel)
  ├─ NetworkPolicy allow-sandbox→proxy   ← DOOR: app=sandbox → egress-proxy:3128 only
  ├─ egress-proxy (Squid)                ← named-domain allowlist (values.proxy.allowDomains)
  └─ demo (values.demo.enabled): gateway stand-in + sandbox pod + allow-sandbox→gateway
```

## Run it

```bash
make sandbox-test        # helm install + assert wall + allowlist, then tear down (KEEP=1 to inspect)
# or by hand: helm --kube-context colima install sandbox deploy/helm/sandbox -n agentos-sandbox --create-namespace
```

Proves: `sandbox → gateway = 200` (the door + DNS), `sandbox → {1.1.1.1, example.com,
github.com} = blocked`, and DNS still resolves (so egress was blocked, not DNS broken).

## Model A vs Model B (ADR-0020)

Same wall, different door set:
- **Model A** (loop-as-app): the sandbox runs only untrusted code and never thinks → door
  set is **empty** (or registry-only). Delete the `allow-sandbox-to-gateway` policy and you
  have it: zero egress.
- **Model B** (agent-in-box, e.g. Claude Code): the harness thinks *inside* the box → the
  gateway door is **required** (the one this slice opens). Egress lockdown is the
  load-bearing control here because there's no trusted app to lean on.

## Why this works on k3s (where the runtime's egress policy didn't)

k3s enforces NetworkPolicy via built-in kube-router. The `agent-runtime` couldn't take a
tight egress policy because it needs the **k8s API server** (`10.43.0.1 → host:6443` DNAT,
which port-based egress doesn't match — see `namespace.yaml`). A **sandbox has no
API-server need**, so default-deny egress is clean here. Pod-backed ClusterIP services
(the gateway, kube-dns) match egress policy fine post-DNAT; only the host-network API path
was the problem.

## Slice 2 — the named-domain door (egress proxy + allowlist) ✅

NetworkPolicy can't allowlist *domains* (registries sit behind shifting CDN IPs), so the
named-domain door is a **forward proxy** (Squid) the sandbox is forced through:
the `egress-proxy` template in `deploy/helm/sandbox`, asserted by `make sandbox-test`.

Two independent locks, both proven: allowlisted domains (`.npmjs.org`, `.pypi.org`) tunnel
through; non-listed (`github.com`, `evil.example`) get **`TCP_DENIED/403` at the proxy** —
a recorded policy decision in squid's access log, the `record` watching the door; a direct
bypass (no proxy) is killed by the slice-1 wall. The proxy gets broad NetworkPolicy egress
(its *Squid allowlist* does domain enforcement; NetworkPolicy can't); the sandbox may reach
*only* the proxy.

> **Allowed domains are still exfil channels** (a push to an allowed git host leaks). The
> allowlist is a per-tenant **risk dial**; `guard` + `record` watch the doors. Containment
> shrinks the channel set — it doesn't make exfil impossible.

Squid-in-k8s lessons (cost a few iterations): the Canonical `ubuntu/squid` entrypoint does a
cache-init pass and exits → run `squid -N -f …` in the foreground; squid drops to user
`proxy` and **can't write root's `/dev/stdout`** → log to its own `/var/log/squid/`; and set
`buffered_logs off` so the door record is real-time.

## Slice 3 — research-as-a-tool (Model A) ✅

The inbound mirror of egress lockdown, built for the **first customer (Model A — our own
loop)**: research is a tool the *trusted loop* calls — `fetch_url` (+ `web_search` over an
injected backend) in `packages/core/src/tools.ts` (`webResearchTools`). It executes in the
runtime, *outside* the zero-egress sandbox, and the loop screens its output via `guard` as
untrusted ingress (`loop.ts` — fetched pages are the indirect-injection vector).

The tool owns the **egress policy**: public http(s) only, **SSRF-guarded** (no
private/loopback/cloud-metadata hosts — the runtime has the network the sandbox doesn't),
redirects refused (no 302-into-private), an optional **per-tenant domain allowlist**, and a
body cap. Tested (`bun test tools.web.test.ts`): SSRF/non-allowlisted URLs are refused *before
any network call*; `web_search` is a thin wrapper over a backend we don't build (Tavily/Brave/
MCP). The Model-B routing wrinkle (Claude Code's own web tools fighting the wall) is deferred —
not our first customer.

> Known limit: the literal-IP + redirect refusal covers URL-level SSRF; a *hostname* that
> resolves to a private IP (DNS rebinding) isn't caught app-side — the slice-2 egress proxy is
> the network-layer backstop in full deployments.

## Next slices

1. **Runtime isolation** — gVisor/Kata `RuntimeClass` on EKS (the kernel/VM boundary the
   network wall complements); E2B / AgentCore as managed adapters (ADR-0022).
