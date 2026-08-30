/**
 * SDK behavior that isn't just fetch plumbing: the machine token provider's
 * cache/refresh discipline (one grant in flight, refresh before expiry) and the
 * gateway client's wire shape + fail-with-status errors.
 */
import { test, expect, afterEach } from "bun:test";
import { machineTokenProvider } from "./machine-login";
import { GatewayClient, GatewayError } from "./gateway";

// Restore global fetch after every test. Without this, mockFetch's override leaks
// into every test FILE bun runs afterwards (shared process) — it poisoned obo/opa/
// call-agent on CI with a stray 402, order-dependently. Isolation, not loopback.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return calls;
}

test("machineTokenProvider caches until near expiry and dedupes concurrent grants", async () => {
  let grants = 0;
  const calls = mockFetch(() => {
    grants++;
    return Response.json({ access_token: `tok-${grants}`, expires_in: 3600 });
  });
  const provider = machineTokenProvider({ hostedUiBaseUrl: "https://auth.example.com", clientId: "c", clientSecret: "s" });
  const [a, b] = await Promise.all([provider(), provider()]);
  expect(a).toBe("tok-1");
  expect(b).toBe("tok-1"); // concurrent calls share one in-flight grant
  expect(await provider()).toBe("tok-1"); // cached
  expect(grants).toBe(1);
  expect(calls[0].url).toBe("https://auth.example.com/oauth2/token");
  const sent = new URLSearchParams(String(calls[0].init?.body));
  expect(sent.get("grant_type")).toBe("client_credentials");
});

test("machineTokenProvider refreshes an expired token", async () => {
  let grants = 0;
  mockFetch(() => {
    grants++;
    return Response.json({ access_token: `tok-${grants}`, expires_in: 30 }); // < 60s skew → immediately stale
  });
  const provider = machineTokenProvider({ hostedUiBaseUrl: "https://auth.example.com", clientId: "c", clientSecret: "s" });
  await provider();
  await provider();
  expect(grants).toBe(2);
});

test("GatewayClient posts the platform wire and returns the AssistantTurn", async () => {
  const calls = mockFetch(() => Response.json({ text: "hi", usage: { inputTokens: 3, outputTokens: 5 } }));
  const client = new GatewayClient({ gatewayUrl: "https://gw.example.com/", token: "tok" });
  const turn = await client.generate([{ role: "user", text: "hello" }], { maxTokens: 128 });
  expect(turn.text).toBe("hi");
  expect(calls[0].url).toBe("https://gw.example.com/v1/generate");
  const body = JSON.parse(String(calls[0].init?.body));
  expect(body).toMatchObject({ maxTokens: 128, messages: [{ role: "user", text: "hello" }] });
  expect((calls[0].init?.headers as any).authorization).toBe("Bearer tok");
});

test("GatewayClient surfaces non-2xx as GatewayError with status + body", async () => {
  mockFetch(() => Response.json({ error: "budget exceeded" }, { status: 402 }));
  const client = new GatewayClient({ gatewayUrl: "https://gw.example.com", token: async () => "tok" });
  const err = await client.generate([{ role: "user", text: "x" }], { maxTokens: 8 }).catch((e) => e);
  expect(err).toBeInstanceOf(GatewayError);
  expect(err.status).toBe(402);
});
