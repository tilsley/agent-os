/**
 * TEMPORARY diagnostic — root-causes why Bun.serve loopback fetch fails on CI
 * runners (obo/opa/call-agent). Logs the actual error for each loopback variant.
 * Always passes (asserts only that the server bound), so CI stays green and the
 * DIAG lines are readable via `gh run view --log`. Delete after diagnosis.
 */
import { test, expect } from "bun:test";

test("DIAGNOSTIC: Bun.serve loopback reachability on this host", async () => {
  console.log(`DIAG env platform=${process.platform} bun=${Bun.version} CI=${process.env.CI ?? "<unset>"}`);

  const server = Bun.serve({ port: 0, fetch: () => new Response("pong") });
  const boundPort = server.port; // .port resets to 0 after stop()
  console.log(`DIAG server.port=${server.port} hostname=${(server as any).hostname} url=${String(server.url)}`);

  const targets = [
    `http://localhost:${server.port}/`,
    `http://127.0.0.1:${server.port}/`,
    `http://[::1]:${server.port}/`,
    String(server.url),
  ];

  for (const t of targets) {
    try {
      const res = await fetch(t);
      const body = await res.text();
      console.log(`DIAG OK   ${t} -> ${res.status} "${body}"`);
    } catch (e: any) {
      console.log(
        `DIAG FAIL ${t} -> ${e?.name}: ${e?.message} | code=${e?.code} | cause=${e?.cause?.code ?? JSON.stringify(e?.cause)}`,
      );
    }
  }

  // A second server bound explicitly to 127.0.0.1, fetched explicitly on 127.0.0.1.
  const s4 = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("pong4") });
  try {
    const res = await fetch(`http://127.0.0.1:${s4.port}/`);
    console.log(`DIAG OK   explicit-ipv4 bind+fetch -> ${res.status} "${await res.text()}"`);
  } catch (e: any) {
    console.log(`DIAG FAIL explicit-ipv4 bind+fetch -> ${e?.name}: ${e?.message} | cause=${e?.cause?.code ?? JSON.stringify(e?.cause)}`);
  }
  s4.stop(true);

  server.stop(true);
  expect(boundPort).toBeGreaterThan(0);
});
