/**
 * Shared fixture payload. Kept separate from the fake server so tests can import
 * it without starting a stdin loop.
 *
 * 120 identical ANSI-coloured warnings (foldable, strippable), a blank run, and
 * 200 distinct lines to push the whole thing past the 2048-byte floor.
 */
export const ANSI_RED = "\u001b[31m";
export const ANSI_RESET = "\u001b[0m";

export function noisyPayload() {
  const lines = [];
  for (let i = 0; i < 120; i += 1) lines.push(`${ANSI_RED}warning: deprecated option${ANSI_RESET}`);
  lines.push("", "", "", "done");
  for (let i = 0; i < 200; i += 1) lines.push(`unique line ${i} ${"x".repeat(8)}`);
  return lines.join("\n");
}
