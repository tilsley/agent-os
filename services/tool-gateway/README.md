# tool-gateway

**The centralized tool/MCP execution path** — `do`'s second face (calling tools), not a separate
primitive (see [primitives.md](../../docs/primitives.md)). A standalone service (Bun, mirrors the
inference gateway) that holds the MCP connections, the per-tenant policy, and the broker credentials,
so every agent resolves + invokes its external tools through **one shared endpoint** instead of each
connecting itself. 50 agents share one MCP server, not 50; the agent pod holds no tool credential and
opens no tool connection. ADR-0011 direction (b), realized self-hosted ([ADR-0029](../../docs/decisions/0029-governed-egress-choke-points.md)).

## Endpoints

| Route | Does |
|---|---|
| `POST /tools/list` | authn → tenant → the tenant's **permitted** tools (`ToolDef[]`, namespaced `server__tool`) |
| `POST /tools/call` `{name, input}` | resolve → execute the tool **server-side** (creds injected) → `{output}`; `404` if not permitted/unknown (default-deny, doesn't leak which) |
| `GET /healthz` | liveness |

Agents reach it via `GatewayToolProvider` (the client side, behind the same `ToolProvider` port) —
set `TOOL_GATEWAY_URL` on the runtime and it resolves external tools from here instead of connecting
to MCP servers in-process (`MCP_SERVERS`). Built-in workspace/http tools stay local to the agent.

## Run (local)

```bash
# the gateway, fronting the demo mock MCP "orders" server (stdio), granted to teamA
MCP_SERVERS='{"orders":{"transport":"stdio","command":"bun","args":["run","examples/mcp-gateway/mock-mcp-server.ts"],"tenants":["teamA"]}}' \
  AUTHN=token GATE_TOKENS="tok-a:teamA:alice,tok-b:teamB:bob" PORT=3200 \
  bun run services/tool-gateway/server.ts

curl -s -XPOST localhost:3200/tools/list -H 'authorization: Bearer tok-a'   # teamA: sees orders__lookup_order
curl -s -XPOST localhost:3200/tools/list -H 'authorization: Bearer tok-b'   # teamB: [] (policy)
curl -s -XPOST localhost:3200/tools/call -H 'authorization: Bearer tok-a' \
  -H 'content-type: application/json' -d '{"name":"orders__lookup_order","input":{"orderId":"ORD-42"}}'
```

Config (env, ports/adapters seam): `AUTHN` (token / oidc-sa / mesh-id), `CRED_BROKER` (noop / local /
vault), `MCP_SERVERS` (the servers + per-tenant `tenants` allowlist + optional `credentialTarget`).

## Trust

A third-party MCP server is **untrusted surface** — vet/allowlist sources; treat tool descriptions
and responses as potential prompt-injection / exfil vectors. This is a governance chokepoint, not
just a router — it is the high-value target (it holds the tool creds), so it stays dumb (no agent
loop, no sandbox). Tool output is screened by the **guard** control before it re-enters model context
([ADR-0008](../../docs/decisions/0008-guard-content-safety-primitive.md)).

## Notes / follow-ups

- **Connection pooling** — a fresh MCP connect per call today (`McpToolProvider.resolve` per request);
  pooling is deferred ([ADR-0011](../../docs/decisions/0011-tool-mcp-gateway.md)).
- **Managed swap-in** — AWS Bedrock AgentCore Gateway is the hosted single-MCP-endpoint alternative
  behind the same port ([ADR-0007](../../docs/decisions/0007-tools-and-external-auth.md)).
- **In-cluster** — done. Standalone `deploy/helm/tool-gateway`, or the toggleable `toolGateway` component
  in `deploy/helm/agent-os` (`--set toolGateway.enabled=true`, which auto-injects `TOOL_GATEWAY_URL` into
  the runtime — needs a token-preserving runtime authn, `AUTHN=oidc-sa`/`mesh`). Proven end-to-end by
  `deploy/local/tool-gateway-e2e.sh`: an agent composes *both* governed chokepoints (`think` →
  inference gateway, `do`-tools → tool gateway → MCP) holding no model creds and no tool creds, only
  its SA token both gateways verify via TokenReview.
