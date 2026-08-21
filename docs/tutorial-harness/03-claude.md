# 第 3 期：Claude Code——分层指令、权限规则与钩子执法

> **Harness 拆解课 · 第 3 期（共 10 期）**
>
> Claude Code 不开源，但它的证据链全在你机器上：`~/.claude/` 目录里的 settings.json、CLAUDE.md、hooks 配置，加上官方文档，足够把三个核心机制拆清楚——指令从哪来、权限规则怎么裁决、钩子为什么是"执法"而不是"劝说"。这期造一个分层指令加载器和一个钩子引擎，用真实 shell 钩子 + 真实 LLM 验证。

---

## 这期解决什么问题

上期 Codex 用两个旋钮管"能力"和"打扰"。Claude Code 面对的是另一组问题：

- **指令放哪？** 用户习惯（用中文）、项目约定（测试用 vitest）、子模块规矩（禁改 legacy/）——三层指令住在不同地方，怎么拼进同一个提示词，谁覆盖谁？
- **审批疲劳怎么办？** 第十次点"允许"时你已经不在审查了，只是在点按钮。怎么让高频安全操作自动放行、危险操作永远拦住？
- **模型不听话怎么办？** system prompt 里写了"不要读 .env"，模型该读还是读。确定性的边界到底该由谁来守？

三个答案：CLAUDE.md 分层、permissions 三色规则、hooks 钩子。

---

## Step 1：拆 CLAUDE.md——指令的行政区

官方文档（best-practices「Extend CLAUDE.md」）给出的层级：

- `~/.claude/CLAUDE.md`：**全局层**。编码风格、语言偏好，所有项目生效。你本机就有一个（"请始终使用中文回复"——五个字，但每次会话都起效）；
- 项目根 `CLAUDE.md`：**项目层**，启动时载入；
- **父目录链**：monorepo 场景，`root/CLAUDE.md` 和 `root/foo/CLAUDE.md` 都会被拉入；
- **子目录**：处理该目录下的文件时**按需拉入**（pull in on demand）——这是省 token 的关键：不碰前端代码，前端的规矩就不进上下文。

两个工程细节值得抄：

**顺序即权重。** 越具体的层排得越靠后（离模型输出最近）。全局说"简洁"，子模块说"这个目录必须写详细注释"，后者赢——不是靠任何优先级算法，就是靠"后说的算"这个朴素的注意力规律。

**来源标记。** 每层拼进提示词时带上来源（哪个文件、哪一层）。模型违反规则时你能定位是哪层说的、该改哪层——没有标记的分层指令，出了问题只能三层文件挨个翻。

---

## Step 2：拆 permissions——交通灯裁决

settings.json 里的权限规则是三个数组（官方文档 + 社区实测交叉验证）：

```json
{
  "permissions": {
    "allow": ["Bash(npm run test)", "Bash(npm run lint)"],
    "ask":   ["Bash(git commit)", "Bash(git push)"],
    "deny":  ["Bash(rm -rf /)", "Read(**/.env)"]
  }
}
```

规则语法 `Tool(specifier)`：裸工具名匹配全部调用，说明符支持精确匹配、前缀通配（`Bash(git *)`，`Bash(git:*)` 是等价写法）、gitignore 风格路径（`Edit(docs/**)`）、域名（`WebFetch(domain:*.github.com)`）。

裁决顺序固定：**deny → ask → allow，deny 永远赢**。而且 deny 规则跨所有配置层合并——企业策略、用户、项目、local 四层配置里任何一层写了 deny，都拦得住。这个方向性是刻意的：**放行可以分层授予，禁止必须处处生效。** 和"最小权限"同一个方向：安全配置的默认合力永远是收紧。

再往上还有一层权限**模式**（default / acceptEdits / plan / auto / bypassPermissions……），控制"问不问人"的整体档位——注意，这和上期 Codex 的双轴是同一个思想的不同实现：规则管"具体动作的裁决"，模式管"打扰预算的总开关"。

---

## Step 3：拆 hooks——提示词是劝说，钩子是执法

钩子是挂在生命周期事件上的外部命令。协议（官方 hooks 文档）：

- **输入**：stdin 喂 JSON，含 `hook_event_name`、`tool_name`、`tool_input`；
- **退出码语义**：`0` = 放行（stdout 若是合法 JSON 则解析结构化决策）；`2` = **阻断**（stderr 内容作为拒绝原因喂回模型）；其他非零 = 非阻塞错误，记日志继续——钩子自己崩了不能连累主流程；
- **结构化决策**：exit 0 时 stdout 可输出 `hookSpecificOutput.permissionDecision`：`allow` / `deny` / `ask` / `defer`（交回正常权限流程）；
- **多钩子冲突**：deny > ask > allow——和 permissions 的裁决方向一致；
- **事件面很宽**：PreToolUse、PostToolUse、PermissionRequest、Stop、PreCompact……三十来个，其中只有部分能阻断（PreToolUse 是唯一能在工具执行前拦的），其余是观察位（日志、通知、上下文注入）。

一个真实的生产案例（社区复盘）：某团队在 `.claude/settings.json` 挂了 PreToolUse 钩子匹配 `rm -rf` 开头的命令，钩子去调内部审批服务走 Slack 确认，被拒就 exit 2——**钩子不该只当 allow/deny 的二元开关，它是把决策权接回你现有审批流（Slack、ITSM）的插座。**

为什么这是"执法"？提示词写给模型，模型可以无视；钩子在模型之外、工具执行之前跑，exit 2 不经过模型同意。**凡是你承受不起被违反的规则，都不该只写在提示词里。**

---

## Step 4：造——instructions.ts 与 hooks.ts

沙箱产物两个文件。**instructions.ts**：`loadInstructions` 按 user → 父目录链 → 子目录（从文件所在目录往上走到项目根，沿途的 CLAUDE.md 都算数）收集，同文件去重；`assembleInstructions` 带来源标记拼接。**hooks.ts**：`HookEngine` 按事件 + 正则 matcher 筛钩子，runner 可注入（测试用假实现，生产用真实 `spawn` + stdin 喂 JSON），退出码语义照抄官方协议。

```ts
// hooks.ts（节选：退出码即协议）
if (code === 2) {
  outcome = { decision: "deny", reason: stderr.trim(), by: hook.command };
} else if (code === 0) {
  outcome = this.parseStdout(stdout, hook.command); // 找 permissionDecision
} else {
  console.log(`⚠ 钩子异常（exit ${code}），跳过`); // 非阻塞
  outcome = { decision: "pass" };
}
```

接线方式：钩子决定**先于**人工审批——`deny` 直接拒（不等人）、`allow` 直接放（不打扰）、`pass`/`defer` 才落到人手里。这正是 PermissionRequest 钩子在 Claude Code 里的位置："原本要问用户时，我来接管这个问题"。

---

## 跑起来看看：钩子守 .env 和 rm

`demo-hns-03.ts` 里两个真实 shell 钩子脚本（bash 写的，走 stdin/exit 2 协议）：`guard-env.sh` 挂 read，见 `.env` 就 exit 2；`guard-rm.sh` 挂 bash，见 `rm` 就 exit 2。任务故意三步走：读 config.json（该过）、读 .env（该拦）、跑 rm（该拦）。

```text
  ⚠ 钩子 pass：交回人工审批 → 批准一次
  ├ read ✓ { "port": 8080, "name": "demo" }
  ⛔ 钩子拦截（没到人手里）：禁止读取 env 文件：那里存着密钥，不要重试。…
  ├ read ✗ 权限被拒绝：read: .env——禁止读取 env 文件：…（策略拒绝，不要重试）
  ⛔ 钩子拦截（没到人手里）：禁止 rm：本沙箱不允许删除文件…
  ├ bash ✗ 权限被拒绝：bash: rm junk.tmp——禁止 rm：…

▶ .env 完好（钩子执法的证据）："DB_PASSWORD=hunter2\nAPI_SECRET=do-not-leak\n"
```

读法：config.json 走的是"钩子不管 → 问人 → 批准"；.env 和 rm 在到达人之前就被 exit 2 办结了。三种路径，一次运行全演示。

实跑揪出三个故事：

**故事一：拒绝理由被吞，模型瞎重试。** 第一版里钩子的 stderr 理由只在终端打印，喂回模型的错误文案只有一句干巴巴的"用户拒绝了：read: .env"——模型不知道为什么被拒，连试 8 次。修复：给 `Reply` 加"带原因的拒绝"，钩子的 stderr 原样接进错误文案。**拒绝必须带理由，而且理由要说给模型听**——这和上期 Codex 的 deny 文案是同一课，两家公司各自踩过。

**故事二：劝不动的任务性重试。** 加了理由和"不要重试"之后，模型还是反复锤 .env——因为任务文案明确要求它读。这是本期最重要的结论：**当任务本身要求某个动作时，一切提示词层面的劝阻都失效；安全靠钩子的机制层执法（.env 从头到尾分毫未动），体验靠护栏的机制层止损**（断路器该把这种重复拒绝熔断——上期留的账，这期又见了一次）。

**故事三：小坑两枚。** 钩子 matcher 是正则、大小写敏感——Claude Code 的工具名是 `Read`/`Bash`，我们的工具 id 是小写 `read`，照抄示例 matcher 会静默失配（钩子不报错，只是永远不命中，最阴险的那种坏）。另外 shell 钩子里 grep 处理多字节文本记得设 `LC_ALL`，否则中文理由会传出乱码。

---

## 确定性测试

`test-hooks.ts` 14 项：exit 2 → deny 且 stderr 是理由；exit 0 + JSON `permissionDecision` → 对应决策；非 JSON stdout = 观察型钩子不干预；钩子自己崩（exit 1）不连累主流程；matcher 正则不命中 = pass；三个钩子打架 deny 赢。分层指令 6 项：全局/项目层拉入、子目录按需、组装顺序与来源标记、去重。加上此前全部，累计 **159 断言全绿**。

---

## 这期学到了什么

| 机制 | Claude Code 的做法 | 可抄的心法 |
|---|---|---|
| 分层指令 | 全局 → 项目 → 子目录按需拉入 | 顺序即权重；来源标记；不碰不拉（省 token） |
| 权限规则 | allow/ask/deny 三色，deny 永远赢且跨层合并 | 放行分层授予，禁止处处生效 |
| 钩子 | 外部命令，exit 码即协议，先于人工审批 | 提示词是劝说，钩子是执法；钩子是接回现有审批流的插座 |
| 拒绝文案 | 拒绝理由喂回模型 | 拒绝必须带理由，理由说给模型听 |

关键心智模型：**规则的强度取决于它住在哪一层。** 住在提示词里是建议，住在权限规则里是流程，住在钩子里是物理定律。承受不起被违反的规矩，往下层放。

---

## 课后练习

1. 给 `HookEngine` 加 PostToolUse 支持：工具成功后跑格式化钩子（比如 `prettier --write`），钩子 stdout 的 `additionalContext` 注入回模型。想想 PostToolUse 的 deny 还有意义吗？（文件已经写完了。）
2. 实现 permissions 的 `Tool(specifier)` 规则解析：支持 `Bash(git *)` 前缀通配和 `Read(**/.env)` 路径模式，接进 `evaluate`。deny > ask > allow 的裁决顺序别写反。
3. 把本期 demo 的重试风暴治掉：权限拒绝也进断路器记账（上期同款练习）。提示：区分"同参数重复拒绝"和"换参数新尝试"，只对前者熔断。

---

## 下期预告

OpenCode——四家里唯一完全开源的工业级 harness。我们把它的 agent 循环逐行读穿，看会话分叉（fork）怎么做，然后把 fork 移植进 mini-agent。
