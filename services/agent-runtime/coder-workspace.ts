/**
 * The coder workspace lifecycle (ADR-0046) — structurally the claude-code shim
 * (ADR-0034) re-homed onto our own L1 and its sandbox session:
 *   - materialize the gate-authorized Run.repo into the session workspace after claim;
 *   - the loop runs over the checkout (the workspace tools ARE the coding tools);
 *   - at ANY terminal status, push what changed as refs/heads/run/<id> — never a
 *     default-branch write.
 *
 * The git legs run in the EXECUTOR (this trusted ring-2 process), not the sandbox:
 * field-tested 2026-07-19, the Code Interpreter session has NO git and NO network
 * egress — and that isolation is a feature, not a gap. Files move over the GitHub
 * Trees/Git Data APIs executor-side and the SandboxSession file surface sandbox-side,
 * so the installation token NEVER enters the workspace (ADR-0034's "secret never
 * enters the agent" holds after all — stronger than the bounded step down ADR-0046
 * priced in) and the lifecycle works on every sandbox backend identically.
 *
 * POC bounds (logged, not silent): text files only (binaries are skipped — the
 * loop couldn't edit them through readFile/writeFile anyway), ≤200 files,
 * ≤400 KB/file. Big-repo support = the sandbox-manager lifecycle backlog.
 */
import { createHash } from "node:crypto";
import type { SandboxSession } from "@agent-os/core";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 400_000;

export interface CoderWorkspace {
  branch: string;
  /** Push the workspace's changes to run/<id>. Returns a human summary line. */
  finalize(): Promise<string>;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

/** Git's blob id: sha1("blob <len>\0" + bytes) — lets finalize detect changes
 *  without keeping file contents around. */
const blobSha = (content: Buffer): string =>
  createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

const looksBinary = (buf: Buffer): boolean => buf.includes(0);

function ghClient(token: string) {
  const headers = {
    authorization: `token ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "agent-os-coder",
    "content-type": "application/json",
  };
  return async (method: string, path: string, body?: unknown): Promise<any> => {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
}

/** Materialize `repo` ("owner/name" — validated at the front door) into the session
 *  workspace via the Trees API, tracking blob ids for change detection. */
export async function cloneCoderWorkspace(
  session: SandboxSession,
  repo: string,
  token: string,
  runId: string,
): Promise<CoderWorkspace> {
  const gh = ghClient(token);
  const branch = `run/${runId}`;

  const info = await gh("GET", `/repos/${repo}`);
  const defaultBranch: string = info.default_branch;
  const head = await gh("GET", `/repos/${repo}/git/ref/${encodeURIComponent(`heads/${defaultBranch}`)}`);
  const headSha: string = head.object.sha;
  const headCommit = await gh("GET", `/repos/${repo}/git/commits/${headSha}`);
  const tree = await gh("GET", `/repos/${repo}/git/trees/${headCommit.tree.sha}?recursive=1`);

  const blobs = (tree.tree as TreeEntry[]).filter((e) => e.type === "blob");
  if (tree.truncated || blobs.length > MAX_FILES) {
    throw new Error(`${repo} has too many files for the coder workspace (POC cap ${MAX_FILES})`);
  }

  // path -> {sha, mode} of what we materialized; the baseline finalize diffs against
  const baseline = new Map<string, { sha: string; mode: string }>();
  let skipped = 0;
  for (const e of blobs) {
    if ((e.size ?? 0) > MAX_FILE_BYTES) {
      skipped++;
      continue;
    }
    const blob = await gh("GET", `/repos/${repo}/git/blobs/${e.sha}`);
    const content = Buffer.from(blob.content, "base64");
    if (looksBinary(content)) {
      skipped++;
      continue; // the loop can't edit binaries through the text tool surface anyway
    }
    await session.writeFile(e.path, content.toString("utf8"));
    baseline.set(e.path, { sha: e.sha, mode: e.mode });
  }
  console.log(`coder workspace: materialized ${baseline.size} files from ${repo}@${headSha.slice(0, 8)}${skipped ? ` (${skipped} binary/large skipped)` : ""}`);

  return {
    branch,
    async finalize(): Promise<string> {
      // diff the sandbox against the baseline by recomputing blob ids
      const paths = (await session.listFiles()).slice(0, MAX_FILES * 2);
      const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
      const seen = new Set<string>();
      let changed = 0;
      for (const path of paths) {
        seen.add(path);
        const known = baseline.get(path);
        let content: Buffer;
        try {
          content = Buffer.from(await session.readFile(path), "utf8");
        } catch {
          continue; // unreadable (e.g. binary artifact the run produced) — leave it behind
        }
        if (known && blobSha(content) === known.sha) continue; // untouched
        const blob = await gh("POST", `/repos/${repo}/git/blobs`, { content: content.toString("base64"), encoding: "base64" });
        entries.push({ path, mode: known?.mode ?? "100644", type: "blob", sha: blob.sha });
        changed++;
      }
      // deletions: baseline files listFiles no longer reports — but VERIFY by reading,
      // because list surfaces differ per backend (field-tested: the local sandbox's
      // glob hides dotfiles, which would otherwise be pushed as bogus removals).
      for (const [path, known] of baseline) {
        if (seen.has(path)) continue;
        let content: Buffer | undefined;
        try {
          content = Buffer.from(await session.readFile(path), "utf8");
        } catch {
          /* really gone */
        }
        if (content == null) {
          entries.push({ path, mode: "100644", type: "blob", sha: null });
          changed++;
        } else if (blobSha(content) !== known.sha) {
          const blob = await gh("POST", `/repos/${repo}/git/blobs`, { content: content.toString("base64"), encoding: "base64" });
          entries.push({ path, mode: known.mode, type: "blob", sha: blob.sha });
          changed++;
        }
      }
      if (!changed) return `no changes in ${repo}; nothing pushed`;

      const newTree = await gh("POST", `/repos/${repo}/git/trees`, { base_tree: headCommit.tree.sha, tree: entries });
      const commit = await gh("POST", `/repos/${repo}/git/commits`, {
        message: `agent-os run ${runId}`,
        tree: newTree.sha,
        parents: [headSha],
      });
      await gh("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
      return `pushed ${changed} change(s) as ${commit.sha.slice(0, 8)} to ${repo}@${branch}`;
    },
  };
}
