# dsh-token-diet

给 DSH 补一层「压缩触发之前」的工具输出瘦身。挂点只有一处：`inject = ["tools"]` +
`ctx.on("tools/post-execute", ..., { prepend: true })`，与宿主自带的 spill-policy 同一个位置。

**零运行时依赖**：`index.js` 里没有任何 `import`。这不是偷懒，是踩过的坑 ——
见下面「为什么不能 import 宿主包」。

## 它和宿主内置插件的分工

| 层 | 谁负责 | 什么时候动手 |
|---|---|---|
| 格式噪音（ANSI、连续重复行、连续空行、行尾空白） | **token-diet**（本插件） | 每次工具返回，≥ `minBytes` 就做，无损语义 |
| 超长结果的 head/tail 截断 + 落盘 | 宿主自带的 spill-policy | 结果超过它的 inline 预算时 |
| 压缩前的工具结果修剪 | 宿主自带的 compaction-tool-result-pruner | 压缩触发条件满足后 |
| 会话历史摘要压缩 | 宿主自带的 compaction-basic | 上下文压力上涨时 |

也就是说：内置插件只在「已经很大」时才动手，本插件管每天都在漏的小噪音。

## 为什么不能 import 宿主包（重要）

这个插件以 `file:` 依赖装进 profile。包管理器对 `file:` 依赖是**复制**到
`<DSH_HOME>/profiles/<profile>/node_modules/dsh-token-diet`，而模块解析基准是
workspace 里的**真实路径**（`<PATH_TO_ADAPTER>/token-diet`），那里没有 `node_modules`。
所以任何 `import "@<scope>/dsh-*"` 在加载期就 `ERR_MODULE_NOT_FOUND` → 宿主起不来。

对照实验：profile 里的「其它社区插件」同样 import 宿主的 session / tools / settings 包，
在裸 node 环境里**全部** resolver 失败。它们能跑，是因为宿主运行时把自己的解析路径注入了进去 ——
但那条路径对 `file:` 依赖的 workspace 真实路径不生效，或者生效与否不该拿来赌。

结论：本插件不 import 任何东西。配置缺省值全部在 `apply()` 里用 `??` 兜底，
`cordis.patch.yml` 里写什么就是什么，不做 schema 校验。

## 安装

1. 先备份这三个文件（回滚要用，自己起的备份名记下来就行）：

```powershell
$p='<DSH_HOME>/profiles/<profile>'
Copy-Item "$p/package.json"     "$p/package.json.bak"
Copy-Item "$p/cordis.patch.yml" "$p/cordis.patch.yml.bak"
Copy-Item "$p/pnpm-lock.yaml"   "$p/pnpm-lock.yaml.bak"
```

2. profile 的 `package.json` → `dependencies` 加一条 `file:` 依赖，指向你放本 adapter 的路径：

```json
"dsh-token-diet": "file:<PATH_TO_ADAPTER>/token-diet"
```

3. profile 的 `package.json` → `dsh.profile.bundles` 加 `"dsh-token-diet"`。

4. `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 顶层加（bundle 自带的 patch 也会 insert
   这一行，这里再写一遍是为了把参数钉死）：

```yaml
- id: token-diet
  name: "dsh-token-diet"
  config:
    minBytes: 2048
    foldRepeats: true
    repeatThreshold: 3
    stripAnsi: true
    collapseBlank: true
    reportEvery: 20
```

5. 装依赖（用宿主自带的那份 node / 包管理器，别用系统 PATH 里的）：

```powershell
$n='<DSH_HOME>/dsh-runtimes/<runtime>/dependencies/node/bin/node.exe'
$pnpm='<DSH_HOME>/dsh-runtimes/<runtime>/dependencies/pnpm/bin/pnpm.mjs'
& $n $pnpm install
```

6. **重启 DSH** —— boot manifest 在启动时装配，改配置不重启不生效。

## 改了插件代码以后必须做的事

`file:` 依赖是复制形态，改 workspace 里的源码**不会**同步进
`node_modules/dsh-token-diet`。不同步的话，宿主加载的还是旧副本。改完必须重装副本再重启：

```powershell
Remove-Item node_modules/dsh-token-diet -Recurse -Force
& $n $pnpm install --force
```

验证副本是否最新：

```powershell
Select-String -Path node_modules/dsh-token-diet/index.js -Pattern '^import'
# 期望：无输出（零裸 import）
```

## 验证

- 重启后跑一条会吐大量重复行的命令（例如 `Get-ChildItem -Recurse | Format-Table`），
  看同一行是否变成 `...  ×N`。
- 日志里每 `reportEvery` 次改动打一行：`token-diet: N 次瘦身，累计省 X 字节`。

### 本地冒烟测试（不启动 DSH）

把 `<PATH_TO_ADAPTER>` 换成你放 adapter 的路径，预期输出 `true`：

```powershell
node --input-type=module -e "const m=await import('file:///<PATH_TO_ADAPTER>/token-diet/index.js'); let h; const ctx={on:(e,f)=>{h=f},logger:{info:console.log,warn:console.log}}; m.apply(ctx,{}); const t='a\n'.repeat(100)+'z'.repeat(2500); const d=await h({name:'pwsh'},{content:[{type:'text',text:t}]},async()=>({kind:'accept'})); console.log(d.content[0].text.includes('a  ×100'))"
```

## 回滚

把备份文件原样换回去（就是第 1 步自己起的那几个 `.bak`），重装，然后重启 DSH：

```powershell
$p='<DSH_HOME>/profiles/<profile>'
Copy-Item "$p/package.json.bak"     "$p/package.json" -Force
Copy-Item "$p/cordis.patch.yml.bak" "$p/cordis.patch.yml" -Force
Copy-Item "$p/pnpm-lock.yaml.bak"   "$p/pnpm-lock.yaml" -Force
& $n $pnpm install
```

## 边界

- 只处理「全部由 text 块组成」的结果；含图片或其它块类型原样放行。
- `read` 工具不动（行窗口由渲染器负责）。
- 任何异常都 `return decision`，不吞结果。
- 不改 `decision.value`，不碰 `reject` / `ask` 类决策。
- 小于 `minBytes` 的结果一个字节都不动。
