/**
 * Minimal MCP-ish stdio server used by the proxy tests.
 *
 * It answers two JSON-RPC methods over newline-delimited JSON:
 *   initialize  -> a canned result
 *   tools/call  -> one text block containing the shared noisy payload
 *
 * The proxy's "never touch read" rule is asserted by calling the same payload
 * through a `grep`-style name and a `read_file` name and comparing bytes.
 */
import readline from "node:readline";
import { noisyPayload } from "./payload.mjs";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object" || msg.method === undefined) return;

  if (msg.method === "initialize") {
    reply(msg.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "0" } });
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params?.name ?? "";
    reply(msg.id, { content: [{ type: "text", text: noisyPayload() }], isError: false, servedBy: name });
    return;
  }
  if (msg.method === "emit-raw") {
    // some servers log to stdout; that traffic is not JSON-RPC and must be relayed
    process.stdout.write("plain text from upstream\n");
    reply(msg.id, { ok: true });
    return;
  }
  reply(msg.id, { ok: true });
});

rl.on("close", () => process.exit(0));

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
