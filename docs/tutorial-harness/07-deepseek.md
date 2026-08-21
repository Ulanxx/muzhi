# 第 7 期：DeepSeek Harness——一切皆插件与 KV 缓存执念

> **Harness 拆解课 · 第 7 期（共 10 期）**
>
> 压轴单体拆解。DeepSeek Harness（`dsh`）是 DeepSeek 官方开源的 agent harness，README 第一句就亮出架构主张：**everything is a plugin**，底座是 Cordis 插件框架。但真正让我们停下来读了三遍的，是它藏在压缩包里的一个执念——连一次辅助摘要调用，都要复用主对话的 KV 缓存。

---

## 这期解决什么问题

- **插件化到底插什么？** "一切皆插件"听着像营销词。dsh 里插件的边界长什么样，我们找个具体的看。
- **KV 缓存感知能细到什么程度？** 进阶篇第 6 期我们讲过前缀缓存：消息排布稳定，缓存才命中。dsh 把这件事推到了一个我们没想过的地方。

---

## Step 1：拆插件——压缩引擎是一个包

证据在 `packages/compaction/compaction-basic/src/index.ts`（L103 起）：

```ts
/**
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']
  static Config: z<BasicCompactionConfig> = z.object({ thresholdRatio: ..., retainRatio: ..., ... })
  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }
```

四个细节就是 dsh 插件模型的缩影：

**① 依赖是声明出来的。** `static inject = ['llm', 'tokenMeter', 'sessions']`——Cordis 按名单注入服务，插件不自己 new 依赖。想换个 token 计量器？换一个提供 `tokenMeter` 的插件就行。

**② 配置带 schema。** `static Config` 是运行时校验的配置声明，每个模型还能有独立的压缩策略（`modelPolicies`：thresholdRatio、retainRatio、summarizationModel 按模型配）。

**③ 扩展点被刻意收窄。** 注释明说：`summarize()` 是**唯一**的子类定制钩子，重放和持久化策略保持固定。插件化不等于处处可改——**可替换的是实现，不是契约**。

**④ 兄弟服务可选注入。** `import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'`——仅凭类型导入就声明了一个可选依赖，`ctx.get('toolResultPruner')` 拿到就用，拿不到照样跑（L281）。插件之间松耦合到"在场就合作，缺席就单干"。

---

## Step 2：拆缓存执念——摘要调用是真前缀

看 `region.ts` 的 `buildSummarizationInput`（L498）和它的注释（L489-493）：

```ts
/**
 * Reconstruct the last routed request's cacheable prefix for the shadowed
 * region: its system prompt and tool schemas, then the region's own derived
 * messages in surface order. The summarizer appends only the compaction
 * instruction after this, so the call is a genuine prefix of the conversation
 * and reuses the provider's KV cache.
 */
return {
  ...header?.system === undefined ? {} : { system: header.system },
  ...header?.tools === undefined ? {} : { tools: header.tools },
  messages: regionMessages,
}
```

翻译一下这个操作的精妙之处。普通人的摘要调用长这样：换个系统提示"你是摘要专家"，把对话拼成一大段文本发过去。**dsh 的摘要调用 = 原对话的 system + 原对话的 tools + 被压区消息按原序逐字排布，压缩指令只追加在最后一条。** 这样整个请求就是原对话请求的一个**真前缀**——原对话在服务器上烧出来的 KV 缓存，摘要调用直接命中，几乎不用重新预填充。

`summarizer.ts`（L74-76）把动机写得更直白：

> *"…reuse the provider's warm prefix cache; the trailing compaction instruction is then the only novel input."*——尾部那条压缩指令，是唯一的增量。

想想这里的复利：压缩通常在长对话（几万 token）上触发，预填充恰恰是最贵的部分。一次"顺手"的排布对齐，省下的是整段被压区的预填充费用。**缓存感知不是加一层缓存，是让所有请求长得像彼此的前缀。**

---

## Step 3：造——cache-align.ts

移植进沙箱 94 行，两个函数：

**`buildCacheAlignedSummaryRequest`——带护栏的构造器。** 你传进来的"被压区消息"必须通过校验：它是原请求消息的一段**逐字连续切片**（指纹比对 + 子序列查找）。改写一个字、换个顺序、把几条拼成一条——全部抛错拒绝。护栏的意义：缓存对齐是一种全局契约，**宁可构造失败，不能静默击穿缓存**。

**`checkAlignment`——对齐体检。** 复用进阶篇第 6 期的消息指纹逐条比对，输出共享前缀条数，诊断说人话："系统提示词变了——前缀第 0 步就失效""工具 schema 变了——前缀在工具表就断了"。

---

## 跑起来看看：同样花钱，一个买一送一

`demo-hns-07.ts` 的对照实验：先真实跑一段待办应用开发对话（4 条消息 + 工具表），然后两种姿势做摘要——A 组缓存对齐，B 组野路子：

```text
── 第二幕：A 组 · 缓存对齐摘要 ──
  ├ 摘要 A：工作摘要：待办应用数据存 localStorage（key:todos_v1，JSON数组）。现加按完成状态过滤，仅改渲染层筛选数据，不动存储结构。
  ▶ 对齐体检：✓ 对齐 —— 前 4 条消息逐字一致，KV 缓存可复用到第 4 条

── 第三幕：B 组 · 野路子摘要 ──
  ├ 摘要 B：待办应用：localStorage 存 todos_v1，过滤按完成状态渲染，不动存储。
  ▶ 对齐体检：✗ 不对齐 —— 系统提示词变了——前缀第 0 步就失效

── 验尸 ──
  ▶ 前缀探针：A 组共享前缀 4 条（真前缀），B 组共享 0 条
  ▶ 摘要质量抽查：A 含存储结构=true，B 含存储结构=true
```

两份摘要质量相当（都保住了 `todos_v1` 这个关键细节），但前缀探针的读数天差地别：**4 条 vs 0 条**。B 组在服务器眼里是一个全新请求，每一分预填充都要现算。

---

## 确定性测试

`test-cache-align.ts` 14 项：真前缀构造（system/tools/消息逐字、指令唯一且殿后）、构造防线四连拒（改写/换序/拼接/空区）、中段切片的如实报告、三种反面对照（换系统提示/换工具表/尾部不同但前缀仍对齐）。累计 **233 断言全绿**。

---

## 这期学到了什么

| 机制 | dsh 的做法 | 可抄的心法 |
|---|---|---|
| 插件边界 | 依赖声明注入，配置带 schema | 可替换的是实现，不是契约 |
| 扩展点 | summarize 是唯一钩子，其余固定 | 插件化要收窄，不要铺开 |
| 辅助调用 | 摘要是原对话的真前缀 | 所有请求长得像彼此的前缀 |
| 增量位置 | 新内容永远追加在最后 | 稳定的在前，易变的在后 |
| 契约护栏 | 改写/换序直接拒绝构造 | 缓存对齐是全局契约，宁炸不歪 |

关键心智模型：**KV 缓存是请求之间的公共财产。** 每个请求怎么排布，都在决定下一个请求的成本。dsh 给我们的最大启发不是某个技巧，而是一种审查视角：系统里每一次 LLM 调用，都该问一句——"这次调用，是谁的前缀？"

---

## 课后练习

1. 我们的 `ContextProjector`（进阶篇第 6 期）摘要消息用固定 id、固定时间戳保投影稳定。现在把它接上 `buildCacheAlignedSummaryRequest`：折叠时不再调"换个提示词的摘要器"，而是构造真前缀请求。改完用 CacheProbe 对比改造前后的 `prefixIntact` 读数。
2. `checkAlignment` 只比较消息层。把比较扩展到完整请求（system 的每个字节、tools 的 JSON 序列化顺序），并想想：JSON.stringify 的键序不稳定会不会制造假阴性？给工具 schema 写一个规范化序列化。
3. dsh 用 `tokenMeter` 单例给所有压缩决策计价。给 mini-agent 写一个 `TokenMeter`：记录每轮请求的输入/输出 token（我们的 `done` 事件已经带 usage），在压缩前后打印账单对比。第 5 期的预算触发接上真实计量会怎样？

---

## 下期预告

横切课开始。第 8 期：权限与沙箱七家横评——Codex 的双轴、Claude Code 的三色规则、OpenCode 的 permission 编辑、Gemini 的信任层、Pi 的确认流、dsh 的 guard 包，把六套模型摆在一张表上，回答一个问题：你的 agent 该用哪一套？
