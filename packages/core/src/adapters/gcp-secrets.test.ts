import { test, expect, beforeEach, afterEach } from "bun:test";
import { accessSecret, resolveSecretEnv } from "./gcp-secrets";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

// GCP_ACCESS_TOKEN short-circuits gcpAccessToken()'s metadata fetch (same pattern as
// the other GCP adapter tests), so these never touch the network beyond the injected fetch.
let savedToken: string | undefined;
beforeEach(() => {
  savedToken = process.env.GCP_ACCESS_TOKEN;
  process.env.GCP_ACCESS_TOKEN = "test-token";
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.GCP_ACCESS_TOKEN;
  else process.env.GCP_ACCESS_TOKEN = savedToken;
  delete process.env.E2B_API_KEY;
  delete process.env.E2B_API_KEY_SECRET;
});

test("accessSecret decodes the base64 payload and sends a bearer token to :access", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const fake = (async (url: any, init: any) => {
    seenUrl = String(url);
    seenAuth = init?.headers?.authorization ?? "";
    return new Response(JSON.stringify({ payload: { data: b64("sk-secret") } }), { status: 200 });
  }) as unknown as typeof fetch;

  const v = await accessSecret("projects/p/secrets/e2b-api-key/versions/latest", fake);
  expect(v).toBe("sk-secret");
  expect(seenUrl).toContain("/secrets/e2b-api-key/versions/latest:access");
  expect(seenAuth).toBe("Bearer test-token");
});

test("accessSecret throws on a non-200", async () => {
  const fake = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
  await expect(accessSecret("projects/p/secrets/x/versions/latest", fake)).rejects.toThrow(/403/);
});

test("resolveSecretEnv fills the env var from ${VAR}_SECRET when unset", async () => {
  process.env.E2B_API_KEY_SECRET = "projects/p/secrets/e2b-api-key/versions/latest";
  const fake = (async () =>
    new Response(JSON.stringify({ payload: { data: b64("the-key") } }), { status: 200 })) as unknown as typeof fetch;

  const did = await resolveSecretEnv("E2B_API_KEY", fake);
  expect(did).toBe(true);
  expect(process.env.E2B_API_KEY).toBe("the-key");
});

test("resolveSecretEnv is a no-op when the var is already set (never calls out)", async () => {
  process.env.E2B_API_KEY = "already";
  let called = false;
  const fake = (async () => {
    called = true;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  const did = await resolveSecretEnv("E2B_API_KEY", fake);
  expect(did).toBe(false);
  expect(called).toBe(false);
  expect(process.env.E2B_API_KEY).toBe("already");
});

test("resolveSecretEnv is a no-op when no _SECRET reference is present", async () => {
  const fake = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
  const did = await resolveSecretEnv("E2B_API_KEY", fake);
  expect(did).toBe(false);
  expect(process.env.E2B_API_KEY).toBeUndefined();
});
