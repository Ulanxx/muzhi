# 第 5 期：工具调用修复管线——畸形 JSON 的多遍修复

> **Agent 健壮性进阶篇 · 第 5 期（共 8 期）**
>
> 前四期的护栏都假设工具调用"格式正确"。但真实生产里，LLM 吐出的工具调用会坏：流被截断、JSON 缺右括号、参数里夹带解释文字、工具名拼错。频率不高（几个百分点），但每坏一次，不做修复的框架就浪费一整轮。这期实现修复管线：**坏调用先救，救不回来再报错**。这是进阶篇的难度高峰之一，全是字符串处理的硬功夫。

---

## 这期解决什么问题

回忆第一部 `llm.ts` 的处理方式——参数 parse 失败就塞个标记对象：

```ts
// 第一部的做法：一刀切
try {
  argumentsValue = JSON.parse(acc.arguments);
} catch {
  argumentsValue = { __parse_error: acc.arguments.slice(0, 200) };
}
```

这意味着什么？模型输出了 `{"path": "src/index.ts`——**只差一个右括号**，意图 100% 清楚——但我们的框架直接判死刑，回一个错误让模型重试。一轮就这么浪费了，而模型重试时很可能再犯同样的错。

真实坏调用的四种常见形态：

| 形态 | 例子 | 成因 |
|---|---|---|
| 截断 | `{"path": "a.txt"` | max_tokens 顶到头、网络断流 |
| 悬空逗号 | `{"a": 1,` | 同上，断在更尴尬的位置 |
| 夹带文字 | `好的，参数是 {"path": "a.txt"}` | 模型没管住嘴 |
| 工具名错 | `Read` / `raed` | 大小写习惯、手滑 |

前三种都是参数问题，第四种是名字问题，分开治。修复的原则和急诊室一样：**先做最便宜的处理，逐级加码，每步都记录用了哪招**。

---

## Step 1：参数修复管线（三遍）

新建 `repair.ts`。

**第一遍：直接 parse。** 绝大多数调用走这里，零成本，不值得多说。

**第二遍：补齐未闭合的括号/引号。** 这是核心功夫。思路：逐字符扫描，用栈记住未闭合的 `{` `[`，识别字符串状态和转义字符（不然字符串里的 `{` 会干扰计数），最后按逆序把欠的括号补上：

```ts
// repair.ts

/** 工具调用参数修复结果 */
export type JsonRepairResult =
  | { status: "ok"; value: Record<string, unknown> }                    // 本来就是好的
  | { status: "repaired"; value: Record<string, unknown>; note: string } // 修复成功
  | { status: "failed"; error: string };                                 // 没救

/**
 * 第二遍：补齐未闭合的括号/引号。
 * 模型输出被截断时最常见的形态：{"path": "a.txt"  ← 右括号没了。
 * 逐字符扫描（识别字符串与转义），用栈记下未闭合的 { [，最后按逆序补上。
 */
export function closeUnterminated(raw: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const ch of raw) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }

  let out = raw;
  if (inString) out += '"';              // 字符串没闭合：先补引号
  out = out.replace(/,\s*$/, "");        // 去掉悬空的尾逗号
  while (stack.length) {
    out += stack.pop() === "{" ? "}" : "]";
  }
  return out;
}
```

注意两个细节：**先补引号再补括号**（字符串不闭合时直接补括号会得到 `{"path": "a.txt"}` 这种假闭合）；**去掉悬空尾逗号**（`{"a": 1,` 补完括号是 `{"a": 1,}`，仍是非法 JSON）。

**第三遍：截取 JSON 子串。** 治夹带文字：找第一个 `{`，扫描到它配对闭合的位置，切出来：

```ts
/**
 * 第三遍：截取 JSON 子串。
 * 模型有时在 JSON 前后夹带解释文字：`好的，参数是 {"path": "a.txt"} 就这样`。
 */
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}
```

管线入口把三遍串起来，**每遍成功都记录用了哪招**——生产上这个 note 是观测修复率的关键数据：

```ts
/**
 * 参数修复管线：三遍。
 * 1. 直接 parse——绝大多数调用走这里，零成本
 * 2. 补齐括号——治截断
 * 3. 截取子串——治夹带解释文字
 */
export function repairArguments(raw: string): JsonRepairResult {
  // 第一遍：直接解析
  try {
    const value = JSON.parse(raw);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return { status: "ok", value: value as Record<string, unknown> };
    }
  } catch {
    // 落到第二遍
  }

  // 第二遍：补齐未闭合的括号/引号
  try {
    const value = JSON.parse(closeUnterminated(raw));
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return { status: "repaired", value: value as Record<string, unknown>, note: "补齐了未闭合的括号/引号" };
    }
  } catch {
    // 落到第三遍
  }

  // 第三遍：截取 JSON 子串
  const sub = extractJsonObject(raw);
  if (sub) {
    try {
      const value = JSON.parse(sub);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return { status: "repaired", value: value as Record<string, unknown>, note: "从夹带文字中截取了 JSON 对象" };
      }
    } catch {
      // 没救
    }
  }

  return { status: "failed", error: `参数不是可修复的 JSON：${raw.slice(0, 120)}` };
}
```

为什么每遍都重复那个"必须是对象"的检查？因为工具参数约定是对象——`[1,2,3]` 能被 parse 成功，但不是合法的工具参数，放进后续流程会在 zod 校验处炸出难懂的错误。在修复层就把语义错误挡住。

---

## Step 2：工具名修复

参数之外，工具名也会错。三级降级：精确匹配 → 忽略大小写 → 编辑距离 ≤ 2：

```ts
/** 编辑距离（Levenshtein），用于工具名模糊匹配 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n]!;
}

/**
 * 工具名修复：精确 → 忽略大小写 → 编辑距离 ≤ 2。
 * 模型常犯的错：Read / READ（大小写）、raed（手滑）。
 */
export function repairToolName(name: string, toolNames: string[]): string | null {
  if (toolNames.includes(name)) return name;
  const lower = name.toLowerCase();
  const byCase = toolNames.find((t) => t.toLowerCase() === lower);
  if (byCase) return byCase;
  let best: { tool: string; dist: number } | null = null;
  for (const tool of toolNames) {
    const dist = editDistance(lower, tool.toLowerCase());
    if (dist <= 2 && (!best || dist < best.dist)) best = { tool, dist };
  }
  return best?.tool ?? null;
}
```

**阈值 2 是个讲究的数字**：`raed`→`read`（换位在 Levenshtein 里算 2 次编辑）刚好够得着，而 `kubernetes` 这种完全无关的词距离远大于 2，不会被硬凑成某个工具。宁可返回 null 让上层报"未知工具"，也不能把调用路由到错误的工具——**修复可以保守，不能冒进**。

---

## Step 3：接入两个位置

**位置一：`llm.ts` 流结束处**，替换第一部的一刀切：

```ts
import { repairArguments } from "./repair.js";

// consumeStream 末尾，组装 calls 时
      let argumentsValue: Record<string, unknown> = {};
      // 【进阶篇第 5 期】三遍修复管线替换原来的一刀切兜底
      const fixed = repairArguments(acc.arguments);
      if (fixed.status === "failed") {
        // 真的没救：用标记对象，让循环层把错误喂回给模型
        argumentsValue = { __parse_error: fixed.error };
      } else {
        if (fixed.status === "repaired") console.log(`🔧 参数修复：${fixed.note}`);
        argumentsValue = fixed.value;
      }
```

**位置二：`loop.ts` 两处。**

参数彻底没救的调用，在护栏检查之后**提前短路**——别让它进权限询问、别让它进守卫记账（一次格式损坏不是模型的"行为"）：

```ts
          // 【进阶篇第 5 期新增】参数彻底损坏（修复管线也没救）：直接把错误喂回模型
          if ((call.arguments as Record<string, unknown>).__parse_error) {
            toolPart.state = {
              status: "error",
              input: call.arguments,
              error: String((call.arguments as Record<string, unknown>).__parse_error),
              endedAt: new Date().toISOString(),
            };
            onPart?.(toolPart);
            continue;
          }
```

找不到工具时先试名字修复：

```ts
          // 【进阶篇第 5 期新增】找不到工具时先试工具名修复（大小写/手滑拼错）
          let def = findTool(call.name);
          if (!def) {
            const fixedName = repairToolName(call.name, builtinTools.map((t) => t.id));
            if (fixedName) {
              console.log(`🔧 工具名修复：${call.name} → ${fixedName}`);
              def = findTool(fixedName);
            }
          }

          if (!def) {
            // ……原有的"未知工具"error 分支
```

---

## 跑起来看看

坏调用在真实流量里占比低，靠真实 LLM 复现不稳定——所以这期的验证以**确定性测试**为主，包括用第一部学会的假 SSE 流做端到端验证。`test-repair.ts` 共 13 组 18 断言，节选关键几组：

```ts
// 截断（右括号没了）：第二遍补齐
const r = repairArguments('{"path": "a.txt"');
assert(r.status === "repaired" && r.value.path === "a.txt", "截断的右括号被补齐");

// 夹带解释文字：第三遍截取
const r2 = repairArguments('好的，参数是 {"path": "a.txt"} 就这样');
assert(r2.status === "repaired" && r2.value.path === "a.txt", "夹带文字中截取 JSON");

// 转义引号不干扰闭合判断
const fixed = closeUnterminated('{"text": "say \\"hi\\"');
assert(JSON.parse(fixed).text === 'say "hi"', "转义引号不干扰闭合判断");

// 工具名：够得着的修，够不着的不硬凑
assert(repairToolName("raed", names) === "read", "手滑拼错被修复");
assert(repairToolName("kubernetes", names) === null, "完全无关的名字不硬凑");
```

端到端用例把截断的参数塞进假 SSE 流，验证 `consumeStream` 出来的调用已经修复：

```ts
// 13. 端到端：假 SSE 流里塞截断的 arguments
const stream = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoder.encode(chunk(toolCall('{"path": "a.t'))));  // 截断的参数
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
  },
});
const events: StreamEvent[] = [];
await consumeStream(stream, (e) => events.push(e));
const tc = events.find((e) => e.type === "tool_calls");
const args = tc && tc.type === "tool_calls" ? tc.calls[0]?.arguments : undefined;
assert(args !== undefined && (args as { path?: string }).path === "a.t", "SSE 端到端：截断参数被修复");
```

`npx tsx test-repair.ts`，18 项全过。跑的时候你能在控制台看到那行 `🔧 参数修复：补齐了未闭合的括号/引号`——修复管线真实工作了。

全套回归（前四期 + 本期共 5 个测试文件）：14 + 8 + 11 + 9 + 18 = **60 断言全绿**。

---

## 这期学到了什么

| 机制 | 规则 | 出处 |
|---|---|---|
| 三遍参数修复 | 直接 parse → 补括号 → 截子串，逐级加码 | Reasonix 四遍修复管线（mini 版） |
| 括号补齐 | 栈 + 字符串/转义状态机，先补引号再补括号 | 确定性字符串修复 |
| 工具名修复 | 精确 → 大小写 → 编辑距离 ≤ 2，宁缺毋滥 | Tool-Call Repair 的模糊匹配段 |
| 分层拦截 | 修复失败的调用不进权限、不进守卫记账 | 格式损坏 ≠ 行为失控 |

关键心智模型：**修复管线的哲学是"便宜优先、记录每招、宁可保守"。** 第一遍零成本解决 99%；第二三遍是纯字符串操作，微秒级；真的没救才走错误路径——而错误路径的文案本身又是给模型的可执行反馈。

---

## 课后练习

1. 加第四遍：`closeUnterminated` 修不好时，把 `__parse_error` 连同原始串喂回模型，要求它只重发参数 JSON（提示：这需要循环层支持"重请求"，想想怎么加而不污染对话历史）。
2. 现在的 `closeUnterminated` 遇到 `{"a": }`（值缺失）会产出 `{"a": }`——仍非法。给它加一条规则：冒号后面直接跟 `}`/`]` 时补一个 `null`。
3. 编辑距离阈值 2 对短工具名（`ls`、`rm`）太宽松：`rm` 和 `ls` 的距离就是 2。设计一个按名字长度收紧阈值的方案。

---

## 下一期

第一部我们做过上下文压缩：超过阈值就把旧历史摘成一段摘要。但那个实现有个隐患——**压缩直接改动了对话历史本身**，事件流里存的是压缩后的版本，原始记录丢了。下一期我们把它重构成"投影式压缩"：canonical 历史永远完整，压缩只是发给 LLM 前的一个投影。顺便解决一个生产级问题：怎么用前缀哈希诊断你的提示词缓存为什么命中率低。
