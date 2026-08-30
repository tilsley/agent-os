/**
 * Proves the agent onboarding write path (ADR-0038): registration is gated
 * (authn → authz → validation), ownership is STAMPED from the verified identity
 * (never taken from the payload), and cross-tenant overwrite/delete is refused.
 * The registry here is in-memory — the same handler serves dynamo in the cloud.
 */
import { test, expect } from "bun:test";
import {
  InMemoryAgentRegistry,
  StaticTokenAuthenticator,
  NoopGate,
  NoopAuthenticator,
  type Providers,
} from "@agent-os/core";
import { createApp, validateAgentSpec } from "./app";

function makeApp(registry = new InMemoryAgentRegistry()) {
  // minimal providers: only what the /agents routes touch needs to be real
  const providers = {
    authenticator: new StaticTokenAuthenticator("tok-a:teama:alice,tok-b:teamb:bob"),
    authorizer: { name: "allow-all", authorize: async () => ({ allow: true }) },
    gate: new NoopGate(),
    agentRegistry: registry,
    runStore: { name: "memory", create: async () => {}, get: async () => undefined, update: async () => {}, list: async () => [] },
    inference: { name: "scripted", model: "test" },
    memory: undefined,
  } as unknown as Providers;
  return { app: createApp(providers), registry };
}

const post = (app: (r: Request) => Promise<Response>, body: unknown, token?: string) =>
  app(
    new Request("http://x/agents", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
  );

test("registers a valid agent and stamps the caller's tenant", async () => {
  const { app, registry } = makeApp();
  const res = await post(app, { name: "scribe", systemPrompt: "be brief", maxSteps: 4, tenant: "SPOOFED" }, "tok-a");
  expect(res.status).toBe(201);
  const saved = await registry.get("scribe");
  expect(saved?.tenant).toBe("teama"); // stamped from identity — the payload's tenant is ignored
  expect(saved?.kind).toBe("loop"); // defaulted
});

test("rejects unauthenticated and invalid writes", async () => {
  const { app } = makeApp();
  expect((await post(app, { name: "scribe" })).status).toBe(401);
  expect((await post(app, { name: "Bad Name!" }, "tok-a")).status).toBe(400);
  expect((await post(app, { name: "x", kind: "nope" }, "tok-a")).status).toBe(400);
  expect((await post(app, { name: "x", maxSteps: 999 }, "tok-a")).status).toBe(400);
  expect((await post(app, { name: "x", command: "run" }, "tok-a")).status).toBe(400); // command needs kind=sandboxed
});

test("refuses cross-tenant overwrite and delete; owner can do both", async () => {
  const { app } = makeApp();
  expect((await post(app, { name: "scribe" }, "tok-a")).status).toBe(201);
  expect((await post(app, { name: "scribe" }, "tok-b")).status).toBe(403); // bob can't take alice's agent
  const delB = await app(new Request("http://x/agents/scribe", { method: "DELETE", headers: { authorization: "Bearer tok-b" } }));
  expect(delB.status).toBe(403);
  expect((await post(app, { name: "scribe", maxSteps: 6 }, "tok-a")).status).toBe(200); // owner upsert
  const delA = await app(new Request("http://x/agents/scribe", { method: "DELETE", headers: { authorization: "Bearer tok-a" } }));
  expect(delA.status).toBe(200);
});

test("501 when the registry has no write path (the kube case)", async () => {
  const readOnly = new InMemoryAgentRegistry();
  (readOnly as any).put = undefined;
  (readOnly as any).delete = undefined;
  const { app } = makeApp(readOnly);
  expect((await post(app, { name: "scribe" }, "tok-a")).status).toBe(501);
});

test("validateAgentSpec drops unknown fields (allowlist projection)", () => {
  const { spec } = validateAgentSpec({ name: "x", systemPrompt: "p", evil: "field", tenant: "spoof" });
  expect(spec).toEqual({ name: "x", kind: "loop", systemPrompt: "p" });
});

test("validateAgentSpec accepts a description and rejects an over-length one", () => {
  const ok = validateAgentSpec({ name: "x", description: "Files bugs from a failing run." });
  expect(ok.spec).toEqual({ name: "x", kind: "loop", description: "Files bugs from a failing run." });
  const tooLong = validateAgentSpec({ name: "x", description: "z".repeat(281) });
  expect(tooLong.spec).toBeUndefined();
  expect(tooLong.error).toMatch(/description/);
});
