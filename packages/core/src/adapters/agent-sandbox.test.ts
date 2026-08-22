/**
 * Proves the agent-sandbox SandboxProvider adapter maps the port to shell-exec calls, via an
 * injected fake box — no cluster needed. A live run needs local k3s + the agent-sandbox
 * controller (see agent-sandbox.scratch.ts).
 */
import { test, expect } from "bun:test";
import { AgentSandboxProvider, type AgentSandboxBox } from "./agent-sandbox";

function fakeBox(): { box: AgentSandboxBox; calls: any } {
  const calls: any = { cmds: [], deleted: false };
  const box: AgentSandboxBox = {
    name: "sbx-abc123",
    async exec(cmd, opts) {
      calls.cmds.push({ cmd, opts });
      if (cmd.startsWith("find")) return { stdout: "./a.txt\n./dir/b.txt\n", stderr: "", exitCode: 0 };
      if (cmd.includes("__E__")) return { stdout: cmd.includes("nope") ? "" : "__E__\n", stderr: "", exitCode: 0 };
      if (cmd.startsWith("cat")) return { stdout: "contents", stderr: "", exitCode: 0 };
      if (cmd.startsWith("python3")) return { stdout: "4\n", stderr: "", exitCode: 0 };
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
    async delete() {
      calls.deleted = true;
    },
  };
  return { box, calls };
}

test("startSession returns a SandboxSession bound to the box's name", async () => {
  const { box } = fakeBox();
  const s = await new AgentSandboxProvider({ create: async () => box }).startSession();
  expect(s.id).toBe("sbx-abc123");
});

test("runCmd forwards straight to box.exec with env/timeoutMs", async () => {
  const { box, calls } = fakeBox();
  const s = await new AgentSandboxProvider({ create: async () => box }).startSession();
  const r = await s.runCmd("echo hi", { env: { FOO: "bar" }, timeoutMs: 1000 });
  expect(r).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
  expect(calls.cmds[0]).toEqual({ cmd: "echo hi", opts: { env: { FOO: "bar" }, timeoutMs: 1000 } });
});

test("runCode wraps in python3 -c with shell-quoted code", async () => {
  const { box, calls } = fakeBox();
  const s = await new AgentSandboxProvider({ create: async () => box }).startSession();
  expect(await s.runCode("print(2 + 2)")).toBe("4");
  expect(calls.cmds[0].cmd).toBe("python3 -c 'print(2 + 2)'");
});

test("readFile maps to cat; writeFile maps to mkdir+base64", async () => {
  const { box, calls } = fakeBox();
  const s = await new AgentSandboxProvider({ create: async () => box }).startSession();
  expect(await s.readFile("x.txt")).toBe("contents");
  await s.writeFile("dir/y.txt", "data");
  expect(calls.cmds.at(-1).cmd).toBe(
    `mkdir -p 'dir' && echo '${Buffer.from("data").toString("base64")}' | base64 -d > 'dir/y.txt'`,
  );
});

test("listFiles uses find and strips ./; fileExists uses the __E__ sentinel", async () => {
  const { box } = fakeBox();
  const s = await new AgentSandboxProvider({ create: async () => box }).startSession();
  expect(await s.listFiles()).toEqual(["a.txt", "dir/b.txt"]);
  expect(await s.fileExists("a.txt")).toBe(true);
  expect(await s.fileExists("nope.txt")).toBe(false);
});

test("close() deletes the box even if delete() rejects", async () => {
  const box: AgentSandboxBox = {
    name: "x",
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async delete() {
      throw new Error("boom");
    },
  };
  const s = await new AgentSandboxProvider({ create: async () => box }).startSession();
  await s.close(); // must not throw
});

test("close() deletes the box on the happy path", async () => {
  const { box, calls } = fakeBox();
  const s = await new AgentSandboxProvider({ create: async () => box }).startSession();
  await s.close();
  expect(calls.deleted).toBe(true);
});
