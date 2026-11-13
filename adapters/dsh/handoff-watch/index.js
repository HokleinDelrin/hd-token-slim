/**
 * dsh-handoff-watch — 上下文长到一定体量时，把「现在的尺寸」报给模型，由用户决定要不要换会话。
 *
 * 定位（2026-11-13 改）：**报数，不是催办**。
 *   旧版会在系统提示里插「该换会话了 + 本轮内做三件事」，等于替用户做决定。
 *   压缩（compaction-basic 0.35）已经把上下文控制接管了，这条线只剩「告知」的价值：
 *   说清现在多大、涨在哪、换与不换各是什么代价，然后把决定权交回用户。
 *
 * 两个已知坑，这一版都修了：
 *   1) level 原本用 Math.max 累积，压缩把上下文压回 4 万后 level 仍是 2，
 *      之后无论再涨到多少都不再提醒 —— 假兜底。改成存当前级别。
 *   2) 提醒文案里写死「该换会话了」，与压缩阈值打架：压缩先动手，提醒永远到不了。
 *      现在阈值放到 45 万（压缩线 35 万之后），只在压缩失效或被禁用时出现。
 *
 * 零裸 import（file: 依赖的真实路径在 workspace 里没有 node_modules，
 * 任何 @deepseek-ai/* import 都会在宿主加载期 ERR_MODULE_NOT_FOUND）。
 *
 * 用到的宿主 API（0.2.1-rc.5 及以后，核到 0.2.2-rc.2）：
 *   ctx.get('tokenMeter').measure(session) -> { totalTokens, surfaceTokens }
 *   ctx.systemPrompt.context({ name, order, required, interpolate, text })
 *   ctx.on('agent/pre-step', async (payload, next) => decision)   // payload = { agent, messages, signal, step }
 */

export const name = "handoff-watch";

/** 需要 systemPrompt 注册提醒段；tokenMeter 是可选服务（拿不到就不量）。 */
export const inject = ["systemPrompt"];

/** 提醒段在系统提示里的位置：排在所有工具说明之后。 */
const ORDER = 3000;

export function apply(ctx, config) {
  const cfg = config ?? {};
  const warnTokens = cfg.warnTokens ?? 200000;
  const hardTokens = cfg.hardTokens ?? 320000;
  const repeatEverySteps = Math.max(1, cfg.repeatEverySteps ?? 6);
  const handoverPath = cfg.handoverPath ?? "handover.mjs";

  /** sessionId -> { tokens, level, lastRemindStep, step, firstTokens } */
  const state = new Map();

  const wan = (n) => (n / 10000).toFixed(1);

  function reminderText(tokens, level, st) {
    const steps = st?.step ?? 0;
    const first = st?.firstTokens ?? tokens;
    const head =
      level >= 2
        ? `【上下文体检 · 已过硬线】约 ${wan(tokens)} 万 tokens（警戒 ${wan(warnTokens)} 万，硬线 ${wan(hardTokens)} 万）。`
        : `【上下文体检】约 ${wan(tokens)} 万 tokens（警戒 ${wan(warnTokens)} 万，硬线 ${wan(hardTokens)} 万）。`;
    return [
      head,
      steps > 1
        ? `这条会话跑了 ${steps} 步，第 1 步才 ${wan(first)} 万 —— 涨上来的部分是工具输出累积，不是用户多说了几句话。`
        : `从这里往后每一轮，都要按这个尺寸重付一次输入。`,
      ``,
      `**这只是报数，不是命令。** 换不换会话由用户决定：接下来还要跑几十步，现在切更划算；`,
      `只差几句话就收尾，留着也无妨。不要主动催、不要替用户判断、不要自己中断。`,
      ``,
      `用户说要收尾、或你正要交付一个大段落时，再做这三件事：`,
      `1) \`node ${handoverPath} <本会话 id 前 8 位> <工作目录>/HANDOVER.md\`；`,
      `2) 该项目 README.md 顶部加一行 \`> 交接文档：HANDOVER.md（新会话先读它再开工）\`；`,
      `3) 给用户一句可直接复制的开场白。`,
    ].join("\n");
  }

  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    try {
      const session = payload?.agent?.session;
      const id = session?.header?.id;
      if (id !== undefined) {
        const meter = ctx.get("tokenMeter");
        if (meter !== undefined) {
          const measured = meter.measure(session);
          const tokens = measured?.totalTokens ?? 0;
          const step = payload?.step ?? 0;
          const prev = state.get(id) ?? { tokens: 0, level: 0, lastRemindStep: -repeatEverySteps };
          const level = tokens >= hardTokens ? 2 : tokens >= warnTokens ? 1 : 0;
          const crossed = level > 0 && level > prev.level;
          const overdue =
            level > 0 && step - (prev.lastRemindStep ?? -repeatEverySteps) >= repeatEverySteps;
          state.set(id, {
            tokens,
            // 存「当前」级别而不是历史最高：压缩会把上下文压回几万，之后再次变长
            // 必须能重新提醒一次，否则这条线在长会话里等于死了。
            level,
            // text() 拿不到 step，所以「这一步该不该提醒」必须在这里算好，
            // 否则只要 level > 0 就会每一步都喊一次。
            show: crossed || overdue,
            lastRemindStep: crossed || overdue ? step : prev.lastRemindStep,
            step,
            firstTokens: prev.firstTokens ?? tokens,
          });
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`handoff-watch: measure failed: ${String(error)}`);
    }
    return decision;
  });

  ctx.systemPrompt.context({
    name: "handoff:watch",
    order: ORDER,
    required: false,
    interpolate: false,
    text: (context) => {
      const id = context?.agent?.session?.header?.id;
      if (id === undefined) return "";
      const st = state.get(id);
      if (st === undefined || st.level === 0 || st.show !== true) return "";
      return reminderText(st.tokens, st.level, st);
    },
  });
}
