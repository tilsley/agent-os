/**
 * Build + publish the `agent-os-coder` E2B template (v2 SDK). Run with `bun run build`.
 *
 * Auth: needs an E2B API key — either `export E2B_API_KEY=...` or a prior `bunx @e2b/cli auth login`.
 * The runtime selects this template by name via E2B_TEMPLATE=agent-os-coder (deploy.py); rebuilding
 * keeps the same name, so no deploy change is needed on a rebuild.
 *
 * Sizing mirrors the old e2b.toml — a coder box compiles and runs tests, so give it room.
 */
import { Template, defaultBuildLogger } from "e2b";
import { template } from "./template";

await Template.build(template, "agent-os-coder", {
  cpuCount: 2,
  memoryMB: 4096,
  onBuildLogs: defaultBuildLogger(),
});

console.log("built + published E2B template: agent-os-coder");
