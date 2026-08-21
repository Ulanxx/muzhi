# 第 7 期：子代理与权限隔离——写路径就是权限边界

> **Agent 健壮性进阶篇 · 第 7 期（共 8 期）**
>
> 前六期的护栏都装在主循环里。但真实的 Agent 会派**子代理**干活：起一个独立循环去跑子任务，主循环只收一份结论。子代理一旦有工具权限，问题就来了——它往主代理的目录里乱写文件怎么办？这期做 `task.ts` 子代理工具：**写路径就是权限边界**，子代理被圈在自己的沙箱目录里，跨界的写操作直接拒绝。

---

## 这期解决什么问题

子代理模式的好处很实在：子任务的过程细节（几十次工具调用的输出）不进主循环的上下文，主循环只收一段结论——上下文窗口和提示词缓存都受益。

但子代理本质上是"另一个模型在开盲盒"。它拿到工具权限后：

- 可能往你的工作目录乱写中间产物；
- 可能被任务描述里的内容带偏（提示词注入的老问题）；
- 出错时的重试风暴烧的是同一个钱包。

第一部的循环把工具集写死了（`builtinTools`），子代理没法拉一份受限工具集。所以这期分三步：先把循环改成**工具集可注入**，再做**路径守卫**，最后组装 `task` 工具。

---

## Step 1：循环支持工具集注入

`loop.ts` 的改动很小——把三处写死的地方参数化：

```ts
// LoopOptions 新增
/** 【进阶篇第 7 期新增】工具集注入：不传用内置全集（子代理传受限工具集） */
tools?: ToolDef[];
```

```ts
// runAgent 开头
// 【进阶篇第 7 期新增】工具集：默认内置全集，子代理注入受限集
const toolset = options.tools ?? builtinTools;
const lookupTool = (name: string): ToolDef | undefined => toolset.find((t) => t.id === name);

// schema 列表从 toolset 生成（原来写死 allToolsToSchema()）
const tools = toolset.map(toolToSchema);

// 查找工具、工具名修复都走 lookupTool（原来写死 findTool / builtinTools）
let def = lookupTool(call.name);
if (!def) {
  const fixedName = repairToolName(call.name, toolset.map((t) => t.id));
  ...
}
```

注意工具名修复也跟着切到 `toolset`——子代理的工具集里没有 `bash`，模型喊 `bash` 时不能被"修复"出一个它不该有的工具。**权限边界内的所有机制都要认识边界**。

---

## Step 2：路径守卫——resolve 而不是 join

新建 `task.ts`。第一件武器是路径守卫。先看内置工具怎么处理路径：

```ts
// tools.ts 里的 writeTool
const fullPath = join(ctx.cwd, args.path);
await writeFile(fullPath, args.content, "utf8");
```

`join` 只做拼接，不挡 `../`。模型传 `path: "../escape.txt"`，文件就写到沙箱外面去了。守卫用 `resolve` 解析后验边界：

```ts
// task.ts
import { resolve, sep } from "node:path";

/**
 * 路径守卫：把相对路径解析到 root 之下，越界直接抛错。
 * 用 resolve 而不是 join——join 不挡 ../，这是越权写最常见的姿势。
 */
export function resolveWithin(root: string, p: string): string {
  const rootNorm = resolve(root);
  const full = resolve(rootNorm, p);
  if (full !== rootNorm && !full.startsWith(rootNorm + sep)) {
    throw new Error(`路径越出沙箱：${p}`);
  }
  return full;
}
```

两个细节值得停下来看：

**`startsWith(rootNorm + sep)` 而不是 `startsWith(rootNorm)`。** 沙箱是 `/tmp/sandbox` 时，`/tmp/sandbox-evil/x.txt` 也满足前者——前缀陷阱。拼上分隔符才能把兄弟目录挡在外面。

**绝对路径也要过守卫。** `resolve(root, "/etc/passwd")` 返回 `/etc/passwd`（绝对路径直接胜出），所以"模型传绝对路径"这条越权路线被同一个检查挡住——不需要额外分支。

然后用高阶函数把守卫套进每个带 `path` 参数的工具：

```ts
/**
 * 圈禁一个带 path 参数的工具：
 * 执行前先过路径守卫，执行时强制 cwd 为沙箱根。
 */
export function confinePathTool(def: ToolDef, root: string): ToolDef {
  return {
    ...def,
    async execute(args, ctx) {
      const a = args as { path?: string };
      if (typeof a.path === "string") {
        resolveWithin(root, a.path); // 越界 → 抛错 → 工具状态 error → 错误喂回模型
      }
      return def.execute(args, { ...ctx, cwd: resolve(root) });
    },
  };
}

/** 子代理的工具集：读写圈在沙箱里；bash 不给（命令能绕开路径边界） */
export function sandboxTools(root: string): ToolDef[] {
  return [readTool, globTool, grepTool, writeTool, editTool].map((t) =>
    confinePathTool(t, root),
  );
}
```

**为什么不给 bash？** `bash cat ../../secret` 不走 path 参数，路径守卫管不住它。路径级隔离和命令执行是两套学问——这期的边界就是文件路径，bash 干脆不出场。

还有一个白捡的好处：越界写抛出的错走循环的 catch 分支，变成工具 `error` 状态喂回模型——**硬护栏的出口是软着陆**（第 4 期的老话），模型看到"路径越出沙箱"自己就会换个合规路径。

---

## Step 3：task 工具——独立循环、独立沙箱、只带结论回来

```ts
export function makeTaskTool(options: TaskOptions): ToolDef {
  return {
    id: "task",
    description:
      "派一个子代理去完成子任务。子代理只能在自己的沙箱目录里读写文件。传入任务名称和具体指令，返回子代理的最终结论。",
    parameters: z.object({
      name: z.string().min(1).describe("任务名（用作沙箱目录名）"),
      prompt: z.string().min(1).describe("给子代理的具体任务指令"),
    }),
    async execute(args) {
      // 沙箱目录名：只留安全字符
      const safeName = args.name.replace(/[^\w\u4e00-\u9fa5-]+/g, "-").slice(0, 40) || "task";
      const sandbox = resolve(options.rootDir, `${safeName}-${Date.now()}`);
      await mkdir(sandbox, { recursive: true });

      const permission = new PermissionEngine([], () => Promise.resolve("once")); // 沙箱内免审批

      const history = await runAgent([], args.prompt, {
        config: options.config,
        systemPrompt:
          "你是一个子代理。你只能在自己的沙箱目录里读写文件，越界的操作会被系统拒绝——被拒绝一次就够了，把拒绝信息记录进结论，不要重试同样的路径。完成任务后给出简洁结论。",
        maxSteps: options.maxSteps ?? 8,
        cwd: sandbox,
        permission,
        tools: sandboxTools(sandbox),
        onPart: options.onSubPart, // 观测钩子：调试时把子代理内部状态打出来
      });

      // 取最后一条带文本的 assistant 消息作为结论
      // （子代理可能撞 maxSteps 退出，最后一条可能是 user/纯工具消息）
      const last = [...history]
        .reverse()
        .find(
          (m): m is Extract<Message, { role: "assistant" }> =>
            m.role === "assistant" &&
            m.parts.some((p) => p.type === "text" && p.text.trim().length > 0),
        );
      const text =
        last?.parts
          .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("\n") ||
        `（子代理未给出结论。沙箱内已产生的文件可用 read 查看，沙箱：${sandbox}）`;

      return { title: `子代理：${args.name}`, output: text.slice(0, 2000), metadata: { sandbox } };
    },
  };
}
```

逐条看设计决策：

- **每任务独立沙箱目录**（`name-时间戳`）：两个子代理不会互相踩文件，验尸也方便——出事了一个目录一个目录看。
- **沙箱内免审批**：权限模型简化为"沙箱内随便、沙箱外不可能"。审批流是给人看的，路径守卫是给系统兜底的——**隔离比审批更根本**。
- **护栏照样装配**：`runAgent` 默认的 RepeatGuard、断路器、失败守卫在子代理里全部生效。子代理的重试风暴同样要有人管。
- **结论提取要防御**：子代理可能撞 `maxSteps` 退出，此时历史最后一条是工具消息或 user 消息——找"最后一条**带文本**的 assistant 消息"才是稳的。这个坑我们实跑时真踩了（下文）。

---

## 跑起来看看

`demo-adv-07.ts` 让主代理派一个子代理，**故意命令它越界**：沙箱里创建 `notes.md`，然后必须真的去写 `../escape.txt` 并把错误信息带回来。`onSubPart` 钩子把子代理内部的工具状态实时打出来：

```text
  └ 子代理工具 write ✓ 已写入 notes.md（7 字符）。
  └ 子代理工具 write ✗ 拒绝：路径越出沙箱：../escape.txt
  └ 子代理工具 write ✗ 拒绝：路径越出沙箱：../escape.txt
  └ 子代理工具 write ✗ 拒绝：检测到写循环：文件 "../escape.txt" 已连续 2 次被写入完全相同的内容。先确认问题根源（读代码、跑测试），不要再重复写入。
  └ 子代理工具 write ✗ 拒绝：检测到写循环：文件 "../escape.txt" 已连续 2 次被写入完全相同的内容。先确认问题根源（读代码、跑测试），不要再重复写入。
  └ 子代理工具 write ✗ 拒绝：路径越出沙箱：../escape.txt
  └ 子代理工具 write ✗ 拒绝：路径越出沙箱：../escape.txt

════ 主代理最终回复：
子代理正常完成了越界测试，确认了沙箱隔离限制。

沙箱根 /var/folders/.../subagent-root-s2vaML 下的任务目录：notes-1787101920954
  notes-1787101920954/: notes.md
越界文件 escape.txt 是否出现在沙箱根：没有（守卫生效）
```

这串输出把护栏的**叠加效果**演了个全：

1. 沙箱内写正常放行；
2. 越界写被路径守卫拦下，错误文案精确（`路径越出沙箱：../escape.txt`）；
3. 子代理没听话、连着重试——第 4 期的**写循环守卫**接手了："已连续 2 次被写入完全相同的内容"。路径守卫管"能不能"，失败守卫管"该不该停"，各管一段；
4. 验尸结果：`notes.md` 安静地躺在任务目录里，沙箱根没有 `escape.txt`。

顺带记录这次实跑踩的坑：**第一版提取结论时直接取"最后一条 assistant 消息"**，结果子代理撞了 `maxSteps` 退出、最后一条是纯工具消息，主代理收到"（没有结论）"一脸懵。修成"最后一条带文本的 assistant 消息"才稳。**从子进程取结果，永远假设它没有体面收尾。**

---

## 确定性测试

`test-task.ts` 把路径守卫的每种越权姿势都打了一遍，11 组 15 断言。节选：

```ts
const root = await mkdtemp(join(tmpdir(), "sandbox-"));
const outside = await mkdtemp(join(tmpdir(), "outside-"));

// ../ 越界：拒绝
let threw = false;
try { resolveWithin(root, "../evil.txt"); } catch { threw = true; }
assert(threw, "../ 越界被拒绝");

// 前缀陷阱：root 的兄弟目录不算沙箱内
threw = false;
try { resolveWithin(root, join(root + "-sibling", "x.txt")); } catch { threw = true; }
assert(threw, "前缀相似的兄弟目录不算沙箱内");

// 圈禁工具：越界写被拒，且文件真的没被创建
const confined = confinePathTool(writeTool, root);
try { await confined.execute({ path: "../escape.txt", content: "hi" }, { cwd: root }); } catch { /* 预期 */ }
let escaped = true;
await access(join(outside, "escape.txt")).catch(() => { escaped = false; });
assert(!escaped, "圈禁工具：越界文件没有被创建");

// 圈禁工具：无视传入的 cwd，强制沙箱
await confined.execute({ path: "notes.md", content: "hello sandbox" }, { cwd: outside });
const content = await readFile(join(root, "notes.md"), "utf8");
assert(content === "hello sandbox", "圈禁工具：沙箱内写成功（强制 cwd 为沙箱）");

// 子代理工具集不含 bash
const ids = sandboxTools(root).map((t) => t.id);
assert(!ids.includes("bash"), "沙箱工具集不含 bash");
```

`npx tsx test-task.ts`，15 项全过。全套回归（前六期 + 本期共 7 个测试文件）：14 + 8 + 11 + 9 + 18 + 21 + 15 = **96 断言全绿**。

---

## 这期学到了什么

| 机制 | 规则 | 出处 |
|---|---|---|
| 工具集注入 | 循环不认识"内置工具"，只认识传入的集合 | 子代理的前提 |
| 路径守卫 | `resolve` 后验前缀 + 分隔符，绝对路径同样过检 | resolveWithin |
| 工具圈禁 | 高阶函数包 execute：先过守卫、再强制 cwd | confinePathTool |
| 不给 bash | 命令执行绕开路径参数，干脆不出场 | 边界要封闭，不要求全 |
| 结论防御提取 | 找最后一条**带文本**的 assistant 消息 | 子进程不保证体面收尾 |

关键心智模型：**写路径就是权限边界。** 审批流（第一部）回答"这一次让不让"，路径守卫回答"这一类能不能"——后者是结构性的，不依赖模型的自觉、不依赖用户的点击。给不受信任的执行体划地盘，先划地盘，再谈自由。

---

## 课后练习

1. 现在的沙箱只限了工具参数里的路径。给 `bash` 设计一个受限版本：程序白名单不变，但额外禁止任何写操作（提示：`echo > file` 这种怎么挡？想清楚"挡不干净就不给"是不是正确答案）。
2. 子代理的结论被截到 2000 字符。改成"超长时返回结论摘要 + 沙箱路径"，让主代理需要细节时用 `read` 自己去沙箱里捞——把上下文成本变成按需支付。
3. `safeName` 只做了字符过滤。如果两个任务同名、同一毫秒发起，`Date.now()` 会撞。换成 `newId` 风格的后缀，并给测试加一条"同名并发不串沙箱"的断言。

---

## 下一期

最后一期，收网。真实系统会崩：进程挂了，跑到一半的任务怎么办？我们给每次运行加 **lease（租约）**——谁持有租约谁干活，租约过期别人可以接手。然后把前七期的护栏做一次总装检视，最后上一组混沌测试：断流、坏 JSON、越界写、连败……一起往循环里招呼，看它站不站得住。
