# Repository restructure — plan (no moves yet)

**Goals:** (1) *conceptual clarity* — the top-level tree should tell the platform's
story; (2) *kill deploy sprawl* — collapse the five deploy/infra dirs into one.

**Status:** proposal for review. Nothing has moved. Execute in phases (below),
each independently verifiable, once a phase is approved.

---

## The enabling fact (why this is safer than it looks)

This is a clean **Bun workspace** and cross-package imports resolve by **workspace
name** (`@agent-os/core`, used 48×) — *not* by relative paths or tsconfig aliases.
Verified: **no tsconfig `extends`/`references` path coupling**, **no CI/.github**,
and most Dockerfiles use `COPY . .` from the repo-root context.

**Implication:** moving a *whole package directory* does not break a single
`import` — the package name is stable, so we only update the `workspaces` globs.
The real cost is the **non-package glue** that hardcodes top-level paths.

## The cost map (what actually breaks on a move)

Measured references to each dir across Makefile + deploy scripts + ignore files +
docs (filesystem paths only; `apps/v1` k8s apiVersions excluded):

| Dir | glue refs | dominant surface | move cost |
|---|---|---|---|
| `infra/` | ~7 | Makefile `cd infra`, cdk.json (self-relative) | **cheap** |
| `infra-gcp/` | ~2 | `.gcloudignore`, Pulumi entry | **cheap** |
| `platform/apis/` | ~4 | 2 service READMEs, 1 local demo | **cheap** |
| `charts/` | ~90 | deploy/local scripts + Makefile (`charts/agent-os`) | **moderate** |
| `services/` | ~100 | deploy scripts (`services/*/Dockerfile`, `server.ts`) | **expensive** |
| `packages/` | high (mostly docs prose) | docs; 2 smoke scripts import by *relative* path | **expensive** |
| `examples/` | ~60 | — | **stays put (no move)** |
| `apps/` | ~13 | — | **stays put (no move)** |

High-severity refs (break execution): deploy scripts + Makefile + Dockerfiles.
Low-severity refs (break a link): docs prose — bulk, but cosmetic.

---

## Target structure

```text
agent-os/
├── platform/                 # THE PLATFORM — control plane + the runtime library
│   ├── core/                 #   @agent-os/core      (was packages/core)
│   ├── client/               #   @agent-os/client    (was packages/client)
│   └── services/             #   the 9 services      (was services/)
│       ├── agent-runtime/  agent-controller/  claims-controller/
│       ├── claude-code-runner/  inference-gateway/  tool-gateway/
│       └── iam-authorizer/  sandbox-manager/  telemetry-processor/   (specs)
├── apps/                     # deployed agent-products (L2)   — STAYS PUT
│   └── console · doc-gardener · dep-migrator
├── examples/                 # the 11-rung capability ladder  — STAYS PUT
├── deploy/                   # HOW IT'S DEPLOYED — one place, was five dirs
│   ├── aws/                  #   AWS CDK             (was infra/)
│   ├── gcp/                  #   GCP Pulumi          (was infra-gcp/)
│   ├── helm/                 #   Helm charts         (was charts/)
│   ├── crossplane/           #   Crossplane XRDs     (was platform/apis/)
│   ├── local/                #   local e2e scripts   (unchanged)
│   ├── eks/                  #   EKS capstone        (unchanged)
│   ├── aurora/  e2b-coder/  gcp-agent-engine/         (unchanged)
├── docs/                     # unchanged
├── Makefile · package.json · bun.lock · README.md · bunfig.toml
```

**Top level goes 10 dirs → 5** (`platform` · `apps` · `examples` · `deploy` · `docs`).
`apps/` and `examples/` keep their current locations — so no code that runs *on*
the platform moves, only the platform's own libs+services regroup under `platform/`.
Keeping `apps/`/`examples/` put also erases the bulk of Phase 3's churn (their ~70
combined glue refs, the `.dockerignore apps/` gotcha, and the hardcoded
`examples/sandboxed-agent` Dockerfile path all stay valid).

> **Note on the `platform/` name:** today `platform/` means only Crossplane. In the
> target, Crossplane moves to `deploy/crossplane/` and `platform/` is repurposed to
> mean the platform's own code. Net clearer, but call it out so the rename is
> deliberate, not accidental.

### Open decisions (resolve before Phase 3)

- **Keep `packages/` instead of `platform/`?** If the code-regroup churn isn't worth
  it, Phase 3 can be skipped entirely — Phases 1–2 already kill the deploy sprawl.
  (Resolved: `apps/` stays top-level — no `agents/` wrapper.)

---

## Phased migration

Each phase is a self-contained, verifiable commit. **Stop after any phase** — the
repo is fully working at every phase boundary. Phases are ordered cheap→expensive
so the deploy-sprawl win lands first.

### Phase 1 — fold the cheap dirs into `deploy/` (low risk, ~13 refs)

Moves `infra → deploy/aws`, `infra-gcp → deploy/gcp`, `platform/apis → deploy/crossplane`.

```bash
git mv infra deploy/aws
git mv infra-gcp deploy/gcp
git mv platform/apis deploy/crossplane
git rm platform/README.md   # or: git mv platform/README.md deploy/crossplane/README.md
rmdir platform 2>/dev/null || true
```

Glue to fix:
- [ ] `package.json` — workspace glob `"infra"` → `"deploy/aws"`.
- [ ] `Makefile` — every `cd infra` → `cd deploy/aws` (6 targets: synth/diff/deploy/
      destroy/deploy-postgres/destroy-postgres; also `aurora-bootstrap`'s
      `../../../deploy/aurora` relative hop recomputed from `deploy/aws/...`).
- [ ] `.gcloudignore` — `infra/cdk.out` → `deploy/aws/cdk.out`; `infra-gcp/bin` → `deploy/gcp/bin`.
- [ ] `deploy/local/crossplane/inferenceprofile.yaml` — comment ref `platform/apis/inference-profile` → `deploy/crossplane/inference-profile`.
- [ ] `services/sandbox-manager/README.md`, `services/inference-gateway/README.md` — links to `platform/apis/*` → `deploy/crossplane/*`.
- [ ] Docs: `resource-model.md`, `architecture.md`, `platform.md`, `README.md` — `platform/apis` / `infra/` / `infra-gcp/` mentions.
- [ ] `cdk.json` — no change (self-relative `bun bin/agent-os.ts`), moves intact.

**Verify:** `bun install` (globs) · `cd deploy/aws && bunx cdk synth AgentOsState AgentOsBedrock` · `cd deploy/gcp && bun tsc --noEmit` · `make synth`.

### Phase 2 — `charts → deploy/helm` (moderate, ~90 mechanical refs)

```bash
git mv charts deploy/helm
```

Glue to fix (almost all are the literal string `charts/` → `deploy/helm/`):
- [ ] `Makefile` — `charts/agent-os`, `charts/inference-gateway` (k8s-deploy, gw-deploy, sandbox-test targets).
- [ ] `deploy/local/*.sh` + `deploy/local/*.yaml` — every `charts/agent-os`, `charts/inference-gateway`, `charts/agent-os/crds/*` (dual-gateway, e2e/run.sh, gateway-pod-test, gateway-mesh-test, local-full-e2e, sandbox-*, …).
- [ ] `deploy/eks/run.sh`, `deploy/eks/*.yaml`, `deploy/eks/README.md` — `charts/agent-os`.
- [ ] Docs — `charts/*` references.

> Sweepable with `grep -rl 'charts/' Makefile deploy docs | xargs sed -i '' 's#\bcharts/#deploy/helm/#g'` — but **review the diff**, then run the verify gate; don't trust a blind sed.

**Verify:** `helm template deploy/helm/agent-os` · `helm lint deploy/helm/*` · `make k8s-deploy` dry-run (or a local `deploy/local/local-full-e2e.sh` if a cluster is up).

### Phase 3 — code regroup for conceptual clarity (expensive; optional)

Delivers the `platform/` story: the platform's own libs + services under one roof.
`apps/` and `examples/` **do not move**, which keeps this to `packages/` + `services/`.
Skip entirely if the churn isn't worth it — Phases 1–2 already met "kill deploy sprawl."

```bash
mkdir platform
git mv packages/core     platform/core
git mv packages/client   platform/client
git mv services          platform/services
rmdir packages 2>/dev/null || true
```

Glue to fix:
- [ ] `package.json` workspaces: `packages/*` → `platform/core` + `platform/client`;
      `services/*` → `platform/services/*`. (`apps/*`, `examples/*` unchanged. Package
      **names** unchanged → imports intact.)
- [ ] `.dockerignore` — unchanged (`apps/` stays valid); just confirm the `COPY . .`
      service images, now built from `platform/services/*/Dockerfile`, still exclude what they should.
- [ ] `Makefile` — `services/agent-runtime/server.ts` → `platform/services/...`;
      `services/*/Dockerfile` (`-f` paths, ~5); `services/inference-gateway/litellm`
      (aurora-bootstrap `cd`). (`apps/dep-migrator`, `examples/*/run.sh` unchanged.)
- [ ] `deploy/local/*.sh` + `*.yaml` — `services/*/Dockerfile`, `services/*/server.ts`,
      `services/claims-controller/controller.ts` → `platform/services/...`.
      (`examples/mcp-gateway/*`, `examples/spine-agent/*` refs unchanged.)
- [ ] `deploy/local/agentcore-smoke-*.ts` — **relative import**
      `packages/core/src/adapters/dynamodb-run-store` → `platform/core/src/...`
      (these two bypass the workspace name — the only imports that actually move).
- [ ] Helm charts (`deploy/helm/*`) — grep values/templates for `services/` build-path assumptions.
- [ ] Docs — prose links to `services/` and `packages/` (low severity, one sweep).
- [ ] `README.md` layout tree + `docs/architecture.md` layout block — redraw to the new tree.

**Verify:** `bun install` · `bunx tsc --noEmit` at repo root (all workspaces) ·
`make run` (agent-runtime boots) · one full `deploy/local/local-full-e2e.sh` if a
cluster is available · `make coding-agent` dry path.

---

## Risks & rollback

- **Biggest risk:** a missed hardcoded path in a deploy script that only surfaces at
  runtime (not at `tsc`). Mitigation: the per-phase verify gates run the actual
  scripts, and Phase 3's grep checklist is exhaustive by construction.
- **`.dockerignore apps/`** is the sneakiest item — a silent image-bloat / build-
  context change, not an error. Explicit checklist item above.
- **Rollback:** each phase is one commit; `git revert` restores the prior layout.
  `git mv` preserves history (`git log --follow`).
- **Do not** blind-`sed` across the repo without reviewing the diff — the string
  `services/` and `charts/` appear in prose, URLs, and image tags too.

## Recommendation

Do **Phase 1 now** (cheap, high clarity, kills 3/5 deploy dirs). Then **Phase 2**
to finish the deploy consolidation. Treat **Phase 3** as a separate decision — it's
the bulk of the churn and only serves the "clarity" goal, which Phases 1–2 already
advance. If Phase 3 is a "yes," do it in its own session with a clean tree.
