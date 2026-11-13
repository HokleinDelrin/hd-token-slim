/**
 * hd-token-slim — slim tool output before it enters the context.
 *
 * Zero dependencies, no I/O, no globals. Three pure string transforms plus one
 * guarded entry point. The transforms only touch *formatting* noise:
 *
 *   stripAnsi      remove ANSI escape sequences (colour, cursor moves, hyperlinks)
 *   foldRepeats    collapse runs of identical lines into `line  ×N`
 *   collapseBlank  collapse 3+ consecutive blank lines to 1, trim trailing spaces
 *
 * The interesting part is not the transforms, it is the guards. A slimmer that
 * silently drops the one line the model needed is worse than no slimmer at all,
 * so `slim()` is written to fail safe in every direction:
 *
 *   1. strings only      — anything that is not a string comes back untouched
 *   2. minBytes floor    — below the floor (default 2048 B) nothing is touched
 *   3. never throws      — any internal error returns the original text
 *   4. caller-owned skip — `read`-like tools are excluded by the caller (MCP proxy)
 *   5. structure kept    — non-repeated lines, line order, and the first/last
 *                          `protectHead`/`protectTail` lines are preserved verbatim
 *
 * Rule 5 is enforced inside foldRepeats: a run that touches the protected head
 * or tail region is never folded, because a `×N` there would re-describe lines
 * the caller asked us to leave alone.
 */

/* ANSI escape sequences, in three passes: OSC (hyperlinks, titles), CSI
 * (colour, cursor, erase), then any remaining two/three-byte ESC sequence.
 * Order matters — OSC starts with `ESC ]`, which the generic pattern would
 * otherwise eat one character at a time. */
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_ESC = /\u001b[@-Z\\-_]/g;

/** Defaults. Frozen so a caller cannot mutate them by accident. */
export const DEFAULTS = Object.freeze({
  /** Byte floor. Text below this is returned as-is, one byte unchanged. */
  minBytes: 2048,
  /** Fold runs of identical lines. */
  foldRepeats: true,
  /** Minimum run length before folding kicks in (clamped to >= 2). */
  repeatThreshold: 3,
  /** Strip ANSI escape sequences. */
  stripAnsi: true,
  /** Collapse 3+ blank lines and trim trailing spaces/tabs. */
  collapseBlank: true,
  /** Lines at the start that must never be folded. */
  protectHead: 3,
  /** Lines at the end that must never be folded. */
  protectTail: 3,
  /** Marker appended to a folded run. `{n}` is replaced by the run length. */
  foldMarker: "  \u00d7{n}",
});

/**
 * Remove ANSI escape sequences (colour, cursor movement, OSC hyperlinks, ...).
 * Pure, total: always returns a string.
 */
export function stripAnsi(text) {
  return String(text).replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(ANSI_ESC, "");
}

/**
 * Fold runs of >= `threshold` identical non-blank lines into one line plus a
 * `×N` marker.
 *
 * Guarantees:
 *   - every line that is not part of a folded run is emitted verbatim;
 *   - relative order is preserved (this is a single forward pass);
 *   - a run touching the protected head/tail region is never folded;
 *   - blank runs are left to `collapseBlank` so the two rules never disagree.
 *
 * Folding is lossless in content and exact in count: `foo  ×97` states that
 * there were exactly 97 identical `foo` lines, in that position. What is lost
 * is the absolute line numbering of everything after the run — which is why
 * `read`-style output is excluded at the caller and not here.
 *
 * @param {string} text
 * @param {{threshold?: number, protectHead?: number, protectTail?: number, marker?: string}} [opts]
 * @returns {string}
 */
export function foldRepeats(text, opts = {}) {
  const src = String(text);
  const threshold = Math.max(2, Math.trunc(opts.threshold ?? DEFAULTS.repeatThreshold));
  const protectHead = Math.max(0, Math.trunc(opts.protectHead ?? DEFAULTS.protectHead));
  const protectTail = Math.max(0, Math.trunc(opts.protectTail ?? DEFAULTS.protectTail));
  const marker = opts.marker ?? DEFAULTS.foldMarker;

  const lines = src.split("\n");
  const total = lines.length;
  const headEnd = protectHead;          // lines [0, headEnd) are never folded
  const tailStart = total - protectTail; // lines [tailStart, total) are never folded

  const out = [];
  const pushRepeated = (line, count) => {
    for (let k = 0; k < count; k += 1) out.push(line);
  };

  let i = 0;
  while (i < total) {
    const line = lines[i];
    let j = i + 1;
    while (j < total && lines[j] === line) j += 1;
    const run = j - i;

    // Split the run into [head-protected | foldable middle | tail-protected].
    // The protected parts are emitted verbatim so the first/last N lines of the
    // payload survive exactly as the caller wrote them.
    const headCount = Math.max(0, Math.min(run, headEnd - i));
    const tailCount = Math.max(0, Math.min(run - headCount, j - tailStart));
    const middle = run - headCount - tailCount;

    pushRepeated(line, headCount);

    const foldable = middle >= threshold && line.trim() !== "";
    if (foldable) out.push(line + marker.replace("{n}", String(middle)));
    else pushRepeated(line, middle);

    pushRepeated(line, tailCount);
    i = j;
  }
  return out.join("\n");
}

/**
 * Trim trailing spaces/tabs from every line and collapse runs of 3+ newlines
 * down to a single blank line.
 */
export function collapseBlank(text) {
  return String(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n");
}

/** UTF-8 byte length, without allocating a Buffer of the whole string twice. */
function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

/** Normalise caller options against DEFAULTS; never throws. */
export function resolveOptions(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  return {
    minBytes: Math.max(0, Math.trunc(num(o.minBytes, DEFAULTS.minBytes))),
    foldRepeats: o.foldRepeats ?? DEFAULTS.foldRepeats,
    repeatThreshold: Math.max(2, Math.trunc(num(o.repeatThreshold, DEFAULTS.repeatThreshold))),
    stripAnsi: o.stripAnsi ?? DEFAULTS.stripAnsi,
    collapseBlank: o.collapseBlank ?? DEFAULTS.collapseBlank,
    protectHead: Math.max(0, Math.trunc(num(o.protectHead, DEFAULTS.protectHead))),
    protectTail: Math.max(0, Math.trunc(num(o.protectTail, DEFAULTS.protectTail))),
    foldMarker: typeof o.foldMarker === "string" ? o.foldMarker : DEFAULTS.foldMarker,
  };
}

/**
 * The auditable entry point: same as `slim()` but reports what happened.
 *
 * Never throws. On any failure the original text comes back with
 * `applied: false` and a `reason` explaining the bail-out.
 *
 * @param {unknown} text
 * @param {object} [opts]
 * @returns {{text: string, applied: boolean, reason: string, beforeBytes: number,
 *            afterBytes: number, savedBytes: number, linesBefore: number, linesAfter: number}}
 */
export function slimDetailed(text, opts) {
  if (typeof text !== "string") {
    return {
      text,
      applied: false,
      reason: "not-a-string",
      beforeBytes: 0,
      afterBytes: 0,
      savedBytes: 0,
      linesBefore: 0,
      linesAfter: 0,
    };
  }

  const beforeBytes = byteLength(text);
  const bail = (reason) => ({
    text,
    applied: false,
    reason,
    beforeBytes,
    afterBytes: beforeBytes,
    savedBytes: 0,
    linesBefore: text.length ? text.split("\n").length : 0,
    linesAfter: text.length ? text.split("\n").length : 0,
  });

  try {
    const cfg = resolveOptions(opts);
    if (beforeBytes < cfg.minBytes) return bail("below-min-bytes");
    if (beforeBytes === 0) return bail("below-min-bytes");

    let next = text;
    if (cfg.stripAnsi) next = stripAnsi(next);
    if (cfg.foldRepeats) {
      next = foldRepeats(next, {
        threshold: cfg.repeatThreshold,
        protectHead: cfg.protectHead,
        protectTail: cfg.protectTail,
        marker: cfg.foldMarker,
      });
    }
    if (cfg.collapseBlank) next = collapseBlank(next);

    const afterBytes = byteLength(next);
    if (next === text) return bail("no-change");
    // A slimmer that grows the payload is a bug, not an optimisation.
    if (afterBytes >= beforeBytes) return bail("would-grow");

    return {
      text: next,
      applied: true,
      reason: "slimmed",
      beforeBytes,
      afterBytes,
      savedBytes: beforeBytes - afterBytes,
      linesBefore: text.split("\n").length,
      linesAfter: next.split("\n").length,
    };
  } catch {
    return bail("error");
  }
}

/**
 * Slim `text`. Returns a string, always. Non-strings come back unchanged so a
 * caller can pass through values it did not inspect.
 *
 * @param {unknown} text
 * @param {object} [opts] see DEFAULTS
 * @returns {string}
 */
export function slim(text, opts) {
  try {
    return slimDetailed(text, opts).text;
  } catch {
    return text;
  }
}

/**
 * Tool names whose output must never be touched: the model regularly needs exact
 * bytes and exact line numbers from file reads.
 */
const READ_TOOLS = new Set([
  "read",
  "read_file",
  "readfile",
  "read_text_file",
  "read_multiple_files",
  "readmedia_file",
  "read_media_file",
  "cat",
  "head",
  "tail",
  "view",
  "view_file",
  "open_file",
]);

/**
 * Should this tool's output be left alone?
 * Conservative: anything whose name mentions `read`, plus an explicit list.
 * Unknown/undefined names are *not* skipped — a slimmer that opts out on every
 * unfamiliar server saves nothing.
 */
export function isReadTool(toolName) {
  if (typeof toolName !== "string" || toolName === "") return false;
  const n = toolName.toLowerCase();
  if (READ_TOOLS.has(n)) return true;
  return /(^|[_\-.])read([_\-.]|$)|^read/.test(n);
}

/** Rough token estimate used for CLI stats only (3 bytes ≈ 1 token, as in the source). */
export function estimateTokens(bytes) {
  return Math.round(bytes / 3);
}

export default slim;
