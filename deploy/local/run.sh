#!/usr/bin/env bash
# One entry point for the local (colima/k3s) e2e scenarios. `local-full` is the ANCHOR — the whole
# platform in one governed run; the rest are focused slices that isolate a single contract (a slice
# fails unambiguously; the anchor proves they compose). Each scenario builds its image(s), deploys
# into an ephemeral namespace, runs its checks, and prints a teardown line. Most need an AWS profile
# (Bedrock) — pass AWS_PROFILE or rely on the default.
#   bash deploy/local/run.sh                  # list scenarios
#   bash deploy/local/run.sh local-full       # run one
#   AWS_PROFILE=my-profile bash deploy/local/run.sh memory
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

# id | script (relative to deploy/local) | group | one-line: what it proves
CATALOG=(
  "local-full|local-full-e2e.sh|full platform|EVERYTHING on + one governed run: think(gw)+do-tools(gw)+remember under oidc-sa+OPA+claim budget+quota — THE ANCHOR"
  "inference-claims|e2e/run.sh|control plane|inference gateway + claims CRDs/VAP/aggregate-controller (slices 6/7), AWS-free"
  "gate-conformance|gate-conformance.sh|control plane|the gate contract (R1 identity + R2 budget) holds identically across profiles (ADR-0027/0028)"
  "gateway-pod|gateway-pod-test.sh|think|Bun inference gateway as a pod: real SA token -> TokenReview -> claim -> 402 (no AWS)"
  "gateway-mesh|gateway-mesh-test.sh|think|full-mode mesh-trust authn (token-less caller, Linkerd-stamped identity)"
  "memory|memory-k3s.sh|remember|durable per-tenant memory survives a pod restart (ADR-0030)"
  "tool-gateway|tool-gateway-e2e.sh|do-tools|an agent composes both choke points (think + do-tools) in-cluster"
  "tool-gateway-umbrella|tool-gateway-integrated-e2e.sh|do-tools|the tool gateway folded into deploy/helm/agent-os (umbrella component)"
  "tool-gateway-github|tool-gateway-github-e2e.sh|do-tools|a REAL GitHub MCP server through the gateway, broker-injected PAT"
  "dual-gateway|dual-gateway-e2e.sh|do-tools|both gateways: the agent pod holds NEITHER model nor tool creds"
  "sandbox|sandbox-test.sh|do-exec|egress lockdown — the sandbox wall + allowlist (ADR-0020/0022)"
  "sandbox-coding|sandbox-coding-agent.sh|do-exec|Model A end to end behind the egress wall"
  "sandbox-foreign|sandbox-foreign-agent.sh|do-exec|Model B (a real foreign coding agent) behind the egress wall"
  "a2a|a2a-multiagent-e2e.sh|multi-agent|two real agents collaborate over A2A, governed at every hop (ADR-0017/0018)"
)

list() {
  echo "agent-os — local e2e scenarios (colima/k3s).  run:  bash deploy/local/run.sh <id>"
  echo
  local group=""
  for row in "${CATALOG[@]}"; do
    IFS='|' read -r id script grp desc <<<"$row"
    [ "$grp" != "$group" ] && { printf "  ── %s ──\n" "$grp"; group="$grp"; }
    printf "    %-22s %s\n" "$id" "$desc"
  done
  echo
  echo "  (slices isolate one contract; local-full proves they compose. teardown lines are printed per run.)"
}

[ $# -eq 0 ] && { list; exit 0; }

for row in "${CATALOG[@]}"; do
  IFS='|' read -r id script grp desc <<<"$row"
  if [ "$id" = "$1" ]; then
    echo "▶ $id — $desc"; echo
    exec bash "$HERE/$script"
  fi
done
echo "unknown scenario: '$1'"; echo; list; exit 1
