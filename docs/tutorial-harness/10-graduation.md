# 第 10 期：毕业改造——把九期的精华装回 zmzai-agent

> **Harness 拆解课 · 第 10 期（共 10 期）**
>
> 毕业课。拆了六家 harness、造了一沙箱零件，最后一步是把学到的东西用在自己的系统上。我们回头审视 zmzai-agent 的 agent-framework，做了一次真刀真枪的复盘：哪些课它已经自己修过了，哪些课它挂科了——然后补考。

---

## 这期解决什么问题

- zmzai-agent 的 harness 和六家比，强在哪、缺在哪？
- 从课程零件里挑三件最能提命的装回去，跑基准回归验证不破坏现状。

---

## Step 1：复盘——它已经自己修过的课

先说好消息。agent-framework 里已经躺着好几件我们课上造过的东西：

| 课程零件 | zmzai-agent 现状 | 对照 |
|---|---|---|
| 权限裁决（第 3/8 期） | `permission/engine.ts` + `ruleset.ts`：once/always/reject、会话规则、always 自动放行排队请求 | 和 OpenCode 几乎同款 |
| 会话存储（第 9 期） | `session/jsonl-store.ts`：逐文件读、坏文件跳过 | Pi 式容错已有 |
| 压缩（第 5/7 期） | `runtime/compaction.ts`：transformContext 钩子、保留尾部、失败降级全量 | Gemini 的骨架在 |
| 循环守护 | `loop-guard.ts`、`lease-recovery.ts` | 课外的加分项 |

**复盘的第一课：先盘点再动手。** 六家横评的价值不是照抄，是给你一张体检表。

## Step 2：挂科点一——压缩没有膨胀拒绝，没有失败记忆

`compaction.ts` 的旧逻辑：摘要调用失败（返回空）→ 降级全量，**但下一轮还会再试**。这是 Gemini 踩过的坑（第 5 期 `hasFailedCompressionAttempt`）：长会话每轮都超阈值，就会每轮都烧一次摘要调用，永远失败、永远重试。第二个缺口是膨胀拒绝：摘要模型偶尔会把对话"压缩"得比原文还长，旧代码照单全收——负收益压缩。

**改造**（`runtime/compaction.ts`）：

```ts
let hasFailed = false;               // 失败记忆，整个 run 有效
// ...
if (hasFailed) return messages;      // 不再反复烧摘要 token
// ...
const headTokens = estimateTokens(head);
if (estimateTokens([summaryMsg]) >= headTokens) {
  hasFailed = true;                  // 膨胀拒绝：压了不如不压
  await options.onCompactionFailed?.("summary-inflated");
  return messages;
}
```

新增 `onCompactionFailed` 回调——失败不静默（第 3 期的课：**拒绝/失败必须带理由，理由说给上游听**），runner 可以借它埋点或提示用户。

## Step 3：挂科点二——拒绝不连坐

`permission/engine.ts` 的旧行为：拒绝一个请求，只拒它一个；同会话排队的其他请求继续挂着等人审。OpenCode 的态度（第 8 期 L121-138）是：用户说"不"的时候，后面的请求不该继续敲门——**拒绝级联**。

**改造**（`engine.ts` 的 `reply()`）：

```ts
if (reply === "reject") {
  for (const [id, other] of [...this.pending]) {
    this.pending.delete(id);
    // 级联拒绝不复用原反馈：这些请求没被单独审过，理由必须如实说是连坐
    other.resolve({ reply: "reject", feedback: "用户已拒绝同会话的另一个请求，本次一并拒绝" });
  }
}
```

注意一个容易抄错的细节：第一版我们让级联拒绝复用用户给原请求的反馈文案，测试立刻抓出了语义错误——那等于声称"用户也审过第二个请求"。**级连坐，不连反馈**；批准不连坐，拒绝连坐，方向不对称是刻意的（和 deny 永远赢同一个方向：安全侧收紧）。

## Step 4：为什么第三件是"不改"

原本还想把第 7 期的缓存对齐摘要装进去（摘要调用复用主对话的 KV 前缀）。读完接线方式后决定不动：zmzai-agent 的摘要走独立的 `summaryModel`（relay 的小模型）和独立 streamFn，主对话的 system/tools 不在同一个请求面上——真前缀的前提不成立。强行套用只会增加耦合。**毕业改造最难的不是装什么，是忍住不装什么。**

---

## 基准回归

改造前先跑全量测试立基线，改造后回归：

```text
 Test Files  13 passed (13)
      Tests  110 passed (110)
```

13 个测试文件、110 条用例全绿（其中 3 条是为本次改造新写的：膨胀拒绝 + 失败记忆、空摘要失败记忆、拒绝级联），tsc 零错误。回归的意义：**毕业改造是手术，不是装修——每刀都要有测试兜底。**

---

## 这期学到了什么

| 复盘维度 | 结论 |
|---|---|
| 已有家底 | 权限、存储、压缩骨架都在——先盘点再动手 |
| 装回的零件 | 膨胀拒绝、失败记忆、拒绝级联 |
| 忍住的零件 | 缓存对齐摘要（前提不成立，不强装） |
| 验证方式 | 全量回归 + 新增针对性用例 |

四条毕业心法：

1. **横评是体检表，不是购物清单**——先对照自己有什么，再决定补什么。
2. **失败路径比成功路径值得抄**——这次装回的三件全在失败路径上（摘要失败、摘要膨胀、用户拒绝）。正常流程各家大同小异，差距都在异常处理。
3. **语义错误要靠测试抓**——级联反馈复用原话这种错，人眼审三遍也看不出来，一条断言立刻现形。
4. **改造要可追溯**——每处改动都标注了出处（"harness-course 05/07 retrofit"），半年后没人记得为什么有这段代码，注释会替你记得。

---

## 课后练习

1. 给 `onCompactionFailed` 接上真实埋点：统计一周内 `summary-empty` 和 `summary-inflated` 的比例。如果膨胀率很高，该换摘要模型还是换摘要提示词？用数据说话。
2. 拒绝级联现在是"全连坐"。加一个粒度开关：同一工具调用的多个 pattern 连坐，不同工具的请求不连坐。想想什么场景下"全连坐"会误伤（提示：并行的子 agent）。
3. 把第 9 期的 `SessionLog.resumeFromLog` 的半行容错移植进 `jsonl-store`：它现在跳过整个坏文件，能否细化到"坏行丢弃、好行保留"？给追加写场景写一个 kill -9 恢复测试。

---

## 全课回顾

十期下来，我们拆了六家 harness（Codex、Claude Code、OpenCode、Gemini CLI、Pi、DeepSeek Harness），在沙箱里造了 12 个零件、写了 276 条确定性断言、跑了 9 场真实 LLM 实验。如果只留一句话：**harness 不是模型的外壳，是模型的操作系统——它决定了同样的模型，干出什么样的活。**
