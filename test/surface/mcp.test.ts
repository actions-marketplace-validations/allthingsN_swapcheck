import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { LineFramer, MAX_MESSAGE_BYTES, McpSession, serve } from "../../src/mcp/server.ts";
import { listTools } from "../../src/mcp/tools.ts";

const context = { offline: true, env: {} as NodeJS.ProcessEnv };
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

test("initialize echoes a supported version and reports tools", async () => {
  const response = await new McpSession(context).handle(init);
  const result = response?.result as { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } };
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.ok(result.capabilities.tools);
  assert.equal(result.serverInfo.name, "swapcheck");
});

test("an unknown protocol version gets the server's newest", async () => {
  const response = await new McpSession(context).handle({ ...init, params: { protocolVersion: "1999-01-01" } });
  assert.equal((response?.result as { protocolVersion: string }).protocolVersion, "2025-11-25");
});

test("requests before initialize are refused, but ping is allowed", async () => {
  const session = new McpSession(context);
  assert.equal((await session.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }))?.error?.code, -32002);
  assert.deepEqual((await session.handle({ jsonrpc: "2.0", id: 3, method: "ping" }))?.result, {});
});

test("notifications get no reply", async () => {
  assert.equal(await new McpSession(context).handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("malformed messages get protocol errors, never a crash", async () => {
  const session = new McpSession(context);
  await session.handle(init);
  for (const bad of [null, 1, "x", [], {}, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1, method: 7 }]) {
    assert.equal((await session.handle(bad))?.error?.code, -32600);
  }
  assert.equal((await session.handle({ jsonrpc: "2.0", id: {}, method: "ping" }))?.error?.code, -32600);
  assert.equal((await session.handle({ jsonrpc: "2.0", id: 4, method: "ping", params: 5 }))?.error?.code, -32602);
  assert.equal((await session.handle({ jsonrpc: "2.0", id: 5, method: "nope" }))?.error?.code, -32601);
  assert.equal((await session.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: {} }))?.error?.code, -32602);
  assert.equal((await session.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "scan", arguments: 3 } }))?.error?.code, -32602);
  assert.equal((await session.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "nope" } }))?.error?.code, -32602);
});

test("responses to our own requests are ignored", async () => {
  assert.equal(await new McpSession(context).handle({ jsonrpc: "2.0", id: 9, result: {} }), null);
});

test("paid tools are hidden and uncallable without the opt-in", async () => {
  assert.deepEqual(listTools({}).map((t) => t.name), ["scan", "watch", "find", "explain_event"]);
  assert.ok(listTools({ SWAPCHECK_MCP_ALLOW_SPEND: "1" }).some((t) => t.name === "test"));
  assert.ok(!listTools({ SWAPCHECK_MCP_ALLOW_SPEND: "true" }).some((t) => t.name === "test"));
  const session = new McpSession(context);
  await session.handle(init);
  const response = await session.handle({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "test", arguments: { from: "a", to: ["b"], max_usd: 1, confirm: true } } });
  assert.equal(response?.error?.code, -32602);
});

test("the framer splits lines across chunks and ignores blank ones", () => {
  const lines: string[] = [];
  const framer = new LineFramer((l) => lines.push(l), () => assert.fail("not oversize"));
  framer.push(Buffer.from('{"a":'));
  framer.push(Buffer.from('1}\n\n{"b":2}\n'));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("the framer keeps multi-byte characters split across chunks intact", () => {
  const lines: string[] = [];
  const framer = new LineFramer((l) => lines.push(l), () => assert.fail("not oversize"));
  const bytes = Buffer.from("é\n");
  framer.push(bytes.subarray(0, 1));
  framer.push(bytes.subarray(1));
  assert.deepEqual(lines, ["é"]);
});

test("an oversized line is dropped once, and the next line still works", () => {
  const lines: string[] = [];
  let oversize = 0;
  const framer = new LineFramer((l) => lines.push(l), () => oversize++);
  framer.push(Buffer.alloc(MAX_MESSAGE_BYTES + 10, 0x61));
  framer.push(Buffer.alloc(MAX_MESSAGE_BYTES, 0x61));
  framer.push(Buffer.from('\n{"ok":1}\n'));
  assert.equal(oversize, 1);
  assert.deepEqual(lines, ['{"ok":1}']);
});

test("serve answers bad JSON and batches, then keeps going", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8").on("data", (d: string) => (text += d));
  const done = serve({ ...context, input, output });
  input.write("not json\n");
  input.write("[1,2]\n");
  input.write(`${JSON.stringify(init)}\n`);
  input.end();
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  const replies = text.trim().split("\n").map((l) => JSON.parse(l) as { error?: { code: number }; id: unknown });
  assert.equal(replies[0]?.error?.code, -32700);
  assert.equal(replies[1]?.error?.code, -32600);
  assert.equal(replies[2]?.id, 1);
});
