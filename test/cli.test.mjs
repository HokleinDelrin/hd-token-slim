/**
 * CLI tests: stdin -> stdout, --stats on stderr, --json on stdout, exit codes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SLIM = fileURLToPath(new URL("../bin/slim.mjs", import.meta.url));

const run = (args, input) => spawnSync(process.execPath, [SLIM, ...args], { input, encoding: "utf8" });

const noisy = [
  "=== build log ===",
  "$ pnpm run build",
  "",
  ...Array.from({ length: 300 }, () => "  \u001b[31mwarning\u001b[0m: retrying  "),
  "",
  "",
  "",
  "",
  ...Array.from({ length: 100 }, (_, i) => `step ${i}`),
].join("\n");

test("stdout gets the slimmed text and nothing else", () => {
  const r = run(["--min-bytes", "0"], noisy);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /warning: retrying\s+\u00d7300/, "300 identical lines folded");
  assert.ok(!r.stdout.includes("\u001b["), "ansi stripped");
  assert.ok(r.stdout.includes("=== build log ==="), "head survives");
  assert.ok(r.stdout.includes("step 99"), "tail survives");
  assert.equal(r.stderr, "", "no noise on stderr without --stats");
});

test("--stats reports on stderr, leaving stdout pipeable", () => {
  const r = run(["--min-bytes", "0", "--stats"], noisy);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /slim: slimmed \d+ B -> \d+ B \(-[\d.]+%, ~\d+ tokens saved @3 B\/tok\)/);
  assert.ok(r.stdout.length < noisy.length);
});

test("--json is machine readable and carries the text", () => {
  const r = run(["--min-bytes", "0", "--json"], noisy);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.applied, true);
  assert.equal(parsed.reason, "slimmed");
  assert.equal(parsed.afterBytes, Buffer.byteLength(parsed.text, "utf8"));
  assert.equal(parsed.savedBytes, parsed.beforeBytes - parsed.afterBytes);
  assert.ok(parsed.text.includes("×300"));
});

test("short input passes through untouched by default", () => {
  const input = "hi\n\n\n\nhi\n";
  const r = run([], input);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, input);
});

test("--help exits 0 and documents the floor", () => {
  const r = run(["--help"], "");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--min-bytes/);
});

test("missing input file exits non-zero with a stderr message", () => {
  const r = run(["./definitely-not-here.log"], "");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /slim:/);
});

test("unknown flag exits 2", () => {
  const r = run(["--nope"], "");
  assert.equal(r.status, 2);
});
