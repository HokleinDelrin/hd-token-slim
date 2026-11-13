#!/usr/bin/env node
/**
 * mcp-proxy — a stdio MCP proxy that slims `tools/call` text results in flight.
 *
 *   node bin/mcp-proxy.mjs --upstream "npx -y @modelcontextprotocol/server-filesystem /path"
 *
 * The proxy speaks JSON-RPC 2.0 over newline-delimited JSON on both ends. It is
 * transparent for everything except one case:
 *
 *   a response to a `tools/call` request whose `result.content[]` contains
 *   `{type:"text"}` blocks  ->  each block's `text` goes through `slim()`
 *
 * Everything else — initialize, tools/list, notifications, resources/*,
 * prompts/*, server->client requests, malformed lines, unparsable JSON — is
 * forwarded byte-for-byte. `read`-style tools are never touched (see
 * `isReadTool`), because the model frequently needs exact bytes and line
 * numbers from a file read.
 *
 * stdout belongs to the JSON-RPC stream: all diagnostics go to stderr.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import readline from "node:readline";
import { slimDetailed, resolveOptions, isReadTool, estimateTokens, DEFAULTS } from "../src/slim.mjs";

const HELP = `mcp-proxy — stdio MCP proxy that slims tools/call text results

Usage:
  mcp-proxy --upstream "<command with args>"
  mcp-proxy --upstream <cmd> [args...]

Options:
  --upstream <cmd>       upstream MCP server command (required). One quoted string,
                         or every following token up to the next --flag.
  --min-bytes <n>        byte floor for slimming (default ${DEFAULTS.minBytes})
  --repeat-threshold <n> minimum identical-run length to fold (default ${DEFAULTS.repeatThreshold})
  --protect-head <n>     lines at the start never folded (default ${DEFAULTS.protectHead})
  --protect-tail <n>     lines at the end never folded (default ${DEFAULTS.protectTail})
  --no-ansi              keep ANSI escape sequences
  --no-fold              keep runs of identical lines
  --no-blank             keep blank runs and trailing whitespace
  --skip <names>         extra comma-separated tool names to leave untouched
  --stats                print a summary to stderr on exit
  --verbose              log every slimmed response to stderr
  -h, --help             this text
  -v, --version          print version

Example claude_desktop_config.json:
  {
    "mcpServers": {
      "filesystem-slim": {
        "command": "node",
        "args": ["<path>/bin/mcp-proxy.mjs", "--upstream",
                 "npx -y @modelcontextprotocol/server-filesystem /path"]
      }
    }
  }
`;

/** Split a command string into argv, honouring single/double quotes and backslash escapes. */
function tokenize(input) {
  const out = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === "\\" && quote === '"' && i + 1 < input.length) { cur += input[++i]; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === "\\" && i + 1 < input.length) { cur += input[++i]; has = true; continue; }
    if (/\s/.test(ch)) {
      if (cur !== "" || has) { out.push(cur); cur = ""; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (cur !== "" || has) out.push(cur);
  return out;
}

function parseArgs(argv) {
  const opts = {};
  let upstream = null;
  let stats = false;
  let verbose = false;
  const skip = new Set();

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { process.stdout.write(HELP); process.exit(0); }
    if (a === "-v" || a === "--version") {
      process.stdout.write(`${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version}\n`);
      process.exit(0);
    }
    if (a === "--stats") { stats = true; continue; }
    if (a === "--verbose") { verbose = true; continue; }
    if (a === "--no-ansi") { opts.stripAnsi = false; continue; }
    if (a === "--no-fold") { opts.foldRepeats = false; continue; }
    if (a === "--no-blank") { opts.collapseBlank = false; continue; }
    if (a === "--min-bytes") { opts.minBytes = Number(argv[++i]); continue; }
    if (a === "--repeat-threshold") { opts.repeatThreshold = Number(argv[++i]); continue; }
    if (a === "--protect-head") { opts.protectHead = Number(argv[++i]); continue; }
    if (a === "--protect-tail") { opts.protectTail = Number(argv[++i]); continue; }
    if (a === "--skip") {
      for (const n of String(argv[++i] ?? "").split(",")) if (n.trim()) skip.add(n.trim().toLowerCase());
      continue;
    }
    if (a === "--upstream") {
      const parts = [];
      let j = i + 1;
      while (j < argv.length && !argv[j].startsWith("--")) { parts.push(argv[j]); j += 1; }
      i = j - 1;
      if (parts.length === 0) fail("--upstream needs a command");
      upstream = parts.length === 1 ? tokenize(parts[0]) : parts;
      continue;
    }
    fail(`unknown option ${a}`);
  }
  if (!upstream || upstream.length === 0) fail("--upstream is required");
  return { upstream, opts, stats, verbose, skip };
}

function fail(msg) {
  process.stderr.write(`mcp-proxy: ${msg}\n\n${HELP}`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const slimOpts = resolveOptions(args.opts);
const log = (msg) => process.stderr.write(`mcp-proxy: ${msg}\n`);

/** Quote one token for a Windows shell command line. */
function quoteWin(token) {
  if (token === "") return '""';
  if (!/[\s"&|<>^()]/.test(token)) return token;
  return `"${token.replace(/"/g, '\\"')}"`;
}

/** Spawn the upstream server. On Windows a string command goes through cmd.exe. */
function spawnUpstream(argv) {
  const [cmd, ...rest] = argv;
  if (process.platform === "win32") {
    const line = [cmd, ...rest].map(quoteWin).join(" ");
    return spawn(line, { shell: true, windowsHide: true, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  }
  return spawn(cmd, rest, { windowsHide: true, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
}

const child = spawnUpstream(args.upstream);

let requests = 0;
let responses = 0;
let slimmed = 0;
let savedTotal = 0;
let blocks = 0;

/** id -> {method, tool} for requests we forwarded and still await a response for. */
const pending = new Map();
const MAX_PENDING = 2000;

const idKey = (id) => (id === undefined ? null : `${typeof id}:${JSON.stringify(id)}`);

/** Apply slim to one tools/call result. Returns {result, changed, savedBytes}. */
function slimResult(result) {
  if (!result || typeof result !== "object") return { result, changed: false, saved: 0 };
  const content = result.content;
  if (!Array.isArray(content)) return { result, changed: false, saved: 0 };

  let changed = false;
  let saved = 0;
  const next = content.map((block) => {
    if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") return block;
    const r = slimDetailed(block.text, slimOpts);
    if (!r.applied) return block;
    changed = true;
    saved += r.savedBytes;
    return { ...block, text: r.text };
  });
  if (!changed) return { result, changed: false, saved: 0 };
  return { result: { ...result, content: next }, changed: true, saved };
}

/** Handle one line coming from the upstream server. */
function onServerLine(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    // Not JSON — forward untouched (some servers log to stdout; not our business).
    process.stdout.write(`${raw}\n`);
    return;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.id === undefined || typeof msg.method === "string") {
    // notification / server->client request / batch / odd payload: forward as-is
    process.stdout.write(`${raw}\n`);
    return;
  }

  responses += 1;
  const key = idKey(msg.id);
  const req = pending.get(key);
  if (!req) {
    process.stdout.write(`${raw}\n`);
    return;
  }
  pending.delete(key);

  if (req.method !== "tools/call" || msg.error) {
    process.stdout.write(`${raw}\n`);
    return;
  }

  const tool = req.tool ?? "";
  const skip = args.skip.has(String(tool).toLowerCase()) || isReadTool(tool);
  if (skip) {
    if (args.verbose) log(`skip ${tool} (read-like or --skip)`);
    process.stdout.write(`${raw}\n`);
    return;
  }

  try {
    const { result, changed, saved } = slimResult(msg.result);
    if (!changed) {
      process.stdout.write(`${raw}\n`);
      return;
    }
    blocks += 1;
    slimmed += 1;
    savedTotal += saved;
    const out = JSON.stringify({ ...msg, result });
    process.stdout.write(`${out}\n`);
    if (args.verbose) {
      log(`slimmed ${tool || "(unnamed)"}: -${saved} B (~${estimateTokens(saved)} tok)`);
    }
  } catch (error) {
    log(`slim failed, forwarding original: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`${raw}\n`);
  }
}

/** Handle one line coming from the client. Records tools/call ids, forwards verbatim. */
function onClientLine(raw) {
  try {
    const msg = JSON.parse(raw);
    if (msg && typeof msg === "object" && !Array.isArray(msg) && typeof msg.method === "string" && msg.id !== undefined) {
      requests += 1;
      const key = idKey(msg.id);
      const tool = msg.method === "tools/call" ? msg.params?.name : undefined;
      pending.set(key, { method: msg.method, tool });
      if (pending.size > MAX_PENDING) {
        const oldest = pending.keys().next().value;
        pending.delete(oldest);
      }
    }
  } catch {
    // not JSON, forward as-is
  }
  try {
    child.stdin.write(`${raw}\n`);
  } catch {
    // upstream already gone; nothing to forward to
  }
}

// ---- client -> upstream ----------------------------------------------------
const clientIn = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

// ---- upstream -> client ----------------------------------------------------
const serverOut = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

child.on("error", (error) => {
  log(`upstream failed to start: ${error.message}`);
  process.exit(1);
});
// 'close' fires after the upstream's stdio has drained, so the last response
// is not truncated on the way out.
child.on("close", (code, signal) => {
  if (args.stats) {
    log(`exit upstream code=${code} signal=${signal} | requests=${requests} responses=${responses} ` +
      `slimmed=${slimmed} blocks=${blocks} saved=${savedTotal} B (~${estimateTokens(savedTotal)} tok)`);
  }
  process.exit(typeof code === "number" ? code : 0);
});

clientIn.on("line", onClientLine);
clientIn.on("close", () => {
  try { child.stdin.end(); } catch { /* upstream already gone */ }
});

serverOut.on("line", onServerLine);

// upstream stderr is diagnostic, not protocol
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

process.on("SIGINT", () => { try { child.kill(); } catch { /* ignore */ } process.exit(130); });
process.on("SIGTERM", () => { try { child.kill(); } catch { /* ignore */ } process.exit(143); });
