# 第 4 期：重复失败守卫——重试前先验状态

> **Agent 健壮性进阶篇 · 第 4 期（共 8 期）**
>
> 前两期的护栏各有盲区：重复提醒只管"完全相同的调用"，断路器要攒够 5 连败才出手。真实失控往往长在两者中间——模型修 bug 时反复"原样重跑测试"，每次都失败，每次都立刻重试，没有思考、没有读代码。这期我们实现重复失败守卫：**同一个调用连续失败就拉黑，想再试，必须先做一次不同的事**。这就是"重试前先验状态"的强制版。

---

## 这期解决什么问题

看一个教科书级的浪费现场：

```
轮 3：bash node check.js  → FAIL
轮 4：bash node check.js  → FAIL     （代码没变，结果凭什么变？）
轮 5：bash node check.js  → FAIL
轮 6：bash node check.js  → FAIL
```

模型在做什么？什么都没做。它没有读代码、没有改代码，只是不断重放同一个动作，幻想不同的结果。人类开发者一眼就看穿：**环境没变，重试无意义；要么先改变环境（修代码），要么先确认状态（读代码）。**

守卫的职责就是把这个常识变成硬规则：

1. **失败黑名单**：同签名连续失败 N 次 → 拉黑。被拉黑的调用不能直接再执行
2. **干预解锁**：想解除拉黑，中间必须出现过一次**不同签名**的调用——读文件、换工具、换参数都算。这就是强制"状态复查"
3. **防写循环**：同一文件被连续写入完全相同的内容 → 拒绝（写循环是另一种原地踏步，且更贵：每次还消耗写入配额）

和前两期的分工：

| 护栏 | 强度 | 管什么 |
|---|---|---|
| 重复提醒（2 期） | 说 | 完全相同的调用，提醒 |
| **失败守卫（本期）** | **拦** | **失败后的盲目重试，强制先干预** |
| 断路器（3 期） | 停 | 风暴级别，全部熔断 |

---

## Step 1：守卫本体

新建 `failure-guard.ts`。签名继续复用 `callSignature`：

```ts
// failure-guard.ts
import { callSignature } from "./guards.js";

/**
 * 重复失败守卫：拦"看起来每次都不一样、实际原地踏步"的重试。
 *
 * 两条规则：
 * 1. 失败黑名单：同签名失败 ≥ repeatLimit 次后拉黑。
 *    被拉黑的调用想再执行，中间必须先有过一次**不同签名**的调用
 *    （这就是"状态复查/干预要求"——强制模型先做点别的再回来试）。
 * 2. 防写循环：write 目标文件 + 内容指纹连续 repeatLimit 次完全相同 → 拒绝。
 */
export class FailureGuard {
  /** 签名 → 连续失败次数 */
  private failures = new Map<string, number>();
  /** 被拉黑的签名。解除条件：出现过不同签名的调用 */
  private blacklist = new Set<string>();
  /** 最近一次调用的签名（判断"干预"用） */
  private lastSig = "";
  /** write 循环检测：路径 → 连续相同内容指纹的次数 */
  private writeRuns = new Map<string, { fingerprint: string; count: number }>();

  constructor(private repeatLimit = 2) {}

  /**
   * 调用前检查。返回放行或拒绝理由。
   * 注意：这里只"记账前检查"，调用结束后要再 recordResult。
   */
  checkBefore(name: string, args: unknown): { allowed: boolean; reason?: string } {
    const sig = callSignature(name, args);

    // 规则 2：写循环
    if (name === "write") {
      const { path, content } = args as { path?: string; content?: string };
      if (path !== undefined && content !== undefined) {
        const fingerprint = callSignature("content", content);
        const run = this.writeRuns.get(path);
        if (run && run.fingerprint === fingerprint && run.count >= this.repeatLimit) {
          return {
            allowed: false,
            reason: `检测到写循环：文件 "${path}" 已连续 ${run.count} 次被写入完全相同的内容。先确认问题根源（读代码、跑测试），不要再重复写入。`,
          };
        }
      }
    }

    // 规则 1：黑名单
    if (this.blacklist.has(sig)) {
      return {
        allowed: false,
        reason: `该调用（${name}）已因连续失败被守卫拦截。请先采取不同行动（读相关文件、换一个工具或参数）确认状态后再试。`,
      };
    }
    return { allowed: true };
  }

  /** 调用后记账 */
  recordResult(ok: boolean, name: string, args: unknown): void {
    const sig = callSignature(name, args);

    // 任何一次"不同签名"的调用都算干预：解除所有黑名单
    if (sig !== this.lastSig && this.blacklist.size > 0) {
      this.blacklist.clear();
    }
    this.lastSig = sig;

    // 失败计数与拉黑
    if (ok) {
      this.failures.delete(sig);
    } else {
      const n = (this.failures.get(sig) ?? 0) + 1;
      this.failures.set(sig, n);
      if (n >= this.repeatLimit) this.blacklist.add(sig);
    }

    // 写循环记账
    if (name === "write") {
      const { path, content } = args as { path?: string; content?: string };
      if (path !== undefined && content !== undefined) {
        const fingerprint = callSignature("content", content);
        const run = this.writeRuns.get(path);
        if (run && run.fingerprint === fingerprint) run.count++;
        else this.writeRuns.set(path, { fingerprint, count: 1 });
      }
    }
  }
}
```

几个值得咀嚼的设计点：

- **`repeatLimit = 2`**：比断路器激进得多。失败两次就该停下来想想——这不是误伤，健康的修 bug 流程里本来就不该出现"原样重跑第三次"
- **干预判定只看"签名不同"**：不判断干预的质量。模型读个无关文件也能解锁——没关系，守卫要的是打断惯性，不是当评审。过度聪明的判定往往带来误伤
- **失败计数不因拉黑而清零**：干预解锁后如果重试又失败，`n` 继续往上加，**立刻**重新拉黑。一次失败的机会已经很慷慨了
- **写循环用内容指纹而不是内容本身**：内容可能几十 KB，Map 的 key 放哈希签名就够
- **被拦截的调用不记账**：拦截发生在 checkBefore，recordResult 根本不会被调用——被拦的动作既不算失败也不算干预，状态机保持干净

---

## Step 2：接入循环

改 `loop.ts`。位置有讲究：**断路器之后、权限之前**——

```ts
// 顶部
import { FailureGuard } from "./failure-guard.js";

// LoopOptions
  /** 【进阶篇第 4 期新增】不传则默认新建一个重复失败守卫 */
  failureGuard?: FailureGuard;

// runAgent 开头
  const failureGuard = options.failureGuard ?? new FailureGuard();
```

拦截点（接在第 3 期断路器检查之后）：

```ts
          // 【进阶篇第 4 期新增】重复失败守卫：黑名单/写循环拦截
          const verdict = failureGuard.checkBefore(call.name, call.arguments);
          if (!verdict.allowed) {
            toolPart.state = {
              status: "error",
              input: call.arguments,
              error: verdict.reason ?? "被重复失败守卫拦截",
              endedAt: new Date().toISOString(),
            };
            onPart?.(toolPart);
            continue;
          }

          // ……后面是权限检查、执行
```

记账点在两处，和断路器并排：

```ts
              const failed = result.metadata?.failed === true;
              breaker.recordResult(!failed, call.name, call.arguments);
              failureGuard.recordResult(!failed, call.name, call.arguments);
              // ……
            } catch (error) {
              breaker.recordResult(false, call.name, call.arguments);
              failureGuard.recordResult(false, call.name, call.arguments);
```

为什么放在权限之前？被拉黑的调用不该再触发用户审批——和断路器的理由一样，护栏拦的东西不要再去打扰人。

---

## 跑起来看看

demo 分两段。

**Part 1：真实 LLM。** 场景搭好：`buggy.js` 里 `add` 写成了减法，`check.js` 是必挂的测试。任务只说"测试挂了，帮我定位，别改文件"。实测模型的行为：

```
── Part 1：真实 LLM（check.js 必挂，看守卫如何拦原样重跑）──
  🔧 bash ✅ node 失败
  🔧 grep ✅ 搜索 "function add"：1 条命中
```

聪明的模型只跑一次测试就去读代码了——**守卫没出手，恰恰说明它要的秩序本来就是正常开发者的秩序**。而当模型真的开始盲试（我们在更暴力的指令下实测过），守卫的表现是：

```
  🔧 bash ✅ node 失败
  🔧 bash ✅ node 失败
  🔧 bash 🚫 该调用（bash）已因连续失败被守卫拦截。请先采取不同行动...
  🔧 bash 🚫 该调用（bash）已因连续失败被守卫拦截。请先采取不同行动...
  （后续所有原样重试全部即时拦截）
```

失败两次之后，每一次盲试都被 0 成本顶回去，模型要么换路，要么向用户报告。

**Part 2：脚本驱动。** 模型行为有随机性，状态机的完整生命周期用确定性脚本演示——这也是生产里测护栏的正确姿势：

```ts
const g = new FailureGuard(2);
const run = { program: "node", args: ["check.js"] };

function attempt(ok: boolean, name: string, args: unknown, label: string): void {
  const v = g.checkBefore(name, args);
  if (!v.allowed) {
    console.log(`  ${label}: 🚫 拦截 —— ${v.reason!.slice(0, 30)}...`);
    return;
  }
  console.log(`  ${label}: ✅ 放行执行（结果：${ok ? "成功" : "失败"}）`);
  g.recordResult(ok, name, args);
}

attempt(false, "bash", run, "第 1 次跑测试");      // 失败 1
attempt(false, "bash", run, "第 2 次跑测试");      // 失败 2 → 拉黑
attempt(false, "bash", run, "第 3 次跑测试");      // 拦截
attempt(true, "read", { path: "package.json" }, "读源码（干预）"); // 解除黑名单
attempt(false, "bash", run, "第 4 次跑测试");      // 放行 → 失败 → 重新拉黑
attempt(false, "bash", run, "第 5 次跑测试");      // 拦截
```

实测输出：

```
第 1 次跑测试: ✅ 放行执行（结果：失败）
第 2 次跑测试: ✅ 放行执行（结果：失败）
第 3 次跑测试: 🚫 拦截
读源码（干预）: ✅ 放行执行（结果：成功）
第 4 次跑测试: ✅ 放行执行（结果：失败）
第 5 次跑测试: 🚫 拦截
```

完整生命周期：失败 → 拉黑 → 拦截 → 干预解锁 → 给一次机会 → 再失败立刻再拉黑。

---

## 确定性测试

`test-failure-guard.ts`，7 组 9 断言，把每条规则的正反面都踩一遍：

```ts
// test-failure-guard.ts
import { FailureGuard } from "./failure-guard";

let pass = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { console.error(`✗ ${name}`); process.exitCode = 1; }
}

// 1. 黑名单：同签名连续失败 repeatLimit 次后被拦
{
  const g = new FailureGuard(2);
  const bash = { program: "node", args: ["bad.js"] };
  g.recordResult(false, "bash", bash);
  assert(g.checkBefore("bash", bash).allowed === true, "失败 1 次后仍可重试");
  g.recordResult(false, "bash", bash);
  const v = g.checkBefore("bash", bash);
  assert(v.allowed === false && !!v.reason, "失败 2 次后原样重试被拦截");
}

// 2. 干预解锁：一次不同签名的调用解除黑名单
{
  const g = new FailureGuard(2);
  const bash = { program: "node", args: ["bad.js"] };
  g.recordResult(false, "bash", bash);
  g.recordResult(false, "bash", bash);
  g.recordResult(true, "read", { path: "package.json" }); // 干预
  assert(g.checkBefore("bash", bash).allowed === true, "干预后黑名单解除，可再试");
}

// 3. 干预后仍失败 → 立刻重新拉黑（失败计数保留）
{
  const g = new FailureGuard(2);
  const bash = { program: "node", args: ["bad.js"] };
  g.recordResult(false, "bash", bash);
  g.recordResult(false, "bash", bash);
  g.recordResult(true, "read", { path: "a.txt" });
  g.recordResult(false, "bash", bash);
  assert(g.checkBefore("bash", bash).allowed === false, "重试再失败立刻重新拉黑");
}

// 4. 成功清零失败计数
{
  const g = new FailureGuard(2);
  const bash = { program: "node", args: ["bad.js"] };
  g.recordResult(false, "bash", bash);
  g.recordResult(true, "bash", bash);
  g.recordResult(false, "bash", bash);
  assert(g.checkBefore("bash", bash).allowed === true, "中间成功后失败计数清零");
}

// 5. 写循环：同文件同内容连写超限被拒
{
  const g = new FailureGuard(2);
  const w = { path: "t.txt", content: "hello" };
  g.recordResult(true, "write", w);
  assert(g.checkBefore("write", w).allowed === true, "第 2 次同内容写入放行");
  g.recordResult(true, "write", w);
  assert(g.checkBefore("write", w).allowed === false, "第 3 次同内容写入被拒");
}

// 6. 写循环：内容不同则放行
{
  const g = new FailureGuard(2);
  g.recordResult(true, "write", { path: "t.txt", content: "v1" });
  g.recordResult(true, "write", { path: "t.txt", content: "v2" });
  assert(g.checkBefore("write", { path: "t.txt", content: "v3" }).allowed === true, "内容变化不计入写循环");
}

// 7. 写循环：不同文件互不干扰
{
  const g = new FailureGuard(2);
  g.recordResult(true, "write", { path: "a.txt", content: "x" });
  g.recordResult(true, "write", { path: "a.txt", content: "x" });
  assert(g.checkBefore("write", { path: "b.txt", content: "x" }).allowed === true, "不同文件独立计数");
}

console.log(`\n${pass} 项通过`);
```

`npx tsx test-failure-guard.ts`，9 项全过。

---

## 这期学到了什么

| 机制 | 规则 | 出处 |
|---|---|---|
| 失败黑名单 | 同签名连续失败 2 次即拉黑 | Reasonix 重复失败守卫 |
| 干预解锁 | 出现过不同签名的调用才解除拉黑 | "重试前先验状态"的强制版 |
| 机会递减 | 解锁后重试再失败，立刻重新拉黑 | 失败计数不清零 |
| 防写循环 | 同文件同内容指纹连写超限拒绝 | Reasonix 重复"写成功"守卫 |
| 分层纪律 | 提醒 → 拦截 → 熔断，强度递增 | 护栏只在上一级失效时出手 |

关键心智模型：**好的护栏不改变模型"能做什么"，只改变"做事的顺序"。** 守卫没有禁止重试——它只是要求重试之前先发生一次不同的动作。这个最小的约束，足以把盲试循环打断成"试 → 看 → 再试"的健康节奏。

---

## 课后练习

1. 现在的干预判定是"任何不同签名"。模型读一个完全无关的文件也能解锁。如果要把干预限定为"与失败调用相关"（比如读了失败命令提到的文件），你会怎么设计？值得吗？
2. 给 `edit` 工具也加循环检测。提示：edit 的参数是 `{ path, oldText, newText }`，什么样的重复才算"循环"？（想想：同一处替换反复执行，通常意味着上一轮 edit 没生效。）
3. 把黑名单做成带 TTL 的：拉黑 60 秒后自动解除。想想这和"干预解锁"是互补还是冗余。

---

## 下一期

前四期的护栏都假设工具调用是"格式正确"的。但真实世界里，LLM 会吐出截断的 JSON、不闭合的括号、不存在的工具名——**循环在模型开口的那一步就可能崩掉**。下一期是难度高峰之一：工具调用修复管线，四遍修复，把畸形调用救回来。
