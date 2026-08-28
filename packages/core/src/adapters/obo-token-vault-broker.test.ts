/**
 * Proves the OBO broker (ADR-0010): it performs an RFC 8693 token exchange of the
 * caller's subject_token for a downstream-scoped token, caches it per (subject,
 * target) in the vault, exchanges per-user, and FAILS CLOSED.
 */
import { test as baseTest, expect } from "bun:test";
// Integration: exercises a live loopback HTTP server (Bun.serve), unreliable on
// hermetic CI runners — this is really an integration test, not a unit test. Runs
// by default; the CI unit lane sets CI=1 so it skips there. Force with RUN_INTEGRATION=1.
const test = baseTest.skipIf(!!process.env.CI && !process.env.RUN_INTEGRATION);
import { OboTokenVaultBroker } from "./obo-token-vault-broker";
import type { Principal } from "../gate";

const alice: Principal = { tenant: "support", subject: "alice@corp", token: "alice-jwt" };
const bob: Principal = { tenant: "support", subject: "bob@corp", token: "bob-jwt" };

// a mock RFC 8693 token-exchange endpoint that records each exchange
function mockExchange() {
  let count = 0;
  const requests: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const form = Object.fromEntries(new URLSearchParams(await req.text()));
      requests.push(form);
      count++;
      return Response.json({ access_token: `obo-${form.subject_token}-${count}`, expires_in: 300 });
    },
  });
  const cfg = (target = "jira") =>
    JSON.stringify({ [target]: { tokenEndpoint: `http://127.0.0.1:${server.port}/token`, baseUrl: "https://jira.example", audience: "jira-api" } });
  return { cfg, count: () => count, requests, stop: () => server.stop(true) };
}

test("exchanges the subject_token for a downstream credential (RFC 8693)", async () => {
  const ex = mockExchange();
  try {
    const cred = await new OboTokenVaultBroker(ex.cfg()).issue(alice, "jira");
    expect(cred?.token).toBe("obo-alice-jwt-1");
    expect(cred?.baseUrl).toBe("https://jira.example");
    expect(ex.requests[0]).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "alice-jwt",
      audience: "jira-api",
    });
  } finally {
    ex.stop();
  }
});

test("vault caches per (subject, target) — no re-exchange on the second call", async () => {
  const ex = mockExchange();
  try {
    const broker = new OboTokenVaultBroker(ex.cfg());
    const a = await broker.issue(alice, "jira");
    const b = await broker.issue(alice, "jira");
    expect(b?.token).toBe(a?.token);
    expect(ex.count()).toBe(1); // reused from the vault, not exchanged again
  } finally {
    ex.stop();
  }
});

test("exchanges per-user — bob gets a different downstream token than alice", async () => {
  const ex = mockExchange();
  try {
    const broker = new OboTokenVaultBroker(ex.cfg());
    const a = await broker.issue(alice, "jira");
    const b = await broker.issue(bob, "jira");
    expect(a?.token).not.toBe(b?.token);
    expect(ex.count()).toBe(2);
  } finally {
    ex.stop();
  }
});

test("fails closed: ungranted target, missing inbound token, or exchange error", async () => {
  const ex = mockExchange();
  try {
    const broker = new OboTokenVaultBroker(ex.cfg("jira"));
    expect(await broker.issue(alice, "github")).toBeNull(); // not granted
    expect(await broker.issue({ tenant: "support", subject: "no-token" }, "jira")).toBeNull(); // no subject_token
  } finally {
    ex.stop();
  }
  // endpoint that refuses the exchange -> null
  const refuse = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 400 }) });
  try {
    const cfg = JSON.stringify({ jira: { tokenEndpoint: `http://127.0.0.1:${refuse.port}/token`, baseUrl: "https://j", audience: "j" } });
    expect(await new OboTokenVaultBroker(cfg).issue(alice, "jira")).toBeNull();
  } finally {
    refuse.stop(true);
  }
});
