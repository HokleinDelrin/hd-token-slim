/**
 * dsh-token-diet — 工具输出的无损伤瘦身。
 *
 * 定位：内置的 dsh-spill-policy（12500 tok 预算）和 dsh-compaction-tool-result-pruner
 * （8192 字符起、留 head 4096 + tail 1024）都只在「压缩触发条件满足」时才动手，
 * 而且触发前的内容一个字节都不碰。这个插件补的是「触发之前」那一层：
 * 去 ANSI、折叠连续重复行、压掉连续空行 —— 全是可逆的格式噪音，不改语义。
 *
 * 挂的钩子与 DSH（0.2.1-rc.5 及以后，核到 0.2.2-rc.2）自带的 spill-policy 完全相同：
 *   export const inject = ["tools"]
 *   ctx.on("tools/post-execute", async (exec, result, next) => decision, { prepend: true })
 *
 * 任何一步抛错都原样放行，绝不因为省 token 弄丢工具结果。
 *
 * 刻意不导出 schemastery 的 Config：这个插件以 `file:` 依赖装进 profile，
 * 真实路径在 workspace 里没有 node_modules，任何运行时 import 都会在宿主
 * 解析阶段就失败。配置缺省值全部在 apply() 里兜底，patch 里写什么就是什么。
 */

/** Cordis 插件身份。 */
export const name = "token-diet";

/** 只依赖工具注册表；不需要 llm / fs / session。 */
export const inject = ["tools"];

/** eslint-disable-next-line no-control-regex */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** 去掉 ANSI 转义序列（颜色、光标移动、超链接等）。 */
function stripAnsi(text) {
  return text.replace(ANSI, "");
}

/** 连续 N 行及以上完全相同的行折叠成一行 + 计数尾巴。 */
function foldRepeats(text, threshold) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let j = i + 1;
    while (j < lines.length && lines[j] === line) j += 1;
    const run = j - i;
    // 空白行的连续段交给 collapseBlank，避免两套规则打架
    if (run >= threshold && line.trim() !== "") {
      out.push(`${line}  ×${run}`);
    } else {
      for (let k = 0; k < run; k += 1) out.push(line);
    }
    i = j;
  }
  return out.join("\n");
}

/** 连续空行压成一行；同时去掉行尾空白（对 diff / 日志无影响，对 token 有）。 */
function collapseBlank(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * 只处理纯文本内容；含图片或非 text 块的结果原样返回。
 * @returns 压缩后的内容数组，或 undefined（表示不改）
 */
function slimContent(content, config) {
  if (!Array.isArray(content)) return undefined;
  if (!content.every((block) => block && block.type === "text")) return undefined;

  let changed = false;
  let beforeBytes = 0;
  let afterBytes = 0;

  const next = content.map((block) => {
    const original = block.text;
    beforeBytes += Buffer.byteLength(original, "utf8");
    if (Buffer.byteLength(original, "utf8") < config.minBytes) {
      afterBytes += Buffer.byteLength(original, "utf8");
      return block;
    }

    let text = original;
    if (config.stripAnsi) text = stripAnsi(text);
    if (config.foldRepeats) text = foldRepeats(text, Math.max(2, config.repeatThreshold));
    if (config.collapseBlank) text = collapseBlank(text);

    afterBytes += Buffer.byteLength(text, "utf8");
    if (text === original) return block;
    changed = true;
    return { ...block, text };
  });

  if (!changed) return undefined;
  return { content: next, beforeBytes, afterBytes };
}

export function apply(ctx, config) {
  const cfg = config ?? {};
  const minBytes = cfg.minBytes ?? 2048;
  const reportEvery = Math.max(1, cfg.reportEvery ?? 20);
  const resolved = {
    minBytes,
    foldRepeats: cfg.foldRepeats ?? true,
    repeatThreshold: cfg.repeatThreshold ?? 3,
    stripAnsi: cfg.stripAnsi ?? true,
    collapseBlank: cfg.collapseBlank ?? true,
  };

  let runs = 0;
  let savedBytes = 0;

  ctx.on(
    "tools/post-execute",
    async (exec, result, next) => {
      const decision = await next();

      // 只碰「原样接受、没有自造 value」的结果；拒绝/改写类决策一律不插手。
      if (decision?.kind !== "accept") return decision;
      if (Object.hasOwn(decision, "value")) return decision;
      if (exec?.name === "read") return decision; // read 的行窗口由渲染器负责

      try {
        const content = decision.content ?? result?.content;
        const slimmed = slimContent(content, resolved);
        if (slimmed === undefined) return decision;

        runs += 1;
        const delta = slimmed.beforeBytes - slimmed.afterBytes;
        savedBytes += delta;
        if (runs % reportEvery === 0) {
          ctx.logger?.info?.(
            `token-diet: ${runs} 次瘦身，累计省 ${savedBytes} 字节（≈${Math.round(savedBytes / 3)} tokens 量级）`,
          );
        }
        return { ...decision, content: slimmed.content };
      } catch (error) {
        ctx.logger?.warn?.(`token-diet: ${String(error)}；保留原结果`);
        return decision;
      }
    },
    { prepend: true },
  );
}
