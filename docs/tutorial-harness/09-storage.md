# 第 9 期：会话存储与断点续跑——resume 不是读文件，是重放

> **Harness 拆解课 · 第 9 期（共 10 期）**
>
> 第二个横切主题：会话怎么存、崩了怎么续。四家给了四种存储姿势——Pi 的懒落盘 jsonl、Codex 的 rollout 行、OpenCode 的一实体一文件、dsh 的 SQLite 事件行。但真正的分歧不在"存"，在"恢复"：**断点续跑的一致性，是恢复到哪一步算数。**

---

## 这期解决什么问题

- 四家的存储格式各长什么样？各自在防什么事故？
- resume 的三个一致性难题：半行写入、压缩后续点、空会话留痕。

---

## Step 1：拆 Pi——懒落盘的 append-only

证据在 `pi-mono/packages/coding-agent/src/core/session-manager.ts`。存储姿势极简：一会话一个 `<时间戳>_<id>.jsonl`，每条 entry 一行（L953）。精彩的是 `_persist`（L1015-1042）：

```ts
const hasAssistant = this.fileEntries.some(
  (e) => e.type === "message" && e.message.role === "assistant");
if (!hasAssistant) {
  if (this.flushed) { appendFileSync(...) }
  else { this.flushed = false }  // 攒着，不落盘
  return;
}
if (!this.flushed) {
  const fd = openSync(this.sessionFile, "wx");  // 独占创建
  ...一次性写全部 entry...
}
```

**第一条 assistant 消息到达之前，磁盘上不存在这个会话。** 用户开了终端、敲了半句话、关掉——不留垃圾文件。首次落盘用 `"wx"` 独占创建标志，一把写全。而 `_rewriteFile`（L979）只在版本迁移时整文件重写——append-only 是常态，重写是例外。resume 就是把 jsonl 逐行读回、`_buildIndex` 重建索引（L958-977），最后一条 entry 就是叶子。

## Step 2：拆 Codex——rollout 行与重放重建

证据在 `codex-rs/history/src/lib.rs`（L95-210）。每行是带信封的条目：

```rust
pub enum RolloutItem {      // L95：九种条目
    SessionMeta(SessionMetaLine),
    ResponseItem(ResponseItemEnvelope),
    Compacted(CompactedItem),   // ← 压缩检查点
    TurnContext(TurnContextItem),
    WorldState(WorldStateItem),
    EventMsg(EventMsg), ...
}
pub struct RolloutLine {    // L201
    pub timestamp: String,
    pub ordinal: Option<u64>,   // 单调序号
    #[serde(flatten)]
    pub item: RolloutItem,
}
```

关键在 `CompactedItem`：除了摘要文本，还带 `replacement_history`（被顶替的历史）和一组 window id。resume 走 `session/rollout_reconstruction.rs`——**不是把文件读回来就完事，而是重放**：按 turn 边界切段、逐段重建 baseline（`TurnReferenceContextItem` 区分"从未设置 / 被压缩作废 / 最新"三态）、从最近的压缩点往后接。`InitialHistory` 枚举（L213-219）把恢复结果分成 `New / Cleared / Resumed / Forked` 四种出身，`forked_from_id` 留血缘。**存储的是事件，恢复的是状态——这两件事的代码量差了一个数量级，这就是 resume 贵的地方。**

## Step 3：拆 OpenCode——一实体一文件，再迁 SQLite

证据在 `opencode/packages/opencode/src/storage/storage.ts`（L97-165）。早期格式是三层目录的 JSON 文件：

```text
storage/session/info/{sessionId}.json        ← 会话元数据
storage/session/message/{sessionId}/{msgId}.json   ← 消息
storage/session/part/{sessionId}/{msgId}/{partId}.json  ← 消息分片
```

一条消息改一个 part，只写一个几 KB 的小文件，不用碰别的——**写放大最小，但读一次会话要开一堆文件**。迁移逻辑（glob 遍历旧目录灌进新表）就写在 storage.ts 里，新格式是 SQLite 的 `SessionTable / MessageTable / PartTable`（storage/schema.ts L3）。第 4 期拆过的会话分叉在这套存储上天然成立：fork 就是复制一段消息行、换个 sessionId。

## Step 4：拆 dsh——SQLite 事件行 + packed 行

证据在 `deepseek-harness/packages/session/session-persistence-sqlite/src/schema.ts`（L18-46）：

```ts
export const SCHEMA_VERSION = 17       // schema 自己带版本
export interface EventRow {
  readonly seq: number                 // 单调序号
  readonly type: string
  readonly data: string | Uint8Array   // 可以是压缩后的字节
  readonly source_event_seqs: Uint8Array | null  // packed 行的血缘
  readonly ignorable: number | null    // 重放时可跳过的标记
}
```

三个细节：**packed 行**——多个逻辑事件打包进一个物理行（store.ts 的 `MAX_PACKED_ROW_MEMBERS`），`source_event_seqs` 记下打包前的原始序号，回放能还原顺序；**ignorable 标志**——有些事件重放时可跳过，格式自己声明这一点；**revision 单调递增**（SessionRow.revision）——并发写靠版本号防覆盖。journal 模式可选 WAL——崩溃恢复交给 SQLite，应用层只管事件语义。

---

## 造——session-log.ts：resume 的一致性三问

移植进沙箱 111 行：`SessionLog`（懒落盘 + append-only 序列化 + Compacted 检查点）和 `resumeFromLog`（重放：坏行跳过计数、从最近检查点起算、被顶替条目进审计区）。

## 跑起来看看：断电、重放、事实还活着

`demo-hns-09.ts` 先造一段含压缩检查点的会话，把最后一行截成半行模拟断电，重放 resume，再把恢复的历史喂给**真实的 DeepSeek 模型**追问：

```text
── 第二幕：模拟断电 ──
  ├ 最后一行只剩：{"type":"message","id":

── 第三幕：重放 resume ──
  ├ 丢弃坏行：1；从检查点续跑：true
  ├ 恢复出 3 条（header + 检查点 + m5；m6 半行丢了）
  ├ 审计区（被顶替的原始消息）：4 条——没进模型上下文，但一条没丢

── 第四幕：真实模型验证恢复一致性 ──
  ├ 模型回答：上线日期是8月30日；部署在Fly.io；域名是zmzai.cloud。
  ▶ 事实抽查：日期=true，Fly.io=true，域名=true
```

断电丢了半行，检查点前的四轮对话早已不在上下文里——但三个事实全部从检查点摘要里活了过来。**崩溃损失被 append-only 锁在最后一行，压缩损失被检查点的摘要兜住。**

---

## 确定性测试

`test-session-log.ts` 19 项：懒落盘三态、每行一条、全量重放、半行容错（含空行不算坏行）、检查点续跑（顶替条目绝不进模型上下文）、多检查点取最近。累计 **276 断言全绿**。

---

## 这期学到了什么

| 家 | 格式 | 崩溃防线 | resume 姿势 |
|---|---|---|---|
| Pi | 一会话一 jsonl | append-only，最坏丢尾行 | 逐行读回重建索引；空会话不落盘 |
| Codex | rollout 行（九种条目） | ordinal 单调序号 | 重放重建：turn 分段 + 压缩点接续 |
| OpenCode | 一实体一 JSON → SQLite | 写放大最小 | 文件即状态，直接读 |
| dsh | SQLite 事件行 | WAL + revision | 事件重放；packed 行靠血缘还原 |

四条心法：

1. **append-only 是最好的崩溃保险**——不改写旧行，崩溃损失的上界就是"最后一行"。Pi 和 dsh 都是这个姿势，差别只在行里装多少。
2. **压缩必须留检查点，检查点必须留血缘**——Codex 的 `replacement_history`、我们的 `superseded` 审计区：摘要进上下文，原文进档案，两者都不丢。
3. **resume 是重放不是读取**——存的是事件流，恢复的是派生状态。指望"文件内容=内存状态"的系统，一做压缩和分叉就圆不回来。
4. **懒落盘省下的不只是空间**——Pi 不给空会话建文件，会话列表里就没有一堆"打开即关掉"的幽灵。存储策略也是产品体验。

---

## 课后练习

1. 给 `SessionLog` 加真正的文件 IO：`flushTo(path)` 用 append 模式逐行写，再写一个 `resumeFromFile` 用流式逐行读（大文件不能整个读进内存）。试试在 `write` 到一半 kill 掉进程，验证恢复结果。
2. 检查点现在只顶替消息。扩展它：检查点同时记录"工具执行状态快照"（哪些工具在跑、哪些完成了），resume 时把 running 状态的工具标记为 interrupted 而不是假装完成。想想为什么"假装完成"比"丢失"更危险。
3. dsh 的 packed 行把多个事件压进一行。给 `SessionLog` 实现 `pack(consecutiveAssistantRuns)`：连续的 assistant 片段打包成一行、`sourceIds` 留血缘，并验证重放后顺序不变。

---

## 下期预告

毕业课。第 10 期：拿 9 期攒下的零件回头改造 zmzai-agent——它现在最缺什么？压缩、分叉、还是权限？装上最能提命的三件，跑一遍基准回归，看改造前后的真实差异。
