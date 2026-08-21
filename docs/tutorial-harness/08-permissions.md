# 第 8 期：权限与沙箱七家横评——同一个动作，六张裁决书

> **Harness 拆解课 · 第 8 期（共 10 期）**
>
> 横切课开始。前七期我们一家一家拆，这期把六套权限模型摆在同一张桌上。测试方法很简单：拿同一个越界动作——写 `~/.ssh/authorized_keys`——挨家问一遍。结果是六张完全不同的裁决书：有的问人，有的直接拒，有的放行。**权限模型不是实现细节，是产品的价值观。**

---

## 这期解决什么问题

- 六家的权限系统各长什么样？证据全部钉到源码行级（Pi 的证据在 README 里——"没有"也是一种设计）。
- 给你自己的 agent 选权限模型时，该看哪几个维度？

---

## Step 1：拆 Codex——双轴分离

证据在 `codex-rs/protocol/src/protocol.rs`。两个独立的枚举：

```rust
pub enum AskForApproval {   // L916
    UnlessTrusted,   // untrusted：只有"已知安全"的只读命令自动过
    #[default] OnRequest,  // 模型决定何时问（别名 on-failure）
    Granular(GranularApprovalConfig),  // 按类别细粒度开关
    Never,           // 从不问人，失败直接回给模型
}

pub enum SandboxPolicy {    // L1003
    DangerFullAccess,        // "No restrictions whatsoever. Use with caution."
    ReadOnly { network_access: bool },
    ExternalSandbox { ... }, // 已在外部沙箱里
    WorkspaceWrite { writable_roots: Vec<AbsolutePathBuf>, ... },
}
```

两个轴回答两个不同的问题：**沙箱回答"技术上能做什么"（能力上限），审批回答"什么时候停下来问人"（打扰预算）**。两者独立可调——可以"能力全开但每步都问"，也可以"能力收紧但从不打扰"。注意 `ReadOnly` 连网络都要显式开——默认无网络。

## Step 2：拆 Claude Code——deny 永远赢

Claude Code 闭源，但权限协议是公开的：四层配置（企业 → 用户 → 项目 → local）合并，裁决顺序固定 **deny → ask → allow**。方向性是刻意的：**放行可以分层授予，禁止必须处处生效**。第 3 期拆过的钩子在这套模型里的位置也值得重申：钩子在"问人"之前接管，exit 2 拦截不经过模型同意——凡是你承受不起被违反的规则，都不该只写在提示词里。

## Step 3：拆 OpenCode——findLast 与 ARITY 字典

证据在 `opencode/packages/opencode/src/permission/index.ts`（L28-38）：

```ts
export function evaluate(permission, pattern, ...rulesets) {
  return rulesets.flat()
    .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))
    ?? { action: "ask", permission, pattern: "*" }
}
```

三个细节各有心思：

**① findLast，不是优先级算法。** 后写的规则覆盖先写的，合并策略就是"追加"。规则系统一旦引入优先级矩阵，用户就再也推不出结果——OpenCode 用"最后一句话算数"换可预测性。默认兜底是 `ask`。

**② 拒绝级联 + always 学习**（L121-166）。拒绝一个请求时，**同会话排队中的所有其他请求一起拒**——用户说"不"的时候，不该让后面的请求继续敲门。批准选 always 时，规则学进会话记忆，还会回头自动放行因这条规则新满足而解锁的排队请求。

**③ ARITY 字典**（`permission/arity.ts`）。权限匹配的对象不是原始命令串，而是"人能理解的命令"：`git checkout main` → `git checkout`（git 的 arity 是 2），`npm run dev` → `npm run dev`（npm run 的 arity 是 3）。注释里甚至留了生成这张表的提示词——**权限规则的粒度要对齐人的心智，不是 shell 的语法**。

## Step 4：拆 Gemini CLI——目录信任链

证据在 `gemini-cli/packages/core/src/utils/trust.ts`。`checkPathTrust`（L46-79）是一条固定优先级链：

```text
环境变量 GEMINI_CLI_TRUST_WORKSPACE（true/false 都认）
  → 信任功能开关（关掉=默认放行）
    → IDE 声明的工作区信任状态
      → 本地信任文件规则
```

规则匹配（L153-193）是**最长前缀**：父目录 `TRUST_FOLDER` + 子目录 `DO_NOT_TRUST`，进子目录照样拦。最妙的是 `TRUST_PARENT`——用户在弹窗里选"信任父目录"时，规则记在子目录名下、生效范围算给父目录，把"这次的弹窗是从哪来的"留了痕。无规则命中返回 `undefined`——首次进入该目录，启动时问一次。

## Step 5：拆 Pi——"没有"也是设计

证据不在代码里，在 `pi-mono/README.md`（L38-40）：

> *"Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it."*

coding-agent 的 README 补了一句产品主张（L502）：**"No permission popups."** 跑在容器里，或者用扩展自建确认流。这和我们第 6 期看到的极简派一脉相承：**权限系统做不好就是虚假安全感，不如把隔离交还给部署环境**——容器边界是操作系统级的，比应用层弹窗硬得多。

## Step 6：拆 dsh——严格加宽的升级阶梯

证据在 `deepseek-harness/packages/sandbox/sandbox/src/escalation.ts`。这是六家里最"数学"的一套：

```ts
export const WIDER_MODES: Record<string, readonly SandboxMode[]> = {  // L28
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}
```

`approveEscalation`（L157-189）是一条 **fail-closed 序列**：① 目标模式必须**严格宽于**当前模式，否则拒绝——且不弹给人（"非加宽请求从不打扰人"）；② `sandbox_permissions` 和 `justification` 必须成对出现，理由还不能是空话；③ 没有审批服务、没有 agent 路由——拒绝；④ 才轮到问人；⑤ 四种回复逐一映射，没有默认分支。配套的 `sandbox-policy`（index.ts L94）把部署默认钉在 `read-only`——fail-safe。**授权只盖这一次调用**（allowed-once），下一轮想写还得重新申请。

---

## 造——perm-models.ts：六家判定器 + 统一词汇表

移植进沙箱 165 行：六家各一个最小判定器，裁决统一收敛到 `allow / ask / deny / block` 四词词汇表。第 2 期的 `sandbox-policy.ts`（Codex 双轴）直接复用；dsh 的 fail-closed 顺序原样照搬。

## 跑起来看看：同一个动作，六张裁决书

`demo-hns-08.ts` 把"写 `~/.ssh/authorized_keys`"分别交给六家，再让**真实的 DeepSeek 模型**扮演被沙箱拒绝后申请升级的 agent：

```text
── 实验一：写 ~/.ssh/authorized_keys，六家怎么裁 ──
  ├ Codex           → ask  （超出 sandbox=read-only 的能力，请求人工批准）
  ├ Claude Code     → deny （deny 规则命中（跨层合并，deny 永远赢））
  ├ OpenCode        → deny （deny 规则：edit ~/.ssh/*）
  ├ Gemini CLI      → deny （最长匹配规则：DO_NOT_TRUST）
  ├ Pi              → allow（无内置权限系统——跑在容器里，或用扩展自建确认流）
  ├ DeepSeek Harness → deny （目标并不严格宽于当前模式——不打扰人）

── 实验二：真实模型申请沙箱升级 ──
  ├ 模型的申请：{"requestedMode": "workspace-write", "justification": "需要写入
  │  /workspace/dist/bundle.js，workspace-write 模式足以满足需求。"}
  ▶ 用户批准 → allow：用户批准本次升级到 workspace-write（仅此一次调用）
  ▶ 下一轮再申请同一目标 → deny：目标并不严格宽于当前——不打扰人
```

两个看点。实验一：同一个动作，Codex 选择问人、Pi 选择放行、其余四家拒绝——**没有对错，只有立场**。实验二：真实模型面对"必须选刚好够用的最窄模式"的约束，真的选了 `workspace-write` 而不是贪心地要 `danger-full-access`，理由也说得通。但注意第二行：**授权只盖一次调用**——模型守规矩值得表扬，可系统从不依赖模型的自觉。

---

## 确定性测试

`test-perm-models.ts` 24 项：Codex 双轴独立性、Claude Code 跨层 deny、OpenCode findLast/always 学习、Gemini 信任链优先级/TRUST_PARENT、dsh fail-closed 五连。累计 **257 断言全绿**。

---

## 这期学到了什么

| 家 | 模型形状 | 默认姿态 | 升级路径 |
|---|---|---|---|
| Codex | 双轴：能力 × 打扰 | read-only + 按需问 | 人工批准可单次越界 |
| Claude Code | 多层规则，deny > ask > allow | 无规则就问 | 钩子在问人之前接管 |
| OpenCode | findLast 通配 + 会话记忆 | ask | always 学成规则 |
| Gemini CLI | 目录信任链 | 首次进入问一次 | TRUST_PARENT 挂父目录 |
| Pi | 无内置权限系统 | 全放行 | 容器 / 扩展自建 |
| DeepSeek Harness | 三档模式 + 严格加宽 | read-only（fail-safe） | 带理由申请，批准只盖一次 |

怎么选？**看你的 agent 跑在哪里。** 跑在用户本机上（Claude Code、Gemini、Codex 的默认形态）：必须有权限层，因为宿主机就是攻击面，deny 方向要处处生效。跑在一次性容器里（Pi 的姿势）：权限层可以省，把隔离交给操作系统，省下的复杂度换成确定性。介于两者之间（dsh 的姿势）：默认 fail-safe + 带理由的按次升级，把每次越界都变成审计记录。三条共同的心法：

1. **默认必须收紧**——Codex 默认 read-only、dsh 默认 read-only、OpenCode 兜底 ask、Gemini 无规则就问。四家不约而同。
2. **拒绝必须带理由，理由说给模型听**——第 2 期 Codex 的 deny 文案、第 3 期钩子的 stderr、dsh 的统一 denial marker，三家各自踩过同一个坑。
3. **授权要能过期**——dsh 的 allowed-once、OpenCode 的 once vs always 之分。永久授权攒多了，权限系统就成了一纸空文。

---

## 课后练习

1. 给 `OpenCodeGate` 补上拒绝级联：`reply(..., "reject")` 时把该会话排队的其他请求全部拒掉（提示：给 judge 加个队列返回 pending id）。想想为什么"拒绝要连坐，批准不用连坐"。
2. dsh 的 `justification` 只做非空校验。给它加一道"理由质量"关：调用真实 LLM 判断理由是否提到了具体要写的路径/文件，空话打回。注意这会让审批路径变慢——该同步拦还是异步记日志？
3. 把 Codex 的双轴和 dsh 的升级阶梯组合：沙箱拒绝 → 模型带理由申请升级 → 用户批准单次越界。给 `perm-models.ts` 写一个 `judgeHybrid`，并补 5 条断言。

---

## 下期预告

第 9 期：会话存储、resume 与断点续跑——Pi 的 append-only 树怎么落地成文件、Codex 的 rollout 行格式、OpenCode 的快照与分叉、dsh 的 session 事件流回放。断点续跑的真正难点不是"存"，是"恢复到哪一步算一致"。
