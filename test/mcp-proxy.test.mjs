/**
 * End-to-end proxy tests: a real child process pair (claude-side test -> proxy ->
 * fake MCP server), newline-delimited JSON in both directions.
 *
 * What must hold:
 *   - tools/call text results are slimmed;
 *   - `read_file` responses are byte-identical to what the upstream sent;
 *   - non-tools/call traffic (initialize, unknown methods) passes through.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { noisyPayload } from "../fixtures/payload.mjs";

const PROXY = fileURLToPath(new URL("../bin/mcp-proxy.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("../fixtures/fake-server.mjs", import.meta.url));

function session(requests, { extraArgs = [], timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [PROXY, ...extraArgs, "--upstream", process.execPath, FAKE],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`proxy timeout\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => {
      clearTimeout(timer);
      const messages = stdout
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l));
      resolve({ messages, stderr });
    });

    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    child.stdin.end();
  });
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
const grepCall = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "grep", arguments: { pattern: "x" } } };
const readCall = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: { path: "/x" } } };

test("proxy slims tools/call text and leaves read-style tools alone", async () => {
  const { messages, stderr } = await session([initialize, grepCall, readCall]);
  assert.equal(stderr.includes("mcp-proxy: upstream failed"), false, stderr);
  assert.equal(messages.length, 3, `unexpected output: ${JSON.stringify(messages).slice(0, 400)}`);

  const [init, grep, read] = messages;

  // untouched traffic
  assert.equal(init.id, 1);
  assert.equal(init.result.serverInfo.name, "fake");

  // slimmed: 120 identical lines, the first 3 kept verbatim by head protection,
  // the remaining 117 folded with an exact count.
  const grepText = grep.result.content[0].text;
  assert.ok(grepText.includes("warning: deprecated option  \u00d7117"), "repeats folded with exact count");
  assert.equal(grepText.split("warning: deprecated option").length - 1, 4, "3 protected + 1 marker");
  assert.ok(!grepText.includes("\u001b["), "ansi stripped");
  assert.ok(Buffer.byteLength(grepText) < Buffer.byteLength(noisyPayload()), "smaller");
  assert.equal(grep.result.isError, false, "other result fields survive");
  assert.equal(grep.result.servedBy, "grep");

  // byte-identical for read_file
  assert.equal(read.result.content[0].text, noisyPayload());
  assert.equal(read.id, 3);
});

test("proxy relays upstream lines it cannot parse instead of dropping them", async () => {
  const child = spawn(process.execPath, [PROXY, "--upstream", process.execPath, FAKE], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => { out += d; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "emit-raw" })}\n`);
  child.stdin.end();
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0);
  assert.ok(out.includes("plain text from upstream"), "non-JSON line survived");
  assert.ok(out.includes('"id":9'), "and the JSON response still arrived");
});

test("--skip disables slimming for named tools, --min-bytes does not touch small payloads", async () => {
  const skipped = await session([grepCall], { extraArgs: ["--skip", "grep"] });
  assert.equal(skipped.messages[0].result.content[0].text, noisyPayload(), "--skip leaves it alone");

  const highFloor = await session([grepCall], { extraArgs: ["--min-bytes", "1000000"] });
  assert.equal(highFloor.messages[0].result.content[0].text, noisyPayload(), "floor respected");
});
