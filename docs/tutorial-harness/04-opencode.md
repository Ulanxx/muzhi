# 第 4 期：OpenCode——读穿开源循环，移植会话分叉

> **Harness 拆解课 · 第 4 期（共 10 期）**
>
> 前三家多少有点"隔纱看人"：Codex 核心开源但外围闭源，Claude Code 全闭源只能拆配置。OpenCode 是唯一完全开源的工业级 harness——这期直接把它的 agent 循环逐行读穿，看它靠什么判断"该停还是该转"，然后把它的会话分叉（fork）机制移植进 mini-agent。

---

## 这期解决什么问题

两个问题：

- **循环的停止条件到底写在哪？** 你的 mini-agent 用 `maxSteps` 硬顶。但真实 harness 里，"模型说完了"和"模型还想调工具"是两种不同的停止——这个判断长在循环的哪个位置？
- **话说岔了怎么办？** agent 走到一半发现方向错了：上下文里已经躺着一句走岔的问答。删消息会破坏历史不可变（进阶篇第 6 期的 canonical 原则），不删就一直被污染。OpenCode 的答案是 fork：不改写历史，复制出一条干净的时间线。

---

## Step 1：拆循环——finish 字段是循环的方向盘

证据在 `packages/opencode/src/session/prompt.ts`（约 1081 行起的 `runLoop`）：

```ts
while (true) {
  const step = ...;
  const { lastAssistant, lastFinished } = MessageV2.latest(msgs);
  // 上一轮 assistant 的 finish 不是 "tool-calls"（且不是孤儿中断）→ 退出循环
  if (lastAssistant?.finish && !["tool-calls"].includes(lastAssistant.finish)) {
    return ...; // exiting loop
  }
  const maxSteps = agent.steps ?? Infinity;  // 步数上限是每个 agent 自己的配置
  ...
}
```

三个设计决策值得停下来看：

**停止条件住在消息里，不住在循环变量里。** 每轮 assistant 消息带一个 `finish` 字段（`stop` / `tool-calls` / `length` / `error`……），循环每转一圈先读最后一条消息的 finish 再决定去留。好处：循环是无状态的——进程崩了重启，从存储里读出最后一条消息，就知道该不该继续转。这就是"断点续跑"的地基（第 9 期细讲）。

**`agent.steps ?? Infinity`。** 步数上限不是全局常数，是每个 agent 配置自带的——build 型 agent 给足步数，快速问答型 agent 收紧。同一框架里不同人格不同预算。

**孤儿工具的善后。** 源码里有一条专门的日志：`loop exit with orphaned interrupted tool`——如果上一轮发出了工具调用但没等到结果（被打断/崩溃），循环退出前要记下来。悬空的工具调用是 resume 时的地雷。

---

## Step 2：拆 fork——深拷贝不是 fork，重写回指才是

证据在 `packages/opencode/src/session/session.ts`（691 行起的 `Session.fork`），40 行代码四个要点：

```ts
const fork = function* (input: { sessionID, messageID? }) {
  const title = getForkedTitle(original.title)      // ① "标题 (fork #1)" 递增命名
  const session = yield* createNext({ ... })
  const msgs = yield* messages({ sessionID })
  const idMap = new Map<string, MessageID>()         // ② 新旧 id 映射表
  const target = input.messageID ? msgs.findIndex(...) : msgs.length  // ④ 分叉点
  for (const msg of msgs.slice(0, target)) {
    const newID = MessageID.ascending()
    idMap.set(msg.info.id, newID)
    // ③ assistant 的 parentID 按 idMap 重写到新 id
    const parentID = msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
    ...
    for (const part of msg.parts) {
      if (p.type === "compaction" && p.tail_start_id)
        p.tail_start_id = idMap.get(p.tail_start_id)  // 压缩锚点也要重映射！
    }
  }
}
```

逐个说：

**① 命名策略。** `getForkedTitle` 用正则认 `(fork #N)` 后缀递增：fork 的 fork 是 `#2` 不是 `#1 (fork #1)`。会话列表里一眼看出血缘。

**② idMap 是 fork 的灵魂。** 每条消息换新 id，但"谁是谁的 parent""压缩尾巴从哪条消息开始"这些回指必须同步翻译。只换 id 不重写回指，fork 出来的会话里全是悬空引用——存储层一查就 404。

**③ 连压缩锚点都不放过。** `compaction` part 的 `tail_start_id` 指向"摘要之后保留的第一条消息"，fork 时一起重映射——否则 fork 会话的压缩器会找不到尾巴起点。

**④ 分叉点语义是"不含"。** `slice(0, findIndex(messageID))`：从某条消息 fork = 复制它之前的所有消息，**它自己不进新会话**。对应真实用法：回到"说这句话之前"，换个说法重新来。

---

## Step 3：造——fork.ts

移植进沙箱 70 行（`forkSession`），两处适配：我们的消息模型没有 parentID，idMap 只管 message/part 两级；我们的投影式压缩摘要消息用固定 id `msg_summary_root`（进阶篇第 6 期保前缀缓存的设计），fork 时保留固定 id——每个会话各自一份消息列表，不会撞，而固定 id 让 fork 会话的缓存探针有个稳定的起点。

```ts
for (const msg of slice) {
  const cloned: Message = structuredClone(msg);
  if (cloned.id !== SUMMARY_MESSAGE_ID) cloned.id = newId("msg"); // 摘要锚点保留
  cloned.sessionId = forked.id;
  if (cloned.role === "assistant") {
    for (const part of cloned.parts) {
      part.id = newId("prt");
      part.messageId = cloned.id;   // 回指跟着新消息走
    }
  }
  await store.appendMessage(forked.id, cloned);
}
```

---

## 跑起来看看：两条时间线并存

`demo-hns-04.ts` 的剧情：让 agent 帮忙选咖啡机。第一幕正常聊两轮（agent 先问偏好，被一句答非所问的预算插话带偏）；第二幕从走岔那轮之前 fork，换成"严格 800 预算"重问：

```text
── 第一幕：原会话 ──
  ├ agent：你最看重的是操作便捷性（如全自动），还是咖啡风味可玩性（如半自动）？
  ├ agent：那在这个价位，优先推荐全自动豆仓机，比如德龙或飞利浦……

── 第二幕：从走岔之前 fork ──
  ✓ 新会话：帮我选台咖啡机 (fork #1)
  ✓ 分叉点语义：新会话 2 条消息（走岔的那句问答没进来）
  ├ fork 线 agent：在这个价位，推荐德龙ECO310半自动咖啡机……

── 验尸 ──
  ▶ 原会话仍是 4 条消息，结局未变
  ▶ fork 会话 4 条消息，走的是 800 预算路线
  ▶ 两会话消息 id 无交集：true
```

三条验证都过了：分叉点精确（走岔的一问一答都没进新会话）、原会话分毫未动（fork 是复制不是搬移）、两条线的消息 id 零交集（没有任何共享引用的残留）。

实跑前的一个小坑也值得记：第一版 demo 的存储层只存了 assistant 消息，漏存 user 消息——fork 出来的会话开头缺了用户的第一句话，agent 莫名其妙接不上。**fork 的正确性依赖存储的完整性**，消息流水账缺一条，所有下游机制（fork、resume、压缩）全部歪掉。

---

## 确定性测试

`test-fork.ts` 16 项：命名递增（fork 的 fork 不叠加）、全量复制 + 原会话不受影响、sessionId/消息 id/part id 全换新且 part.messageId 跟随、分叉点"不含"语义、找不到分叉点回退全量（与 OpenCode 行为一致）、不存在的会话抛错、摘要消息固定 id 保留。累计 **175 断言全绿**。

---

## 这期学到了什么

| 机制 | OpenCode 的做法 | 可抄的心法 |
|---|---|---|
| 循环停止 | finish 字段存在消息里，循环无状态 | 状态住存储，循环只读——断点续跑的地基 |
| 步数预算 | `agent.steps ?? Infinity`，每个 agent 自带 | 预算是人格的一部分，不是全局常数 |
| fork | idMap 重写一切回指，分叉点"不含" | 深拷贝不是 fork，重写回指才是 |
| 历史不可变 | 走岔了不改写，复制新时间线 | canonical 原则的社交版：不翻旧账，另开一局 |

关键心智模型：**会话不是线，是树。** 一旦接受这个设定，"撤销""重试""A/B 两个方案并行探索"全都变成同一个操作：从某个节点长出新枝。

---

## 课后练习

1. 给 fork 加"血缘字段"：新会话记 `forkedFrom: { sessionId, beforeMessageId }`。然后写个 `familyTree` 函数把同一棵树的所有会话打印成缩进结构。想想 Claude Code 的 `/resume` 列表该怎么利用这个信息。
2. 我们的 fork 保留了摘要消息的固定 id。但如果原会话 fork 时正处于"摘要刚生成、尾巴还没长出来"的状态，fork 会话继续跑会不会重复压缩同一段？写个测试复现它（提示：给 ContextProjector 注入一个计数的假摘要器）。
3. OpenCode 的 finish 字段我们还没抄。给 mini-agent 的 assistant 消息加 `finish: "stop" | "tool-calls" | "error"`，把 loop 的退出条件从"本轮有没有工具调用"改成"读上一条消息的 finish"。改完想想：这对第 9 期的 resume 意味着什么？

---

## 下期预告

Gemini CLI。免费额度逼出来的工程：100 万 token 上下文也不是无限的，它怎么做上下文预算管理、什么时候触发压缩、压缩前怎么抢救信息。我们把"成本感知的压缩触发"装进 mini-agent。
