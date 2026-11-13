# adapters/dsh — example adapters, not the product

These three plugins are adapted from the upstream project they were extracted
from — machine-specific paths and host version notes were generalised for
publication, and the wiring itself was left alone. They are here as examples of
what "wiring the core into a host" looks like, and as an honest record of where
generalisation stops. They ship inside the npm tarball as examples, but they are
not part of the supported API surface of `hd-token-slim`.

| directory | wires | portable? |
|---|---|---|
| `token-diet/` | three pure string functions on a post-execute tool hook | **yes** — the core is `src/slim.mjs`, this is the 145-line shim |
| `tool-sentinel/` | host session counters + a system-prompt injection point | **no** — depends on four host APIs |
| `handoff-watch/` | host session token accounting + reminder injection | **no** — same reason |

## Why `token-diet` is the only one that was extracted

`token-diet/index.js` has **zero imports**: `stripAnsi`, `foldRepeats` and
`collapseBlank` are pure string functions, and the host appears only as
`ctx.on(...)` and `ctx.logger` inside `apply()`. Everything above that line
ported to `src/slim.mjs` unchanged, and the MCP proxy exercises it without a
host at all.

`tool-sentinel` and `handoff-watch` are bound to `tools/post-execute`,
`agent/pre-step`, `systemPrompt.context` and, for `handoff-watch`, a token meter.
Strip those and what is left is a byte counter with nothing to count — a generic
rewrite would be a tool nobody can run. They stay here untouched on purpose.

## Using them

Copy the directory into a host profile, point the host's plugin loader at
`index.js`, and check that host's own documentation for how bundles and hooks are
declared (each directory carries a `cordis.patch.yml` recorded from the original
setup). Nothing in this repository installs them for you.

## Note on paths

Paths in these files are placeholders, not a record of anyone's machine:
`<DSH_HOME>` is the host's home directory (the one holding `profiles/` and
`tools/`), `<profile>` is the name of the profile directory, and
`<PATH_TO_ADAPTER>` is wherever you put this `adapters/` tree. Fill them in for
your own setup.
