/**
 * dsh-tool-sentinel — 主线负载哨兵：自己不喊停，模型就会一直在主线里读文件。
 *
 * 为什么要它：这条规矩本来就有 —— 一次要读 >5 个文件、或跑 >10 条命令，就先起 subagent，
 * 只带结论回主线 —— 但那只是一段文字，模型照样能一条条在主线上读。实测某会话 138 次工具调用里
 * read 27 次吐了 279 KB（≈82k tokens），一步塞进上下文，后面每一步都要重付一次。
 *
 * 这个插件把那条规矩变成每步实时计量：统计「探索类」工具（read / grep / glob / pwsh /
 * web_* …）在主线上累计吐了多少字节、跑了几次，超过阈值就往系统提示里插一段带具体
 * 数字的指令，要求把剩下的同类活整包交给 subagent，只带结论回主线。
 *
 * 只计量、不改结果：post-execute 里读完 decision 原样返回，任何异常都放行。
 * 零裸 import：以 file: 依赖装进 profile 时 workspace 里没有 node_modules。
 *
 * 钩子（0.2.1-rc.5 及以后，核到 0.2.2-rc.2；与 token-diet 同款）：
 *   ctx.on("tools/post-execute", async (exec, result, next) => decision, { prepend: true })
 *   ctx.on("agent/pre-step", async (payload, next) => decision)
 *   ctx.systemPrompt.context({ name, order, required, interpolate, text })
 */

export const name = "tool-sentinel";

/** 需要 systemPrompt 注册提醒段。 */
export const inject = ["systemPrompt"];

/**
 * 「探索类」工具：只读或取数据，输出会整块进上下文。
 * 明确排除 edit / write（动作类，产出小）和 subagent / workflow（本身就是隔离手段）。
 */
const EXPLORE = new Set([
  "read",
  "read_multiple_files",
  "read_text_file",
  "read_media_file",
  "grep",
  "glob",
  "search_files",
  "list_directory",
  "list_directory_with_sizes",
  "directory_tree",
  "pwsh",
  "bash",
  "web_fetch",
  "web_search",
  "advanced_search",
  "multi_search",
  "research",
  "platform_search",
  "session_search",
  "session_event_search",
  "cache_search",
]);

/** 单次结果小于这个字节数的调用不计入（噪音不算负载）。 */
const NOISE_FLOOR = 512;

export function apply(ctx, config) {
  const cfg = config ?? {};
  const minCalls = Math.max(1, cfg.minExploreCalls ?? 6);
  const minBytes = Math.max(1, cfg.minExploreKB ?? 80) * 1024;
  const repeatEverySteps = Math.max(1, cfg.repeatEverySteps ?? 8);
  const order = cfg.order ?? 2900;

  /**
   * 上一次 pre-step 见到的会话 id，只作兜底。
   * post-execute 优先从 exec.agent.session.header.id 取真实 id：subagent 并发时
   * pre-step 里的 current 可能已经被改成子会话 id，只认它会把主线的 read 记进子代理的桶。
   */
  let current = null;
  /** sessionId -> { calls, bytes, byTool: Map, step, lastShow } */
  const stats = new Map();

  const bucket = (id) => {
    let b = stats.get(id);
    if (b === undefined) {
      b = { calls: 0, bytes: 0, byTool: new Map(), step: 0, lastShow: -repeatEverySteps };
      stats.set(id, b);
    }
    return b;
  };

  const kb = (n) => (n / 1024).toFixed(0);

  function reminderText(b) {
    const top = [...b.byTool.entries()]
      .sort((x, y) => y[1].bytes - x[1].bytes)
      .slice(0, 3)
      .map(([n, v]) => `${n}×${v.calls}（${kb(v.bytes)} KB）`)
      .join("、");
    return [
      `【主线负载哨兵】本会话已在主线里跑了 ${b.calls} 次探索类工具调用，累计吐出约 ${kb(b.bytes)} KB（≈${Math.round(b.bytes / 3.5 / 1000)}k tokens）进上下文。`,
      `大头：${top}。`,
      `这批内容已经进了历史，后面每一步都会再付一次；继续在主线里逐个 read / 逐个命令，只会让单价线性上涨。`,
      ``,
      `从现在起这样处理：`,
      `1) 剩下的「读多个文件 / 扫目录 / 跑多条命令 / 抓网页」整包交给 subagent（或 workflow 并行），它在自己的上下文里干完；`,
      `2) 主线只接收它的结论（三行以内：结论 / 证据 / 未确定），不要把中间过程读回主线；`,
      `3) 你自己只做「改一个文件、跑一条命令、答一个已知事实」这类小步；`,
      `4) 如果这批活已经做完了，就按现状继续，不要为了凑数去起 subagent。`,
    ].join("\n");
  }

  // pre-step：刷新会话 id、记步数、决定这一步要不要显示。
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    try {
      const id = payload?.agent?.session?.header?.id;
      if (id !== undefined) {
        current = id;
        const b = bucket(id);
        b.step = payload?.step ?? b.step + 1;
        const over = b.calls >= minCalls && b.bytes >= minBytes;
        const due = b.step - b.lastShow >= repeatEverySteps;
        b.show = over && due;
        if (b.show) {
          b.lastShow = b.step;
          ctx.logger?.warn?.(`tool-sentinel: injected at step ${b.step} (calls=${b.calls}, ${kb(b.bytes)} KB)`);
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`tool-sentinel: pre-step failed: ${String(error)}`);
    }
    return decision;
  });

  // post-execute：只记账，不改结果。
  ctx.on(
    "tools/post-execute",
    async (exec, result, next) => {
      const decision = await next();
      try {
        const toolName = exec?.name;
        if (toolName === undefined || !EXPLORE.has(toolName)) return decision;
        const id = exec?.agent?.session?.header?.id ?? current;
        if (id === undefined) return decision;

        const content = decision?.content ?? result?.content;
        if (!Array.isArray(content)) return decision;
        let bytes = 0;
        for (const block of content) {
          if (block && typeof block.text === "string") bytes += Buffer.byteLength(block.text, "utf8");
        }
        if (bytes < NOISE_FLOOR) return decision;

        const b = bucket(id);
        const wasUnder = b.bytes < minBytes;
        b.calls += 1;
        b.bytes += bytes;
        if (wasUnder && b.bytes >= minBytes) {
          ctx.logger?.warn?.(`tool-sentinel: threshold reached (calls=${b.calls}, ${kb(b.bytes)} KB, top=${toolName})`);
        }
        const t = b.byTool.get(toolName) ?? { calls: 0, bytes: 0 };
        t.calls += 1;
        t.bytes += bytes;
        b.byTool.set(toolName, t);
        return decision;
      } catch (error) {
        ctx.logger?.warn?.(`tool-sentinel: post-execute failed: ${String(error)}`);
        return decision;
      }
    },
    { prepend: true },
  );

  ctx.systemPrompt.context({
    name: "tool:sentinel",
    order,
    required: false,
    interpolate: false,
    text: (context) => {
      const id = context?.agent?.session?.header?.id;
      if (id === undefined) return "";
      const b = stats.get(id);
      if (b === undefined || b.show !== true) return "";
      return reminderText(b);
    },
  });
}
