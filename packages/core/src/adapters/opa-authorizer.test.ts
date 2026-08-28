/**
 * Proves the OpaAuthorizer wire contract (ADR-0015): it POSTs
 * { input: { principal, action, resource } } to OPA's Data API, reads the decision
 * document, and FAILS CLOSED when OPA errors or is unreachable.
 */
import { test as baseTest, expect } from "bun:test";
// Integration: exercises a live loopback HTTP server (Bun.serve), unreliable on
// hermetic CI runners — this is really an integration test, not a unit test. Runs
// by default; the CI unit lane sets CI=1 so it skips there. Force with RUN_INTEGRATION=1.
const test = baseTest.skipIf(!!process.env.CI && !process.env.RUN_INTEGRATION);
import { OpaAuthorizer } from "./opa-authorizer";
import type { Principal } from "../gate";

const alice: Principal = { tenant: "support", subject: "alice@corp", groups: ["engineering"] };

// a mock OPA that records the request and returns whatever decision we set
function mockOpa(decision: unknown, status = 200) {
  let received: any;
  const server = Bun.serve({
    port: 0, // ephemeral
    async fetch(req) {
      received = await req.json();
      return new Response(JSON.stringify({ result: decision }), { status, headers: { "content-type": "application/json" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1/data/agentos/authz`, received: () => received, stop: () => server.stop(true) };
}

test("sends input {principal, action, resource} and permits on allow:true", async () => {
  const opa = mockOpa({ allow: true, reason: "permitted" });
  try {
    const d = await new OpaAuthorizer(opa.url).authorize(alice, "run:create", "ticket-bot");
    expect(d).toEqual({ allow: true, reason: "permitted" });
    expect(opa.received()).toEqual({ input: { principal: alice, action: "run:create", resource: "ticket-bot" } });
  } finally {
    opa.stop();
  }
});

test("denies (with reason) on allow:false", async () => {
  const opa = mockOpa({ allow: false, reason: "requires the 'admins' group" });
  try {
    const d = await new OpaAuthorizer(opa.url).authorize(alice, "run:create", "admin-bot");
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("admins");
  } finally {
    opa.stop();
  }
});

test("accepts a bare boolean decision document", async () => {
  const opa = mockOpa(true);
  try {
    expect((await new OpaAuthorizer(opa.url).authorize(alice, "run:create")).allow).toBe(true);
  } finally {
    opa.stop();
  }
});

test("fails closed on undefined result (no matching rule)", async () => {
  const opa = mockOpa(undefined);
  try {
    expect((await new OpaAuthorizer(opa.url).authorize(alice, "run:create")).allow).toBe(false);
  } finally {
    opa.stop();
  }
});

test("fails closed when OPA is unreachable", async () => {
  // nothing listening on this port
  const d = await new OpaAuthorizer("http://127.0.0.1:1/v1/data/agentos/authz").authorize(alice, "run:create");
  expect(d.allow).toBe(false);
  expect(d.reason).toContain("unreachable");
});
