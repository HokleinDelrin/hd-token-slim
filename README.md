# hd-token-slim

**Slim agent tool output before it enters context — strip ANSI, fold repeated lines, collapse blank runs. Zero dependencies, zero imports, never throws.**

Every time an agent runs a tool, the result lands in the context window and stays there — re-sent, re-billed, on every following step. A single noisy tool result is not a one-time cost; it is rent. `hd-token-slim` removes the part of that output that carries no information: colour escapes, the same line printed 400 times, five blank lines in a row.

It is deliberately small. Three pure string functions and a guarded entry point. No config file, no daemon, no dependencies, no network calls.

---

## One real measurement (inputs not in this repo)

Measured once on real local files; the inputs are not in this repo, so the absolute numbers are not reproducible. Only the synthetic row below can be reproduced from a clean clone.

```bash
node bin/slim.mjs --stats path/to/file
```

| input | before | after | saved |
|---|---|---|---|
| service log, 6,297 lines | 283,824 B | 272,443 B | **−4.0 %** (≈3,794 tok) |
| heartbeat log, repeated lines | 477,186 B | 420,337 B | **−11.9 %** (≈18,950 tok) |
| prose with no repeated lines | 344,457 B | 344,457 B | **0 B — untouched** |
| 1,000 identical warnings (synthetic) | 26,000 B | 163 B | **−99.4 %** |

Token figures in this table use 3 bytes ≈ 1 token, the same convention as the CLI's `--stats`. The synthetic row needs no input file, and reproduces the same savings from a clean clone:

```bash
node -e "process.stdout.write('warning: unused variable\n'.repeat(1000))" | node bin/slim.mjs --stats
# slim: slimmed 26000 B -> 163 B (-99.4%, ~8612 tokens saved @3 B/tok)
```

The honest reading: **logs that timestamp every line save only a few percent**, because no two lines are then identical. The payoff is concentrated in the dirty tail — compiler warnings repeated for each template instantiation, progress bars, table output, `cat` of a data file with repeated rows. If your tool output is already clean, this tool correctly does nothing and tells you so (`reason: "no-change"`).

The number that motivated the project: in one measured session an agent issued 27 file reads that together returned **279 KB ≈ 82,000 tokens**, which then had to be paid for again at every subsequent step. That figure is quoted, not estimated, from the upstream plugin's own source comment — `adapters/dsh/tool-sentinel/index.js:5-6`. Note the mixed convention: the upstream comment counts ≈3.5 bytes per token, while this README and the CLI's `--stats` use 3 bytes per token, so the 82,000 here is not directly comparable with the token column in the table above.

---

## Getting it

```bash
git clone https://github.com/HokleinDelrin/hd-token-slim.git
cd hd-token-slim
node bin/slim.mjs --stats path/to/file
```

The CLI examples below are POSIX (`cat file | ...`). The Windows PowerShell equivalent of the same pipe:

```powershell
Get-Content big.log | node bin/slim.mjs --stats
```

There is nothing to install: zero dependencies, no build step, no `npm install` — Node >= 18 is the only requirement. `npm install -g .` is only for putting the `slim` and `mcp-slim-proxy` binaries on your PATH; calling `node bin/slim.mjs` directly needs no install at all.

## CLI

```bash
# stdin -> stdout, stats on stderr
cat huge.log | node bin/slim.mjs --stats > slim.log

# or point it at a file
node bin/slim.mjs --stats build.log

# machine-readable
node bin/slim.mjs --json build.log | jq -r .text

# keep your own floors
node bin/slim.mjs --min-bytes 512 --protect-head 10 < out.txt
```

stdout carries the slimmed text and nothing else, so it stays pipeable. `--stats` writes to stderr:

```
slim: slimmed 283824 B -> 272443 B (-4.0%, ~3794 tokens saved @3 B/tok)
```

Flags: `--min-bytes <n>`, `--repeat-threshold <n>`, `--protect-head <n>`, `--protect-tail <n>`, `--no-ansi`, `--no-fold`, `--no-blank`, `--stats`, `--json`, `--version`, `--help`.

## Library

```js
import { slim, slimDetailed } from "hd-token-slim";

out = slim(text);                 // string in, string out
out = slim(text, { minBytes: 512 });

const r = slimDetailed(text, {}); // { text, applied, reason, beforeBytes, afterBytes, savedBytes, linesBefore, linesAfter }
```

`slim()` returns a string, always. `slimDetailed()` adds the numbers without changing the safety rules.

## MCP proxy

`bin/mcp-proxy.mjs` sits between your client and an existing stdio MCP server. It forwards every JSON-RPC line verbatim and touches exactly one thing: the `content[]` text blocks of a `tools/call` response. "Verbatim" here means content, not bytes: lines are read with Node's `readline`, so **line endings are normalised to LF** — a CRLF line from either side is re-emitted with a single `\n`, and nothing else about that line is rewritten.

```json
{
  "mcpServers": {
    "filesystem-slim": {
      "command": "node",
      "args": [
        "<path>/bin/mcp-proxy.mjs",
        "--upstream",
        "npx -y @modelcontextprotocol/server-filesystem /path"
      ]
    }
  }
}
```

```
client ──stdio──▶ mcp-proxy ──stdio──▶ upstream MCP server
                       │
                       └─ tools/call text blocks -> slim() -> back to client
```

What it does not do: it does not touch `tools/list`, `initialize`, notifications, `resources/*`, `prompts/*`, or server-to-client requests; it does not parse the meaning of results; it does not reorder untouched lines and does not re-encode their text (line endings are the one exception, above). Lines it cannot parse are relayed as-is. Diagnostics go to stderr, never stdout.

`read`-class tools are excluded by name (`isReadTool`): `read`, `read_file`, `read_text_file`, `read_multiple_files`, `read_media_file`, `cat`, `head`, `tail`, `view`, `view_file`, `open_file`, plus anything matching `read*`. Add more with `--skip a,b`.

---

## Why this cannot corrupt your data

The objection is always the same: "folding 100 identical error lines into `×100` is lossy — the model may need all 100." It is a fair objection, and the answer is not "trust me", it is five hardcoded boundaries:

1. **Strings only.** Anything that is not a string (`undefined`, `null`, a Buffer, an object) is returned as the same value, same reference.
2. **Byte floor.** Below `minBytes` (default 2048) the input is not touched at all — not trimmed, not normalised, not measured-and-rewritten.
3. **Never throws.** Any internal error — hostile options, a getter that throws, an unexpected type — returns the original text with `applied: false`. The slimmer cannot be the reason a tool result is lost.
4. **`read`-class tools are never touched,** enforced in the MCP proxy by tool name, before the text is ever inspected.
5. **Structure is preserved.** Every non-repeated line survives, in its original order. The first `protectHead` (3) and last `protectTail` (3) lines are emitted verbatim. A run that overlaps those windows is split, never reshaped: the protected lines stay, only the middle folds, and the `×N` states the exact remaining count.

On top of that: output that would grow is discarded (`reason: "would-grow"`), and the fold marker carries a number, not a vague ellipsis — `connection refused  ×400` says exactly 400 lines, in that position, with that content. What the fold does lose is the absolute line numbering of everything after the run, which is precisely why reads are excluded and why the head/tail stay put.

One honest note, stated plainly: `read`-class tools are not processed because the model frequently needs exact bytes and exact line numbers. We would rather save less than change the wrong thing.

---

## Adapters (`adapters/dsh/`)

`adapters/dsh/` holds three plugins that wire this core into one specific host, kept verbatim as *examples of an adapter* — not as the product, and not as a supported integration.

| adapter | what it shows |
|---|---|
| `token-diet/` | the thinnest possible wiring: three pure functions called from a tool hook |
| `tool-sentinel/` | host-specific by nature: depends on four host APIs, cannot be generalised |
| `handoff-watch/` | same: it measures a host session, not a text stream |

They are included so the integration pattern is visible, and to be honest about where the generalisation stops. `tool-sentinel` and `handoff-watch` are tied to a host contract and are **not** meant to be ported — rewriting them into a generic form would produce something nobody can run. Use `src/slim.mjs` and `bin/mcp-proxy.mjs` for everything else.

## Tests

```bash
node --test          # 27 tests, no network (fixtures are committed, none need generating)
```

Run this from a `git clone` of the repo: `package.json`'s `files` ships `bin/`, `src/`, `adapters/`, `README.md`, `LICENSE` — not `test/` or `fixtures/` — so an install from npm gives you no test suite to run.

Coverage: short-input pass-through, `×N` folding with exact counts, ANSI stripping (CSI + OSC), non-string input, throwing options, line-order preservation, head/tail protection, output-never-grows, read-tool detection, CLI stdout/stderr separation, and an end-to-end proxy run against a fake MCP server (`fixtures/fake-server.mjs`, checking that `read_file` responses come back byte-identical).

## License

MIT. No telemetry, no network access, no dependencies.

---
---

# 中文附录

## 一句话

**进入上下文之前，先把工具输出里的水分挤掉** —— 去 ANSI、把连续重复行折叠成 `×N`、压掉连续空行。零依赖、无 import、绝不抛错。

## 为什么值得做

工具结果一旦进了上下文就不是「一次性成本」，是「房租」：后面每一步都要重新发一遍、重新计一次费。一次脏输出能吃掉几万 token，然后一直吃下去。

但真实世界的收益是有限且分层的，这一点不美化：

| 输入 | 瘦身前 | 瘦身后 | 省 |
|---|---|---|---|
| 服务日志，6,297 行 | 283,824 B | 272,443 B | −4.0 % |
| 心跳日志，重复行密集 | 477,186 B | 420,337 B | −11.9 % |
| 无重复的散文 | 344,457 B | 344,457 B | 0 B，一字节没动 |
| 1,000 行完全相同的告警（合成，可复现） | 26,000 B | 163 B | −99.4 % |

前三行是作者本机的真实文件，那些输入没有进仓库，所以绝对数字无法复现；只有合成那行可以自己跑（见上方英文小节的 `node -e`，实测 `26000 B -> 163 B`）。

**每行都带时间戳的普通日志只省百分之几** —— 因为没有两行是完全一样的，工具在看不出可省之处时会诚实地什么都不做（`reason: "no-change"`）。真正的收益集中在「脏尾巴」上：模板实例化导致的重复编译告警、进度条残留、表格输出、`cat` 一个含重复行的数据文件。

项目起点那个数字来自上游插件自己的源码注释（`adapters/dsh/tool-sentinel/index.js:5-6`）：某次会话里 agent 发了 **27 次 read，吐了 279 KB ≈ 8.2 万 token**，这些 token 此后每一步都要重付一次。引用，不是估计。注意口径：上游注释按 ≈3.5 B/token 折算，本文与 `--stats` 按 3 B/token，两个数不能直接对比。

## 怎么拿到

```bash
git clone https://github.com/HokleinDelrin/hd-token-slim.git
cd hd-token-slim
```

不需要 `npm install`：零依赖、无构建步骤，Node >= 18 就能跑。下面命令里的 `cat` 在 Windows PowerShell 里换成 `Get-Content`（`Get-Content huge.log | node bin/slim.mjs --stats`）。

## 三条命令

```bash
cat huge.log | node bin/slim.mjs --stats > slim.log
node bin/slim.mjs --json build.log | jq -r .text
node bin/mcp-proxy.mjs --upstream "npx -y @modelcontextprotocol/server-filesystem /path"
```

## 为什么不会搞坏数据（五条硬边界）

1. **只处理字符串**：不是字符串就原值返回（引用都不变）。
2. **字节地板**：低于 `minBytes`（默认 2048）的内容一个字节都不碰。
3. **绝不抛错**：任何内部异常都返回原文，`applied: false`。瘦身工具不能成为丢结果的原因。
4. **`read` 类工具一律不动**：在 MCP 代理层按工具名判断，文本还没被看就先跳过。
5. **结构保留**：所有非重复行原样保留、顺序不变；首尾各 3 行（`protectHead`/`protectTail`）原样输出；重复段若与首尾窗口重叠则被切开 —— 保护区内保持原样，只有中间折叠，且 `×N` 是精确计数。

外加一条：瘦身之后如果反而变大，直接丢弃（`reason: "would-grow"`）。

折叠丢掉的是「重复段之后所有行的绝对行号」——这正是 read 类工具被排除、首尾被钉住的理由。

## `adapters/dsh/` 是什么

三个示例适配器，原样保留，**不是主产品、不是支持范围**：

- `token-diet/` —— 最薄的接线示例：三个纯函数挂在一个工具钩子上。
- `tool-sentinel/` —— 绑死宿主 API，天生无法通用化，放在这里是为了说清楚「通用化到哪儿为止」。
- `handoff-watch/` —— 同上，它量的是宿主会话，不是文本流。

它们存在是为了让接线方式可见，而不是给你移植的模板。`tool-sentinel` 和 `handoff-watch` 硬改成通用版只会做出一个没人能跑起来的东西。

## 一句诚实的话

`read` 类工具不处理，是因为模型经常需要精确的字节和行号。**宁可少省，不可乱改。**

## 许可证

MIT。无遥测、无联网、无依赖。
