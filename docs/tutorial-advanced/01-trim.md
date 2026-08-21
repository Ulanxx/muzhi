# 第 1 期：工具结果的聪明裁剪——砍哪里决定 agent 的智商

> **Agent 健壮性进阶篇 · 第 1 期（共 8 期）**
>
> 欢迎回到进阶篇。第一部我们造了一个能跑的 mini-agent；这一部我们给它装护栏。第一期从最不起眼但性价比最高的机制开始：**裁剪工具输出**。它是纯函数，不需要模型，不依赖任何其他模块——但装没装它，agent 在长任务上的表现是两个世界。

---

## 这期解决什么问题

回顾第一部的 `tools.ts`，我们给工具输出做过一刀切截断：

```ts
// 第一部 tools.ts 里的 truncate
const MAX_OUTPUT_BYTES = 48 * 1024;

function truncate(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_OUTPUT_BYTES) return { text, truncated: false };
  let cut = text;
  while (Buffer.byteLength(cut, "utf8") > MAX_OUTPUT_BYTES) cut = cut.slice(0, -1);
  return { text: cut + "\n...(输出过长，已截断)", truncated: true };
}
```

它有两个真实问题：

**问题一：只留头，丢掉尾——而错误信息恰恰在尾。**

想想日常开发里日志长什么样：

```
✓ src/auth.test.ts (12 tests) 245ms
✓ src/api.test.ts (8 tests) 512ms
✓ src/db.test.ts (23 tests) 1.2s
... 中间 4800 行全是 pass ...
✗ src/edge.test.ts > 并发写冲突
  AssertionError: expected 200 to be 409
      at ...
Tests: 43 passed, 1 failed
```

一刀从头截断，模型看到的是"全绿"的前 48KB，**唯一失败的那行被扔了**。模型于是得出结论"测试都过了"，欢快地进入下一步——agent 就是这么一步步走歪的。

**问题二：48KB 对 LLM 来说还是太粗。**

48KB ≈ 12000+ tokens。一次工具调用吃掉小半个上下文窗口，而其中 90% 是重复的 pass 行。真实 harness（Claude Code、Codex、Reasonix）的做法是：**确定性裁剪**——不用模型、不用启发式玄学，就用两条死规则，砍得狠且砍得准。

这期我们实现两条规则：

1. **head+tail 裁剪**：成功输出留头尾、砍中间
2. **失败日志剪裁**：失败输出只留错误行和它的上下文

---

## Step 1：head+tail 裁剪

核心思想一句话：**文件的开头讲"这是什么"，结尾讲"结果如何"，中间往往是过程噪音。**

新建 `trim.ts`：

```ts
// trim.ts

/** 裁剪配置 */
export type TrimOptions = {
  maxChars: number;      // 总字符上限
  headRatio?: number;    // 头部配额占比，默认 0.6
  tailRatio?: number;    // 尾部配额占比，默认 0.4（head+tail 应 ≤ 1）
  marker?: string;       // 中间省略标记
};

/** 往前找到行尾——不把一行拦腰砍断 */
function cutAtLineEnd(s: string): string {
  const idx = s.lastIndexOf("\n");
  return idx > 0 ? s.slice(0, idx) : s;
}

/** 往后找到行首——不把一行拦腰砍断 */
function cutAtLineStart(s: string): string {
  const idx = s.indexOf("\n");
  return idx >= 0 && idx < s.length - 1 ? s.slice(idx + 1) : s;
}

/**
 * head+tail 裁剪：保留头部和尾部，砍掉中间。
 * 确定性：同样的输入永远得到同样的输出（这点对前缀缓存友好，第 6 期会讲为什么）。
 */
export function headTailTrim(text: string, opts: TrimOptions): { text: string; trimmed: boolean } {
  const { maxChars, headRatio = 0.6, tailRatio = 0.4, marker } = opts;
  if (text.length <= maxChars) return { text, trimmed: false };

  const omitted = text.length - maxChars;
  const headPart = cutAtLineEnd(text.slice(0, Math.floor(maxChars * headRatio)));
  const tailPart = cutAtLineStart(text.slice(text.length - Math.floor(maxChars * tailRatio)));
  const banner = marker ?? `\n...（中间省略 ${omitted} 字符）...\n`;

  return { text: headPart + banner + tailPart, trimmed: true };
}
```

三个设计决策，展开说：

**为什么按字符不按字节？** 第一部用 `Buffer.byteLength` 按字节截，还得写个 while 循环逐字符回退防砍断多字节字符。其实 LLM 关心的是 token，字符数就是足够好的近似——而且按字符算，代码少一半。

**为什么在行边界切？** 砍在行中间，头尾各多出半行垃圾，模型还得猜那半行是什么。`cutAtLineEnd`/`cutAtLineStart` 保证每段都从完整行开始、在完整行结束。

**为什么留中间省略标记？** 这是给模型的**诚实声明**：告诉它"这里有信息被拿掉了"，它需要时可以用 `grep`/`read` 自己去找，而不是以为看到的就是全部。Claude Code 裁剪大文件输出时同样会保留这类标记。

---

## Step 2：失败日志剪裁

head+tail 对成功输出够用，但失败日志有更狠的裁法。观察构建/测试日志的结构：

```
✓ 2341 行 pass 噪音
✗ 1 行错误声明        ← 值钱
  2 行断言详情         ← 值钱
  3 行调用栈           ← 值钱
✓ 1890 行 pass 噪音
```

规则：**只保留匹配错误特征的行，外加前后各 N 行上下文；连续保留的区间合并，区间之间用省略标记连接。** 没有匹配行时降级回 head+tail。

在 `trim.ts` 里继续：

```ts
/** 错误行特征。命中任意一条就视为"值钱行" */
const ERROR_MARKS = [
  /\berror\b/i,
  /\bfail(ed|ure)?\b/i,
  /\bpanic\b/i,
  /\bexception\b/i,
  /\bassert/i,
  /\btraceback\b/i,
  /[✗✘×]/,
];

export type PruneOptions = {
  contextLines?: number;  // 错误行前后各保留几行，默认 2
  maxChars: number;       // 剪裁后总字符上限（防错误行本身爆炸）
};

/**
 * 失败日志剪裁：只留错误行 + 上下文。
 * 没找到任何错误行时降级为 head+tail 裁剪。
 */
export function pruneFailureLog(text: string, opts: PruneOptions): { text: string; trimmed: boolean } {
  const { contextLines = 2, maxChars } = opts;
  const lines = text.split("\n");

  // 1. 标记所有值钱行（错误行 + 前后上下文）
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (ERROR_MARKS.some((re) => re.test(line))) {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
        keep.add(j);
      }
    }
  });

  // 2. 一个错误行都没命中——说明这份输出不像错误日志，降级 head+tail
  if (keep.size === 0) return headTailTrim(text, { maxChars });

  // 3. 把保留行压成连续区间，区间之间插省略标记（O(n)，顺手记 skipped 计数）
  const parts: string[] = [];
  let runStart = -1;
  let skipped = 0;
  for (let i = 0; i <= lines.length; i++) {
    const keeping = i < lines.length && keep.has(i);
    if (keeping) {
      if (runStart < 0) {
        if (skipped > 0) parts.push(`...（省略 ${skipped} 行非错误输出）...`);
        runStart = i;
        skipped = 0;
      }
    } else if (runStart >= 0) {
      parts.push(lines.slice(runStart, i).join("\n"));
      runStart = -1;
    }
    if (!keeping) skipped++;
  }

  const joined = parts.join("\n");
  return joined.length <= maxChars
    ? { text: joined, trimmed: true }
    : headTailTrim(joined, { maxChars });
}
```

两个细节值得停下来看一眼：

- 区间遍历用 `runStart`/`skipped` 两个指针一次走完，O(n)。每次进入新区间时把攒的 `skipped` 清零并输出省略标记；循环结束时尾部剩下的 `skipped` 不再输出——尾部噪音本来就不要，没必要告诉模型"后面还有一堆没看的 pass 行"。
- 降级链：错误行太多把结果撑爆 `maxChars` 时，最后一道闸仍是 head+tail——裁剪函数永远有输出上限，这是护栏的自我修养。

---

## Step 3：接入工具系统

裁剪策略按结果状态分流：**成功走 head+tail，失败走剪裁**。在 `trim.ts` 加一个总入口：

```ts
/**
 * 工具输出裁剪总入口。
 * failed=true（命令退出码非 0 / 抛错）→ 失败日志剪裁；
 * failed=false → head+tail。
 */
export function trimToolOutput(output: string, failed: boolean): { text: string; trimmed: boolean } {
  return failed
    ? pruneFailureLog(output, { contextLines: 2, maxChars: 8_000 })
    : headTailTrim(output, { maxChars: 12_000 });
}
```

为什么两个上限不一样？失败剪裁后信息密度极高（全是错误），8000 字符 ≈ 2000 tokens 已经够模型定位问题；成功输出往往是结构化数据（目录列表、文件内容），多给一点配额。

现在改 `tools.ts` 的 `bashTool`——删掉第一部的 `truncate`，换上新入口。成功分支：

```ts
      const output = [stdout, stderr].filter(Boolean).join("\n");
      const { text, trimmed } = trimToolOutput(output, false);
      return {
        title: `${args.program} 完成`,
        output: `$ ${args.program} ${(args.args ?? []).join(" ")}\n${text}`,
        ...(truncated ? { metadata: { truncated: true } } : {}),
      };
```

失败分支（catch 里）是剪裁真正发力的地方：

```ts
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message: string };
      const output = [e.stdout, e.stderr].filter(Boolean).join("\n") || e.message;
      const { text } = trimToolOutput(output, true);
      return {
        title: `${args.program} 失败`,
        output: `$ ${args.program} ${(args.args ?? []).join(" ")}\n${text}`,
      };
    }
```

别忘了 `import { trimToolOutput } from "./trim";`。

`readTool` 也可以顺手升级：读大文件时文件内容没有"失败"概念，保持 head+tail 即可（把 `truncate(content)` 换成 `headTailTrim(content, { maxChars: 12_000 })`，注意取返回值的 `.text` 和 `.trimmed`）。

---

## 跑起来看看

写个 demo 验证两条规则。造一份 5000 行的合成测试日志——中间埋一个失败——看裁剪前后：

```ts
// demo.ts
import { trimToolOutput } from "./trim";

// 造一份合成日志：4999 行 pass + 中间埋一段失败
const lines: string[] = [];
for (let i = 0; i < 2500; i++) lines.push(`✓ suite-${i} > case-${i} (${i % 97}ms)`);
lines.push(
  "✗ suite-edge > 并发写冲突应该返回 409",
  "  AssertionError: expected 200 to be 409",
  "      at Object.<anonymous> (src/edge.test.ts:42:11)",
);
for (let i = 2500; i < 5000; i++) lines.push(`✓ suite-${i} > case-${i} (${i % 89}ms)`);
const log = lines.join("\n");

console.log(`原始日志：${log.length} 字符 / ${lines.length} 行\n`);

// 失败剪裁：模型收到的应该只有错误那几行
const pruned = trimToolOutput(log, true);
console.log("── failed=true（失败剪裁）──");
console.log(pruned.text);
console.log(`\n剪裁后：${pruned.text.length} 字符（压缩 ${Math.round((1 - pruned.text.length / log.length) * 100)}%）`);

// head+tail：同一份日志当成功输出处理
const ht = trimToolOutput(log, false);
console.log("\n── failed=false（head+tail）──");
console.log(ht.text.slice(0, 200) + "\n...(中间略)...\n" + ht.text.slice(-200));
console.log(`\n裁剪后：${ht.text.length} 字符（压缩 ${Math.round((1 - ht.text.length / log.length) * 100)}%）`);
```

预期输出（失败剪裁段）：

```
原始日志：157360 字符 / 5003 行

── failed=true（失败剪裁）──
...（省略 2498 行非错误输出）...
✓ suite-2498 > case-2498 (73ms)
✓ suite-2499 > case-2499 (74ms)
✗ suite-edge > 并发写冲突应该返回 409
  AssertionError: expected 200 to be 409
      at Object.<anonymous> (src/edge.test.ts:42:11)
✓ suite-2500 > case-2500 (8ms)

剪裁后：约 240 字符
```

5003 行 → 7 行（1 个错误块 + 前后各 2 行上下文）。**模型从 8000+ tokens 的噪音里解放出来，直接看到断言失败的精确位置**——这就是"砍哪里决定智商"的含义。

再用真实命令验证 bashTool 链路。在 mini-agent 目录下造一个故意失败的脚本：

```bash
echo 'console.log("start"); throw new Error("boom at line 2")' > bad.js
```

然后写个两行脚本直接调 bashTool：

```ts
// demo-bash.ts
import { bashTool } from "./tools";
const r = await bashTool.execute({ program: "node", args: ["bad.js"] }, { cwd: process.cwd() });
console.log(r.title);
console.log(r.output);
```

跑 `npx tsx demo-bash.ts`，应该看到标题是 `node 失败`，输出里保留着 `Error: boom at line 2` 及其调用栈——错误没有被截掉。

---

## 确定性测试

裁剪是纯函数，最适合写测试。新建 `test-trim.ts`：

```ts
// test-trim.ts
import { headTailTrim, pruneFailureLog, trimToolOutput } from "./trim";

let pass = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { console.error(`✗ ${name}`); process.exitCode = 1; }
}

// 1. 不超限不裁
const short = "abc\ndef";
assert(headTailTrim(short, { maxChars: 100 }).trimmed === false, "短文本不裁剪");

// 2. 超限：头在、尾在、中间有标记
const long = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join("\n");
const ht = headTailTrim(long, { maxChars: 500 });
assert(ht.trimmed && ht.text.includes("line-0"), "head+tail 保留头部");
assert(ht.text.includes("line-999"), "head+tail 保留尾部");
assert(ht.text.includes("省略"), "head+tail 有省略标记");
assert(ht.text.length <= 520, "head+tail 长度受控（标记少量溢出可接受）");

// 3. 行边界完整：头部不以半行开头
assert(ht.text.startsWith("line-"), "头部从完整行开始");

// 4. 失败剪裁：错误行及上下文保留，噪音消失
const log = [
  ...Array.from({ length: 50 }, (_, i) => `ok ${i}`),
  "Error: something broke",
  "  at foo.ts:10",
  ...Array.from({ length: 50 }, (_, i) => `ok ${i + 50}`),
].join("\n");
const pr = pruneFailureLog(log, { maxChars: 8000 });
assert(pr.text.includes("Error: something broke"), "剪裁保留错误行");
assert(pr.text.includes("at foo.ts:10"), "剪裁保留上下文");
assert(!pr.text.includes("ok 25"), "剪裁去掉噪音行");

// 5. 无错误行 → 降级 head+tail
const noErr = Array.from({ length: 800 }, (_, i) => `fine ${i}`).join("\n");
const fb = pruneFailureLog(noErr, { maxChars: 300 });
assert(fb.text.includes("fine 0") && fb.text.includes("fine 799"), "无错误行降级为 head+tail");

// 6. 错误行爆炸 → 最终仍受 maxChars 约束
const errStorm = Array.from({ length: 5000 }, (_, i) => `Error ${i}`).join("\n");
const bounded = pruneFailureLog(errStorm, { maxChars: 2000 });
assert(bounded.text.length <= 2100, "剪裁结果仍受 maxChars 约束");

// 7. 总入口分流
const ok = trimToolOutput(long, false);
const bad = trimToolOutput(log, true);
assert(ok.text.includes("line-999"), "总入口：成功走 head+tail");
assert(bad.text.includes("Error: something broke") && !bad.text.includes("ok 25"), "总入口：失败走剪裁");

// 8. 多字节字符安全（中文日志）
const zh = Array.from({ length: 900 }, () => "这是一行中文日志内容，用于测试字符数裁剪").join("\n");
const zhOut = headTailTrim(zh, { maxChars: 400 });
assert(zhOut.trimmed && !zhOut.text.includes("undefined"), "中文内容裁剪无乱码");

console.log(`\n${pass} 项通过`);
```

跑 `npx tsx test-trim.ts`，全部通过。

---

## 这期学到了什么

| 机制 | 规则 | 出处 |
|---|---|---|
| head+tail 裁剪 | 留头 60% + 尾 40%，砍中间，行边界对齐 | dsh 工具结果确定性裁剪 |
| 失败日志剪裁 | 只留错误行 + 前后 2 行上下文，区间合并 | Claude Code 失败日志剪裁（保留失败行，掐掉通过噪音） |
| 分流策略 | 成功 → head+tail，失败 → 剪裁 | 按结果状态选择裁剪策略 |
| 自我约束 | 每个裁剪函数都有 maxChars 上限，降级链兜底 | 护栏不能自己失控 |

关键心智模型：**裁剪不是"省 token"的优化，是"给模型看什么"的信息设计。** 留下错误行，模型的下一步就是定位问题；留下 pass 行，模型的下一步就是困惑。

---

## 课后练习

1. 给 `headTailTrim` 加一个 `minTailLines` 选项：无论尾部配额多小，至少保留最后 N 行（提示：很多工具的"结论"就在最后一行）。
2. `ERROR_MARKS` 目前匹配不到 Go 的 `goroutine 1 [running]:` 和 Java 的 `at com.xxx(Foo.java:1)`。扩充特征列表，并给 `test-trim.ts` 加两条对应用例。
3. 想一想：为什么裁剪要"确定性"（同样输入同样输出）？第 6 期讲前缀缓存时回来对答案。

---

## 下一期

模型拿到裁剪后的结果，行为就靠谱了吗？不一定。它会**重复调用同一个工具**——同样的参数，调了又调，像卡住的唱片。下一期我们实现重复调用检测：给每次调用算一个语义签名，达到阈值就往对话里注入一条提醒，把模型从原地打转里拽出来。
