/**
 * Tests for the slim core. Run with: node --test
 *
 * The interesting assertions here are the *negative* ones: short input, non-string
 * input, thrown options, and read-like tool names must all come back untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  slim,
  slimDetailed,
  stripAnsi,
  foldRepeats,
  collapseBlank,
  resolveOptions,
  isReadTool,
  estimateTokens,
  DEFAULTS,
} from "../src/slim.mjs";

/** 0-based folding so tiny fixtures stay readable. */
const raw = { minBytes: 0, protectHead: 0, protectTail: 0 };
const ANSI_RED = "\u001b[31m";
const RESET = "\u001b[0m";

test("short text below minBytes is returned byte-identical", () => {
  const input = `${ANSI_RED}red${RESET}\n\n\n\nsame\nsame\nsame\nsame\n`;
  assert.ok(Buffer.byteLength(input) < DEFAULTS.minBytes);
  assert.equal(slim(input), input, "default floor must not touch it");
  assert.equal(slim(input, { minBytes: 10_000 }), input);

  const r = slimDetailed(input, { minBytes: 10_000 });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "below-min-bytes");
  assert.equal(r.text, input);
  assert.equal(r.savedBytes, 0);
});

test("runs of identical lines fold into a single line with an ×N marker", () => {
  const lines = [...Array(100).fill("connection refused")];
  const input = lines.join("\n");
  const out = slim(input, { ...raw, collapseBlank: false });
  assert.equal(out.split("\n").length, 1);
  assert.equal(out, "connection refused  ×100");
});

test("folding is exact: the marker states the real run length", () => {
  const input = ["a", "a", "a", "b", "c", "c", "c", "c", "c"].join("\n");
  const out = foldRepeats(input, { threshold: 3, protectHead: 0, protectTail: 0 });
  assert.equal(out, "a  ×3\nb\nc  ×5");
});

test("runs shorter than the threshold are left alone", () => {
  const input = ["x", "x", "y", "y", "y"].join("\n"); // threshold 3
  const out = foldRepeats(input, { threshold: 3, protectHead: 0, protectTail: 0 });
  assert.equal(out, "x\nx\ny  ×3");
});

test("blank runs are handed to collapseBlank, not folded", () => {
  const input = ["a", "", "", "", "", "b"].join("\n");
  const folded = foldRepeats(input, { threshold: 3, protectHead: 0, protectTail: 0 });
  assert.equal(folded, input, "blank runs must not gain an ×N marker");
  assert.equal(collapseBlank(input), "a\n\nb");
});

test("ANSI escape sequences are stripped", () => {
  const input = `${ANSI_RED}error${RESET}: boom and \u001b[1;32mok\u001b[0m and \u001b]8;;http://x\u0007link\u001b]8;;\u0007`;
  assert.equal(stripAnsi(input), "error: boom and ok and link");
  // and end to end, with the floor disabled
  const big = `${ANSI_RED}${"pad ".repeat(700)}${RESET}`;
  const out = slim(big, raw);
  assert.ok(!out.includes("\u001b["), "no escape sequences survive");
});

test("line order and all non-repeated lines are preserved", () => {
  const input = [
    "header", "alpha", "alpha", "alpha", "beta", "gamma", "gamma",
    "delta", "gamma", "omega", "footer",
  ].join("\n");
  const out = slim(input, { ...raw, collapseBlank: false });
  const outLines = out.split("\n");
  assert.deepEqual(outLines, [
    "header", "alpha  ×3", "beta", "gamma", "gamma", "delta", "gamma", "omega", "footer",
  ]);
  // every output line still appears in the input, in non-decreasing position
  const inLines = input.split("\n");
  const seen = outLines.map((l) => l.replace(/  ×\d+$/, ""));
  let p = 0;
  for (const line of seen) {
    const idx = inLines.indexOf(line, p);
    assert.ok(idx >= 0, `order broke at ${JSON.stringify(line)}`);
    p = idx; // a folded line represents several identical inputs at/after p
  }
});

test("head and tail protection keeps the first/last lines un-folded", () => {
  const input = ["h", "h", "h", ...Array(50).fill("m"), "t", "t", "t"].join("\n");
  const out = slim(input, { minBytes: 0 }); // default protectHead/Tail = 3
  const lines = out.split("\n");
  assert.deepEqual(lines.slice(0, 3), ["h", "h", "h"], "head untouched");
  assert.deepEqual(lines.slice(-3), ["t", "t", "t"], "tail untouched");
  assert.ok(lines.includes("m  ×50"), "middle folded");
});

test("a run that starts in the head window is split, not silently reshaped", () => {
  // 10 identical lines: 3 kept (head), 7 folded with the exact remaining count.
  const input = Array(10).fill("same").join("\n");
  const out = foldRepeats(input, { threshold: 3, protectHead: 3, protectTail: 3 });
  assert.equal(out, ["same", "same", "same", "same  \u00d74", "same", "same", "same"].join("\n"));
});

test("trailing whitespace is trimmed only on lines that survive", () => {
  const input = `a   \nb\t\t\n\n\n\nc`;
  assert.equal(collapseBlank(input), "a\nb\n\nc");
});

test("non-string input comes back unchanged (same value, same reference)", () => {
  for (const value of [undefined, null, 0, 42, true, Symbol.for("s"), { a: 1 }, ["a"], () => 1]) {
    assert.equal(slim(value), value);
    assert.equal(slimDetailed(value).applied, false);
    assert.equal(slimDetailed(value).reason, "not-a-string");
  }
  const buf = Buffer.from("x".repeat(9999));
  assert.equal(slim(buf), buf);
});

test("a throwing options object never escapes: original text is returned", () => {
  const input = "z".repeat(4000);
  const hostile = {
    get minBytes() {
      throw new Error("boom");
    },
  };
  const r = slimDetailed(input, hostile);
  assert.equal(r.applied, false);
  assert.equal(r.reason, "error");
  assert.equal(r.text, input);
  assert.equal(slim(input, hostile), input);
});

test("output never grows", () => {
  const input = "very short but above a zero floor";
  const r = slimDetailed(input, { minBytes: 0 });
  assert.ok(r.afterBytes <= r.beforeBytes);
  if (!r.applied) assert.equal(r.text, input);
});

test("resolveOptions clamps nonsense instead of trusting it", () => {
  const o = resolveOptions({
    minBytes: -5,
    repeatThreshold: 0,
    protectHead: Number.NaN,
    foldMarker: 42,
    stripAnsi: "yes",
  });
  assert.equal(o.minBytes, 0);
  assert.equal(o.repeatThreshold, 2);
  assert.equal(o.protectHead, DEFAULTS.protectHead);
  assert.equal(o.foldMarker, DEFAULTS.foldMarker);
  assert.equal(o.stripAnsi, "yes");
});

test("read-like tool names are recognised, unknown names are not skipped", () => {
  for (const name of ["read", "read_file", "ReadFile", "read_text_file", "read_multiple_files", "cat", "head", "tail", "view"]) {
    assert.equal(isReadTool(name), true, name);
  }
  for (const name of ["grep", "pwsh", "bash", "web_fetch", "search_files", "list_directory", "", undefined, 42]) {
    assert.equal(isReadTool(name), false, String(name));
  }
});

test("token estimate matches the 3-bytes-per-token convention", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(3), 1);
  assert.equal(estimateTokens(3000), 1000);
});

test("stats are self-consistent on a realistic payload", () => {
  const noisy = Array.from({ length: 400 }, (_, i) => `  retrying step ${Math.floor(i / 10)}   `).join("\n");
  const r = slimDetailed(noisy, { minBytes: 0 });
  assert.equal(r.applied, true);
  assert.equal(r.beforeBytes, Buffer.byteLength(noisy, "utf8"));
  assert.equal(r.afterBytes, Buffer.byteLength(r.text, "utf8"));
  assert.equal(r.savedBytes, r.beforeBytes - r.afterBytes);
  assert.ok(r.savedBytes > 0);
  assert.ok(r.linesAfter < r.linesBefore);
});
