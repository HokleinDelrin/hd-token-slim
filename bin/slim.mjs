#!/usr/bin/env node
/**
 * slim — stdin -> stdout text slimmer.
 *
 *   cat huge.log | node bin/slim.mjs --stats > slim.log
 *   node bin/slim.mjs --min-bytes 512 < build.log
 *   node bin/slim.mjs --json < out.txt | jq -r .text
 *
 * stdout carries the slimmed text and nothing else, so it stays pipeable.
 * `--stats` and `--verbose` write to stderr.
 */
import { readFileSync } from "node:fs";
import { slimDetailed, resolveOptions, estimateTokens, DEFAULTS } from "../src/slim.mjs";

const HELP = `slim — strip formatting noise from agent tool output before it enters context

Usage:
  cat file | slim [options]
  slim [options] [file]

Options:
  --min-bytes <n>      byte floor; text below it is passed through untouched (default ${DEFAULTS.minBytes})
  --no-ansi            keep ANSI escape sequences
  --no-fold            keep runs of identical lines
  --repeat-threshold <n>  minimum run length to fold (default ${DEFAULTS.repeatThreshold})
  --no-blank           keep blank-line runs and trailing whitespace
  --protect-head <n>   lines at the start never folded (default ${DEFAULTS.protectHead})
  --protect-tail <n>   lines at the end never folded (default ${DEFAULTS.protectTail})
  --stats              print before/after bytes and token estimate to stderr
  --json               print a JSON object {applied, reason, text, ...} to stdout
  -h, --help           this text
  -v, --version        print version

Exit codes: 0 on success (including "nothing to do"), 1 on read error.
`;

function parseArgs(argv) {
  const opts = {};
  let stats = false;
  let json = false;
  let file = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      i += 1;
      return v;
    };
    switch (a) {
      case "--min-bytes": opts.minBytes = Number(next()); break;
      case "--repeat-threshold": opts.repeatThreshold = Number(next()); break;
      case "--protect-head": opts.protectHead = Number(next()); break;
      case "--protect-tail": opts.protectTail = Number(next()); break;
      case "--no-ansi": opts.stripAnsi = false; break;
      case "--no-fold": opts.foldRepeats = false; break;
      case "--no-blank": opts.collapseBlank = false; break;
      case "--stats": stats = true; break;
      case "--json": json = true; break;
      case "-h": case "--help": process.stdout.write(HELP); process.exit(0); break;
      case "-v": case "--version": {
        const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        process.stdout.write(`${pkg.version}\n`);
        process.exit(0);
        break;
      }
      default:
        if (a.startsWith("-")) {
          process.stderr.write(`slim: unknown option ${a}\n`);
          process.exit(2);
        }
        if (file !== null) {
          process.stderr.write("slim: only one input file is accepted\n");
          process.exit(2);
        }
        file = a;
    }
  }
  return { opts, stats, json, file };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function pct(saved, before) {
  if (before === 0) return "0.0";
  return ((saved / before) * 100).toFixed(1);
}

const args = parseArgs(process.argv.slice(2));

try {
  const input = args.file ? readFileSync(args.file, "utf8") : await readStdin();
  const result = slimDetailed(input, args.opts);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      applied: result.applied,
      reason: result.reason,
      beforeBytes: result.beforeBytes,
      afterBytes: result.afterBytes,
      savedBytes: result.savedBytes,
      savedPct: Number(pct(result.savedBytes, result.beforeBytes)),
      tokensSavedEstimate: estimateTokens(result.savedBytes),
      linesBefore: result.linesBefore,
      linesAfter: result.linesAfter,
      options: resolveOptions(args.opts),
      text: result.text,
    })}\n`);
  } else {
    process.stdout.write(result.text);
  }

  if (args.stats) {
    const est = estimateTokens(result.savedBytes);
    const delta = result.savedBytes > 0 ? `-${pct(result.savedBytes, result.beforeBytes)}%` : "0.0%";
    process.stderr.write(
      `slim: ${result.applied ? result.reason : "no-op (" + result.reason + ")"} ` +
      `${result.beforeBytes} B -> ${result.afterBytes} B ` +
      `(${delta}, ~${est} tokens saved @3 B/tok)\n`,
    );
  }
} catch (error) {
  process.stderr.write(`slim: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
