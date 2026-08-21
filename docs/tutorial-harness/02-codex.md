# 第 2 期：Codex CLI——apply_patch 与 approval×sandbox 双轴

> **Harness 拆解课 · 第 2 期（共 10 期）**
>
> 第一个上手术台的是 OpenAI 的 Codex CLI（开源，Rust 写的核心在 `codex-rs/`）。它有两个最值得拆的机制：一个是把"改文件"压缩成单一工具 `apply_patch` 的激进设计，一个是 `approval policy × sandbox mode` 两个独立旋钮的权限模型。这期把它们拆到源码行级，然后在沙箱里亲手造一遍，用真实 LLM 跑给你看。

---

## 这期解决什么问题

你的 mini-agent 第一部里有四个改文件的姿势：`write`、`edit`、`bash` 里跑命令、还有各种组合。Codex 做了一个激进的减法：**模型手里只有一个改文件的工具——`apply_patch`**。没有逐文件读改写，没有 sed，一个补丁文本提交上去，多个文件一次落盘。

为什么敢这么砍？拆完你会发现，这不是偷懒，是一套环环相扣的取舍。而权限模型那一轴，回答的是另一个问题：**能力给多少**和**打扰人多少次**，为什么必须是两个独立旋钮。

---

## Step 1：拆 apply_patch——一个补丁格式背后的三层理由

一手证据在 `openai/codex` 仓库的 `codex-rs/apply-patch/src/parser.rs`，文件头直接给了 Lark 文法：

```text
start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
add_hunk:    "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
change_context: ("@@" | "@@ " 文本) LF
change_line:    ("+" | "-" | " ") 文本 LF
eof_line:    "*** End of File" LF
```

长这样：

```text
*** Begin Patch
*** Update File: src/math.js
@@ add 函数
-function add(a, b) { return a - b; }
+function add(a, b) { return a + b; }
*** Add File: tests/math.test.js
+assert(add(2, 3) === 5);
*** End Patch
```

三层理由，一层比一层深：

**第一层：原子性。** 一次工具调用改多个文件，要么全部落盘要么全部不落。用 `write`/`edit` 一个个改，改到第三个文件时模型断线了，仓库停在半改状态。补丁是一个事务。

**第二层：上下文匹配代替行号。** `@@` 块里的 `-` 行必须与文件原文**逐字相等**才允许替换（对应 `seek_sequence.rs` 的行级匹配）。模型不需要数行号——行号是模型最容易幻觉的东西；它只需要复制它看见的那几行。匹配失败时错误信息精确到"哪段上下文没找到"，模型下一轮能自己修正。

**第三层：为模型的坏毛病留后门。** parser.rs 第 24 行原话：*"The parser below is a little more lenient than the explicit spec"*；第 47-53 行更直白——为了伺候 gpt-4.1 这类会在标记行前后多吐空白的模型，`PARSE_IN_STRICT_MODE` 被钉死成 `false`。**格式规范写给理想模型，解析器写给真实模型。** 这是全仓库最值得抄的一句话。

---

## Step 2：拆双轴权限——能力面和打扰预算必须分开

证据在 `codex-rs/app-server-protocol/src/protocol/v2/shared.rs`（第 303 行）和 `codex-rs/protocol/src/protocol.rs`（第 916 行）：

```rust
pub enum SandboxMode { ReadOnly, WorkspaceWrite, DangerFullAccess }

pub enum AskForApproval {
    UnlessTrusted,   // untrusted：只有"已知安全的只读命令"自动放行
    OnRequest,       // on-request / on-failure：模型自己决定何时问
    Granular(...),   // 细粒度到各类审批流
}
```

两轴各回答一个问题：

- **sandbox 回答"技术上能做什么"**——操作系统级的能力上限。read-only 就是字面意义的只读，workspace-write 只能写工作区，danger-full-access 放开一切。
- **approval 回答"什么时候停下来问人"**——流程级的打扰预算。untrusted 档步步都问，never 档从不打扰。

关键是**两者独立可调**。四个象限里最有意思的两个：

- "能力放开但每步都问"（danger-full-access × untrusted）：全自动模式的极端保守版——什么都能干，但每一下都要人点头；
- "能力收紧但从不打扰"（read-only × never）：CI 里跑代码审查的完美档位——读得够多，问得为零，越界直接拒。

还有一个精妙的联动：**沙箱拒绝不是死路。** 技术上越界的动作，只要审批档不是 never，就转成 ask——把决定权交给人。人工批准可以覆盖沙箱边界。拒绝是默认的，但不是终局的。

---

## Step 3：造——apply-patch.ts 与 sandbox-policy.ts

沙箱产物两个文件。**apply-patch.ts** 照文法实现解析器，`parsePatch` 返回 Hunk 数组，任何格式错误抛带行号的 `PatchError`；`applyPatch` 把 hunks 应用到目录，所有路径先过圈禁检查（复用进阶篇 `resolveWithin` 的思路——补丁格式里写 `../../etc/passwd` 是没用的）：

```ts
// apply-patch.ts（节选：Update 块的行级匹配）
export function applyUpdate(original: string, hunk: ...): string {
  const lines = original.split("\n");
  let cursor = 0; // chunks 必须按序出现——出处：parser.rs 的 Hunk 注释
  for (const chunk of hunk.chunks) {
    const at = findSequence(lines, chunk.removes, cursor);
    if (at === -1) {
      throw new PatchError(`context not found in ${hunk.path}: ...`);
      // ↑ 模型会看到哪段没匹配上，下一轮自己修正
    }
    lines.splice(at, chunk.removes.length, ...chunk.adds);
    cursor = at + chunk.adds.length;
  }
  return lines.join("\n");
}
```

**sandbox-policy.ts** 把双轴写成一个纯函数，60 行，零依赖：

```ts
export function decide(action: Action, sandbox: SandboxMode, approval: ApprovalPolicy): Decision {
  const technicallyAllowed =
    action.kind === "read" ? true
    : sandbox === "danger-full-access" ? true
    : sandbox === "workspace-write" && action.kind === "write";

  if (!technicallyAllowed) {
    if (approval === "never") return { verdict: "deny", ... };  // 没人可问
    return { verdict: "ask", ... };  // 沙箱拒绝可被人工批准覆盖
  }
  switch (approval) {
    case "untrusted": return action.trusted ? { verdict: "allow" } : { verdict: "ask" };
    case "on-failure": return action.failedBefore ? { verdict: "ask" } : { verdict: "allow" };
    default: return { verdict: "allow" };  // on-request / never：沙箱内不打扰
  }
}
```

纯函数是刻意的：判定逻辑不碰文件系统、不问用户，才能被确定性测试穷举。

---

## 跑起来看看：同一个任务，两轴拨到不同档位

`demo-hns-02.ts` 给 agent 只装两个工具（`read` + `apply_patch`——能力面先收窄，再谈审批），任务：改一行 + 新建一个文件。两幕：

```text
═══ act1：sandbox=workspace-write × approval=untrusted
    双轴编译出的规则：read→ask，edit→ask，bash→ask
  ⚠ [act1] 权限闸口来问了：read: greeting.txt → 批准一次
  ├ read ✓ hello world this file needs a second line
  ⚠ [act1] 权限闸口来问了：apply_patch: * → 批准一次
  ├ apply_patch ✓ updated greeting.txt
  ├ apply_patch ✓ added note.txt
  ▶ greeting.txt 现状："hello world\nthis line has been patched\n"

═══ act2：sandbox=read-only × approval=never
    双轴编译出的规则：read→allow，edit→deny，bash→deny
  ├ read ✓（不打扰，直接过）
  ├ apply_patch ✗ 权限被拒绝：edit *
  ├ apply_patch ✗ 权限被拒绝：edit *   ← 模型不甘心，连试 14 次
  ▶ greeting.txt 现状："hello world\nthis file needs a second line\n"（分毫未动）
```

两幕对照，双轴的语义一目了然：act1 里每个动作都来问（untrusted），批准照常干活；act2 里读畅通无阻、写一律拒绝、零打扰，文件分毫未动。

但实跑揪出了**两个没写进脚本的真实故事**，都比成功路径值钱：

**故事一：接线缝里的 bug。** 第一版实跑时，act2 的 `apply_patch` 居然放行成功了——文件被改了。排查发现：loop 的权限闸口按工具名映射权限键，`apply_patch` 不在映射表里，落进 `"*"` 兜底，而我们写的 `edit→deny` 规则根本匹配不上。**新工具的权限映射没人强制你补——这是注册新工具时最容易漏的一根线。** 修复后重跑才得到上面 act2 的干净拒绝。教训：每加一个工具，把"它的权限键是什么"当成 checklist 的一项。

**故事二：护栏记不住策略拒绝。** act2 里模型连撞 14 次墙才停（撞了 maxSteps）。断路器不是 5 连败就熔断吗？没熔——因为权限拒绝在流水线里走的是 `continue`，**发生在记账之前**：断路器和失败守卫压根不知道发生过拒绝。这和第 8 期总装图里"格式损坏不记账"是同一个设计哲学的反面：**策略拒绝不是格式损坏，它是明确的行为信号，模型反复试探时理应熔断。** Codex 自己怎么处理？它的 deny 文案会明确告诉模型"不要重试"。要么记账，要么把话说死——两头都不占，就会收获 14 次无效重试。

---

## 确定性测试

`test-apply-patch.ts` 16 项：Add/Update/Delete/Move/EOF 追加全格式覆盖、空白宽容、路径逃逸拦截、上下文不匹配报错带位置、chunks 乱序拒绝。`test-sandbox-policy.ts` 13 项：3×4 档位矩阵抽样 + **两轴正交性**（只动沙箱轴结果变、只动审批轴结果变——这是"独立旋钮"的数学表达）。加上前八期的 116 项，全套 **145 断言全绿**。

---

## 这期学到了什么

| 机制 | Codex 的做法 | 可抄的心法 |
|---|---|---|
| apply_patch | 单一补丁工具，事务式多文件落盘 | 上下文匹配代替行号；错误信息精确到没匹配的段 |
| 宽容解析 | 标记行容空白，默认非严格模式 | 格式规范写给理想模型，解析器写给真实模型 |
| 双轴权限 | sandbox（能力）× approval（打扰）独立可调 | 能力面和打扰预算必须分开；沙箱拒绝可被人工覆盖 |
| 默认档位 | sandbox 默认 read-only | 默认值选最保守的，放权要显式 |

关键心智模型：**权限不是一个开关，是两个旋钮。** 任何时候你想用一个布尔值表达"这个 agent 安不安全"，先问：我是不是把能力面和打扰预算搅在一起了？

---

## 课后练习

1. 给 `applyUpdate` 加"模糊匹配降级"：逐字匹配失败时，容忍行尾空白的差异再试一次。想想这个宽容该止步于何处——为什么 Codex 只对标记行宽容、对内容行严格？
2. 把 act2 的 14 次无效重试治掉：给 loop 的权限拒绝分支加记账（`breaker.recordResult(false, ...)`），或者把拒绝文案改成"此动作被策略永久禁止，不要重试"。比较两种方案的副作用：记账会不会误伤"换个参数就能过"的场景？
3. `decide()` 现在把 `on-request` 和 `never` 处理成一样（沙箱内不打扰）。真实的 Codex 里 `on-request` 允许**模型主动请求升级**（比如它判断需要装依赖）。给 `Action` 加一个 `modelRequestedApproval` 字段，把这个语义补上。

---

## 下期预告

Claude Code。它没有开源，但 `~/.claude/` 目录里躺着完整的证据链：CLAUDE.md 三级分层指令、settings.json 的权限规则、hooks 钩子。我们拆它的"指令从哪来、按什么顺序叠进提示词"，然后造一个配置加载器。
