# 第 5 期：Gemini CLI——上下文预算与免费额度工程

> **Harness 拆解课 · 第 5 期（共 10 期）**
>
> 前面四家聊的是"怎么动"（工具、权限、循环、分叉），这期聊"怎么省"。Gemini CLI 是免费额度时代逼出来的工程样本：100 万 token 的上下文听着唬人，但免费层每天有请求配额、单次输入也收费——它必须把每一个 token 花在刀刃上。我们把它的压缩服务 `chatCompressionService.ts` 逐行读穿，把"预算式压缩"移植进 mini-agent。

---

## 这期解决什么问题

进阶篇第 6 期我们造过投影式压缩：85% 触发、保 6 条尾部、增量摘要。那是"能用的压缩"。Gemini 这期回答三个更刁的问题：

- **什么时候压？** 压早了浪费钱（摘要也要调 LLM），压晚了爆窗口。阈值写多少？
- **压缩前怎么自救？** 历史里躺着一份 1 万行的 grep 结果——摘要模型自己也吞不下它，怎么办？
- **压砸了怎么办？** 摘要比原文还长、摘要漏了关键事实、摘要服务挂了——三种失败各有各的善后。

---

## Step 1：拆触发——半满就压

证据在 `packages/core/src/context/chatCompressionService.ts`（L41）：

```ts
const DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5;
```

**默认阈值是窗口的 50%。** 我们进阶篇写的是 0.85——贴着红线才压。Gemini 为什么这么激进？看触发位置（`client.ts` L689）：压缩检查发生在**每一轮开始之前**。半满就压，是给这一轮的工具输出和模型回复预留空间——等 85% 才动手，模型一次大工具调用就能把你顶爆。阈值不是"我能装多少"，是"下一轮我还想活"。

分片点同样有讲究（`findCompressSplitPoint`，L60-100）：

- **只在 user 消息切。** 切点语义是"压掉切点之前的一切"，在 assistant 消息中间切会把工具调用和工具结果拆散——悬空的 functionCall 会让 API 直接拒收。
- **末条是 user 不许全压。** 用户刚提的问题在列表末尾时，"全部压掉"等于把问题本身压没了——退回上一个切点。
- **末条挂着未完成的工具调用也不许全压**——和 OpenCode 的孤儿工具是同一类地雷（第 4 期讲过）。

---

## Step 2：拆自救——反向预算

压缩前先做一遍 `truncateHistoryToBudget`（L137），注释里管这叫 **Reverse Token Budget**：

```ts
// 从最新往旧走：预算内的工具输出保全文，超预算的截断留尾 30 行
for (let i = history.length - 1; i >= 0; i--) {
  ...
  if (functionResponseTokenCounter + tokens > COMPRESSION_FUNCTION_RESPONSE_TOKEN_BUDGET) {
    // 超预算：截断到最后 30 行，全文存临时文件
    const { outputFile } = await saveTruncatedToolOutput(...);
  }
}
```

预算是 **50,000 tokens**（L52）。设计意图写在注释里：最近几轮的工具输出是模型当下决策的依据，保全文；老的输出只剩参考价值，截断。**保真度留给当下，历史只留轮廓。** 被截断的全文不是删了——存进项目临时目录，留一条后路。

这一步还有隐藏作用：摘要模型也有自己的窗口。不把巨型输出先收敛，摘要这一步自己就会爆。

---

## Step 3：拆善后——三种失败三种命

压缩不是"调一次摘要"这么简单。看 Gemini 的状态机（`CompressionStatus`，turn.ts L183）和对应善后：

**① 膨胀拒绝。** 压完先算新历史的 token 数，**比原来还大 → 整次作废**（L462，`COMPRESSION_FAILED_INFLATED_TOKEN_COUNT`）。宁可顶着旧历史跑，也不用一份更贵的"摘要"。

**② 失败记忆。** 膨胀作废后，`hasFailedCompressionAttempt` 置位（client.ts L1220）。下一次自动压缩**不再调 LLM**——只吃截断的红利（`CONTENT_TRUNCATED` 状态）。注释写得很直白：不重复尝试，"to avoid repeated failures/costs"。摘要模型挂了往往是持续性的（配额、故障），无脑重试就是烧钱。

**③ 空摘要。** 摘要器返回空 → `COMPRESSION_FAILED_EMPTY_SUMMARY`，历史维持原状。

最精彩的是**压缩前怎么抢救信息**——Gemini 用的是两轮 LLM（L361-407）：

```ts
// 第一轮：生成 <state_snapshot>（先在 scratchpad 里推理）
const summaryResponse = await generateContent({ ... });
// 第二轮："Probe" 校验——让模型审视自己的摘要
'Critically evaluate the <state_snapshot> you just generated.
 Did you omit any specific technical details, file paths, tool results,
 or user constraints mentioned in the history? ...'
```

摘要模型自问自答："我漏了什么没有？"漏了就出补全版。而且历史里如果已有上一份 `<state_snapshot>`，锚点指令会要求"整合旧快照里仍然相关的信息"——增量压缩不丢旧账。

顺带一提免费额度工程的另一面：`retry.ts` 对 429 做指数退避，**持续 429 直接降级换模型**（`onPersistent429` → fallback 链）；`constants.ts` 里连空回复都带提示——"上下文快满了，试试 /compress"。省钱这件事，从错误提示到降级链路全线设防。

---

## Step 4：造——budget.ts

移植进沙箱约 220 行（`compressWithBudget`），两处适配：我们的消息模型里"未完成工具调用"对应 `tool` part 的 `state.status !== "completed"`；摘要消息沿用进阶篇的固定 id `msg_summary_root`（前缀缓存锚点）。Gemini 的 `'Got it. Thanks for the additional context!'` 应答占位也照抄——摘要（user 角色）后面必须跟一条 assistant 消息，对话轮次才合法。

---

## 跑起来看看：摘要抢救三条事实

`demo-hns-05.ts` 的剧情：让 agent 记住三条事实（代号 zmzai、截止 8月30日、部署 Fly.io），再灌一条 6000 字符的假日志把 400 token 的小窗口撑爆，触发预算压缩，最后**只用压缩后的历史**追问那三条事实：

```text
── 第一幕：埋事实，灌日志 ──
  ├ agent：记好了。
  ├ agent：当前所有请求处理正常，无异常或错误。状态健康。
  ▶ 历史 5 条消息，估算 5036 tokens

── 第二幕：触发预算压缩 ──
  ▶ 状态：COMPRESSED
  ▶ token：5036 → 29
  ▶ 摘要内容：
     【早期对话摘要】
     项目代号 zmzai，截止日期 2026年8月30日，部署平台 Fly.io。已记录。

── 第三幕：摘要抢救验证 ──
  ├ agent：项目代号 zmzai，截止 2026年8月30日，部署在 Fly.io。

── 验尸 ──
  ▶ 三条被压掉的事实，救回 3/3：zmzai、8月30、Fly.io
  ▶ 历史条数：5 → 4，窗口占用 29 tokens（预算线 200）
```

**173 倍的压缩比，三条事实一条没丢。** 注意那 6000 字符的日志：它正是被压段的大头，而摘要对它只字未提——因为任务事实比日志细节值钱。压缩的本质不是"变短"，是**取舍**。

---

## 确定性测试

`test-budget.ts` 25 项：阈值边界（恰好 50% 触发、阈值可配）、切点只落 user、末条是 user 不许全压、尾部悬空工具不许全压、反向预算保新截旧、NOOP/COMPRESSED/INFLATED/EMPTY_SUMMARY/TRUNCATED_ONLY 五种状态、失败后摘要器零调用、Probe 校验轮采用改进版且失败不致命。累计 **200 断言全绿**。

---

## 这期学到了什么

| 机制 | Gemini 的做法 | 可抄的心法 |
|---|---|---|
| 触发阈值 | 窗口 50%，每轮开始前检查 | 阈值不是"能装多少"，是"下一轮还想活" |
| 分片点 | 只在 user 消息切，末条有雷不全压 | 切点必须落在对话的合法接缝上 |
| 巨型输出 | 反向预算：保新截旧，全文落盘留后路 | 保真度留给当下，历史只留轮廓 |
| 摘要质量 | 两轮：生成 + Probe 自校验 | 重要摘要值得多花一轮让模型自查 |
| 压缩失败 | 膨胀作废 + 失败记忆，降级只截断 | 失败要记账，重试要有预算 |

关键心智模型：**压缩是有成本的。** 调摘要模型要花钱花时间，所以触发要算账（半满就压 vs 贴线才压）、失败要止损（一次失败就降级）、结果要验收（膨胀就作废）。我们进阶篇的投影式压缩是"免费摘要假设下的正确性"，这期补上的是"真实账单下的经济学"。

---

## 课后练习

1. Gemini 的阈值是 0.5，我们进阶篇是 0.85。给 `ContextProjector` 接上 `budget.ts` 的触发判断，分别跑同一场长对话，对比两者的压缩次数和最终窗口占用。想想：摘要模型越便宜，阈值应该往哪边挪？
2. 反向预算截断时，Gemini 把全文存进临时文件。给我们的 `truncateToolOutputsToBudget` 也加上落盘（返回文件路径写进占位文案），然后给模型加一个 `recall_truncated` 工具按路径召回全文。想想这跟第 2 期的沙箱权限该怎么配合。
3. Probe 校验轮我们照抄了。但如果摘要本身很短（29 tokens），校验轮的花费可能比摘要还贵。给 `compressWithBudget` 加一条"摘要低于 N tokens 时跳过校验"的规则，写测试钉住这个开关。

---

## 下期预告

Pi。极简派的另一极：整个 harness 的核心提示词不到一千 token，却敢做出工业级产品。我们拆它的会话树设计，看看"少"是怎么成为一种架构能力的——然后反思我们 mini-agent 里有哪些东西其实可以删。
