import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { after, before, test } from "node:test";
import { cleanEnv, cliCommand, ensureBuilt, openaiCall, pickModels, removeDir, tempDir, writeTree } from "../test/surface/support.ts";

interface Rpc {
  id?: unknown;
  result?: any;
  error?: { code: number; message: string };
}

class Client {
  readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private waiting: Array<(message: Rpc) => void> = [];
  private readonly queue: Rpc[] = [];
  stderr = "";
  stdoutNoise = "";
  readonly exited: Promise<number>;

  constructor(cwd: string, env: NodeJS.ProcessEnv) {
    const { command, args } = cliCommand(["mcp", "--offline"]);
    this.child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8").on("data", (data: string) => this.onData(data));
    this.child.stderr.setEncoding("utf8").on("data", (data: string) => (this.stderr += data));
    this.exited = new Promise((resolve) => this.child.on("close", (code) => resolve(code ?? -1)));
  }

  private onData(data: string): void {
    this.buffer += data;
    for (let nl = this.buffer.indexOf("\n"); nl !== -1; nl = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      let message: Rpc;
      try {
        message = JSON.parse(line) as Rpc;
      } catch {
        this.stdoutNoise += line;
        continue;
      }
      const waiter = this.waiting.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    }
  }

  next(): Promise<Rpc> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  send(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(text: string): void {
    this.child.stdin.write(text);
  }

  async request(id: number, method: string, params?: unknown): Promise<Rpc> {
    this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return this.next();
  }

  async open(): Promise<void> {
    const response = await this.request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
    assert.equal(response.result.serverInfo.name, "swapcheck");
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async close(): Promise<number> {
    this.child.stdin.end();
    return this.exited;
  }
}

let root: string;
let home: string;
const models = pickModels();

before(async () => {
  await ensureBuilt();
  root = tempDir();
  home = tempDir();
  writeTree(root, { "src/llm.ts": openaiCall(models.retiring) });
});

after(() => {
  removeDir(root);
  removeDir(home);
});

test("handshake, tool list and clean shutdown", async () => {
  const client = new Client(root, cleanEnv(home));
  await client.open();
  const list = await client.request(2, "tools/list");
  assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["scan", "watch", "find", "explain_event"]);
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.paid, undefined);
  }
  assert.equal(await client.close(), 0);
  assert.equal(client.stdoutNoise, "");
});

test("tools/list before initialize is refused", async () => {
  const client = new Client(root, cleanEnv(home));
  const response = await client.request(1, "tools/list");
  assert.equal(response.error?.code, -32002);
  await client.close();
});

test("scan reports the retiring model with its source", async () => {
  const client = new Client(root, cleanEnv(home));
  await client.open();
  const response = await client.request(2, "tools/call", { name: "scan", arguments: {} });
  assert.equal(response.result.isError, false);
  const body = JSON.parse(response.result.content[0].text);
  const item = body.items.find((i: { model: string }) => i.model === models.retiring);
  assert.ok(item);
  assert.ok(item.events.some((e: { source: string }) => e.source === models.retiringEvent.source));
  assert.deepEqual(response.result.structuredContent, body);
  await client.close();
});

test("scan does not write models.lock", async () => {
  const fresh = tempDir();
  try {
    writeTree(fresh, { "a.ts": openaiCall(models.retiring) });
    const client = new Client(fresh, cleanEnv(home));
    await client.open();
    await client.request(2, "tools/call", { name: "scan", arguments: {} });
    await client.close();
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(`${fresh}/models.lock`), false);
  } finally {
    removeDir(fresh);
  }
});

test("watch without a lock is a tool error, not a protocol failure", async () => {
  const fresh = tempDir();
  try {
    const client = new Client(fresh, cleanEnv(home));
    await client.open();
    const response = await client.request(2, "tools/call", { name: "watch", arguments: {} });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /models\.lock/);
    await client.close();
  } finally {
    removeDir(fresh);
  }
});

test("find returns a shortlist and validates arguments", async () => {
  const client = new Client(root, cleanEnv(home));
  await client.open();
  const found = await client.request(2, "tools/call", { name: "find", arguments: { model: models.retiring, limit: 3 } });
  const body = JSON.parse(found.result.content[0].text);
  assert.equal(body.model, models.retiring);
  assert.ok(body.shortlist.length <= 3);
  assert.equal((await client.request(3, "tools/call", { name: "find", arguments: {} })).error?.code, -32602);
  assert.equal((await client.request(4, "tools/call", { name: "find", arguments: { model: "x".repeat(300) } })).error?.code, -32602);
  await client.close();
});

test("explain_event describes an event and refuses an empty request", async () => {
  const client = new Client(root, cleanEnv(home));
  await client.open();
  const response = await client.request(2, "tools/call", { name: "explain_event", arguments: { id: models.retiringEvent.id } });
  const body = JSON.parse(response.result.content[0].text);
  assert.match(body.events[0].explanation, new RegExp(models.retiring.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal((await client.request(3, "tools/call", { name: "explain_event", arguments: {} })).error?.code, -32602);
  await client.close();
});

test("malformed and oversized input get errors and the server survives", async () => {
  const client = new Client(root, cleanEnv(home));
  await client.open();
  client.sendRaw("{broken\n");
  assert.equal((await client.next()).error?.code, -32700);
  client.sendRaw("[1,2,3]\n");
  assert.equal((await client.next()).error?.code, -32600);
  client.sendRaw(`${"x".repeat(1024 * 1024 + 100)}\n`);
  assert.equal((await client.next()).error?.code, -32600);
  assert.deepEqual((await client.request(9, "ping")).result, {});
  assert.equal(await client.close(), 0);
});

test("paid tools appear only with the opt-in, and confirm is required to spend", async () => {
  const hidden = new Client(root, cleanEnv(home));
  await hidden.open();
  assert.equal((await hidden.request(2, "tools/call", { name: "test", arguments: { from: "a", to: ["b"], max_usd: 1, confirm: true } })).error?.code, -32602);
  await hidden.close();

  const allowed = new Client(root, cleanEnv(home, { SWAPCHECK_MCP_ALLOW_SPEND: "1" }));
  await allowed.open();
  const list = await allowed.request(2, "tools/list");
  assert.ok(list.result.tools.some((t: { name: string }) => t.name === "test"));
  // With no cases on disk the tool stops at planning, which proves it does not start spending.
  const response = await allowed.request(3, "tools/call", { name: "test", arguments: { from: models.openai, to: [models.anthropic], max_usd: 1 } });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /cases/);
  await allowed.close();
});
