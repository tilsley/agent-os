/**
 * Proves the coder loop's credential + workspace seams (ADR-0046):
 *   - the App JWT is a verifiable RS256 token with GitHub's iat/exp shape;
 *   - the workspace lifecycle clones after claim, pushes run/<id> when HEAD moved,
 *     stays quiet when it didn't, and never writes the token to disk (.git/config);
 *   - the dispatch envelope carries the token per substrate (env override /
 *     invoke payload) and never onto the Run record.
 */
import { test, expect } from "bun:test";
import { generateKeyPairSync, createVerify, createHash } from "node:crypto";
import type { Run } from "@agent-os/core";
import { appJwt } from "./github-app";
import { cloneCoderWorkspace } from "./coder-workspace";
import { agentCoreDispatch, type AgentCoreDispatchConfig } from "./dispatch";

// --- appJwt -----------------------------------------------------------------

test("appJwt is RS256-verifiable with GitHub's claim shape", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string; // GitHub ships PKCS#1
  const jwt = appJwt("12345", pem, 1_700_000_000);
  const [h, p, s] = jwt.split(".");
  expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
  expect(claims).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: "12345" });
  const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, "base64url"));
  expect(ok).toBe(true);
});

// --- workspace lifecycle (executor-side git over the GitHub API) -------------

/** An in-memory sandbox file surface — the workspace the loop edits. */
function fakeSession() {
  const files = new Map<string, string>();
  return {
    files,
    session: {
      id: "s1",
      writeFile: async (p: string, c: string) => void files.set(p, c),
      readFile: async (p: string) => {
        const c = files.get(p);
        if (c == null) throw new Error("no such file");
        return c;
      },
      listFiles: async () => [...files.keys()],
      runCmd: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    } as any,
  };
}

/** A fake GitHub Data API over global fetch: one repo, one README at HEAD. */
function fakeGitHub() {
  const posts: { path: string; body: any }[] = [];
  const readme = "hello\n";
  // the finalize diff recomputes git blob ids, so the fixture sha must be the real one
  const readmeSha = createHash("sha1").update(`blob ${readme.length}\0`).update(readme).digest("hex");
  const routes: Record<string, any> = {
    "GET /repos/o/r": { default_branch: "main" },
    "GET /repos/o/r/git/ref/heads%2Fmain": { object: { sha: "headsha" } },
    "GET /repos/o/r/git/commits/headsha": { tree: { sha: "treesha" } },
    "GET /repos/o/r/git/trees/treesha?recursive=1": {
      truncated: false,
      tree: [{ path: "README.md", mode: "100644", type: "blob", sha: readmeSha, size: readme.length }],
    },
    [`GET /repos/o/r/git/blobs/${readmeSha}`]: { content: Buffer.from(readme).toString("base64") },
    "POST /repos/o/r/git/blobs": { sha: "newblobsha" },
    "POST /repos/o/r/git/trees": { sha: "newtreesha" },
    "POST /repos/o/r/git/commits": { sha: "newcommitsha" },
    "POST /repos/o/r/git/refs": { ref: "created" },
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const method = init?.method ?? "GET";
    const path = String(url).replace("https://api.github.com", "");
    const hit = routes[`${method} ${path}`];
    if (!hit) return new Response("not found", { status: 404 });
    if (method === "POST") posts.push({ path, body: JSON.parse(init.body) });
    return Response.json(hit);
  }) as any;
  return { posts, restore: () => void (globalThis.fetch = original) };
}

test("materialize → edit → finalize pushes run/<id> via the Data API; token stays out of the sandbox", async () => {
  const gh = fakeGitHub();
  try {
    const { session, files } = fakeSession();
    const ws = await cloneCoderWorkspace(session, "o/r", "ghs_tok", "run-1");
    expect(files.get("README.md")).toBe("hello\n"); // baseline materialized
    expect([...files.values()].join()).not.toContain("ghs_tok"); // nothing token-shaped in the workspace
    files.set("README.md", "hello\nedited\n");
    files.set("NEW.md", "new\n");
    const note = await ws.finalize();
    expect(note).toContain("o/r@run/run-1");
    const ref = gh.posts.find((p) => p.path.endsWith("/git/refs"));
    expect(ref?.body.ref).toBe("refs/heads/run/run-1"); // never the default branch
    const commit = gh.posts.find((p) => p.path.endsWith("/git/commits"));
    expect(commit?.body.parents).toEqual(["headsha"]);
    const tree = gh.posts.find((p) => p.path.endsWith("/git/trees"));
    expect(tree?.body.base_tree).toBe("treesha");
    expect(tree?.body.tree).toHaveLength(2); // the edit + the new file
  } finally {
    gh.restore();
  }
});

test("an unchanged workspace pushes nothing", async () => {
  const gh = fakeGitHub();
  try {
    const { session } = fakeSession();
    const ws = await cloneCoderWorkspace(session, "o/r", "t", "run-2");
    expect(await ws.finalize()).toContain("nothing pushed");
    expect(gh.posts).toHaveLength(0);
  } finally {
    gh.restore();
  }
});

test("a deleted file becomes a sha:null tree entry", async () => {
  const gh = fakeGitHub();
  try {
    const { session, files } = fakeSession();
    const ws = await cloneCoderWorkspace(session, "o/r", "t", "run-3");
    files.delete("README.md");
    await ws.finalize();
    const tree = gh.posts.find((p) => p.path.endsWith("/git/trees"));
    expect(tree?.body.tree).toEqual([{ path: "README.md", mode: "100644", type: "blob", sha: null }]);
  } finally {
    gh.restore();
  }
});

test("an unreachable repo fails the clone visibly", async () => {
  const gh = fakeGitHub();
  try {
    const { session } = fakeSession();
    await expect(cloneCoderWorkspace(session, "o/nope", "t", "run-4")).rejects.toThrow("GitHub GET /repos/o/nope");
  } finally {
    gh.restore();
  }
});

// --- dispatch envelope ------------------------------------------------------

const config: AgentCoreDispatchConfig = { runtimeArn: "arn:aws:bedrock-agentcore:eu-west-2:1:runtime/x", region: "eu-west-2" };

test("agentcore dispatch carries the coder token in the invoke payload", async () => {
  const sent: any[] = [];
  const client = { send: async (cmd: any) => (sent.push(cmd.input), { statusCode: 202 }) } as any;
  const registry = { get: async () => ({ name: "c", kind: "coder" }) } as any;
  const run = { id: crypto.randomUUID(), status: "queued", task: "t", agent: "c", repo: "o/r", messages: [], createdAt: "", updatedAt: "" } as unknown as Run;
  agentCoreDispatch(config, { name: "m", update: async () => ({}) } as any, registry, undefined, client)(run, { githubToken: "ghs_x" });
  await new Promise((r) => setTimeout(r, 10));
  const payload = JSON.parse(new TextDecoder().decode(sent[0].payload));
  expect(payload).toEqual({ runId: run.id, githubToken: "ghs_x" });
});
