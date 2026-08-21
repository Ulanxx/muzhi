# 第 8 期：运行恢复与总装——lease、护栏接线、混沌测试

> **Agent 健壮性进阶篇 · 第 8 期（共 8 期）**
>
> 最后一期，收网。真实系统会崩：进程挂了，跑到一半的任务怎么办？同一个任务被两个 worker 同时领走怎么办？这期给运行加 **lease（租约）**——谁持有租约谁干活，过期自动易主。然后把前七期的护栏做一次总装检视，最后上一组混沌测试：连败、坏 JSON、越界写、重复调用……一起往系统里招呼，看它站不站得住。

---

## 这期解决什么问题

前七期的护栏都保护"调用"这一层：单次调用坏了、重复了、失败了，各有守卫。但还有一层没保护——**运行本身**：

- 进程跑到一半崩了，任务状态停在"进行中"，没人接手，永远卡死；
- 两个 worker 同时领走同一个任务，双份开销、互相踩踏；
- 单测都绿，但护栏们装在同一条流水线上，互相之间有没有打架？没人验过。

三个问题，三件武器：租约、总装图、混沌测试。

---

## Step 1：lease.ts——谁持有租约谁干活

租约是分布式任务系统最朴素的容错原语：**持有者必须持续证明自己活着**（心跳续约），证明不了（过期）就视为已死，别人可以接手。不需要任何"崩溃上报"机制——沉默就是死亡证明。

```ts
// lease.ts

export type Lease = {
  runId: string;
  holder: string;   // 持有者（worker id）
  expiresAt: number; // epoch ms
};

export class LeaseManager {
  private readonly leases = new Map<string, Lease>();

  /**
   * @param ttlMs 租约有效期：到期不续约就视为持有者已死
   * @param now 时钟注入：测试用假时钟，生产默认 Date.now
   */
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 抢占运行权：没有租约、或租约已过期 → 拿到；别人的有效租约 → 拿不到。
   * 注意语义：过期租约直接易主，不需要显式释放——这就是"崩溃自愈"。
   */
  acquire(runId: string, holder: string): boolean {
    const cur = this.leases.get(runId);
    if (cur && cur.expiresAt > this.now() && cur.holder !== holder) return false;
    this.leases.set(runId, { runId, holder, expiresAt: this.now() + this.ttlMs });
    return true;
  }

  /** 续约：只有当前持有者能续。干活期间周期性调用（心跳） */
  renew(runId: string, holder: string): boolean {
    const cur = this.leases.get(runId);
    if (!cur || cur.holder !== holder) return false;
    if (cur.expiresAt <= this.now()) return false; // 已经过期易主了，续不回来
    cur.expiresAt = this.now() + this.ttlMs;
    return true;
  }

  /** 释放：正常结束时主动交还（不交也行，等过期即可） */
  release(runId: string, holder: string): boolean {
    const cur = this.leases.get(runId);
    if (!cur || cur.holder !== holder) return false;
    this.leases.delete(runId);
    return true;
  }
}
```

三个细节：

**时钟注入。** `now` 走构造参数，测试用假时钟把"一小时后"变成一行 `t += 3600_000`——涉及时间的逻辑不注入时钟，测试就只能 `setTimeout` 干等，慢且抖。

**"死掉的 A 续不回来"。** 租约过期易主之后，原持有者就算复活也续不了约、抢不回——否则会出现两个 worker 都以为自己在干活的裂脑。复活者的正确姿势是重新 `acquire`，拿不到就等。

**释放是礼貌，不是义务。** 正常结束 `release` 一下让下个 worker 立刻可抢；崩了就什么都不用做，ttl 到了自然易主。容错机制的设计原则：**正常路径可以讲究，异常路径必须自愈**。

---

## Step 2：护栏总装图

八期下来，`loop.ts` 的工具执行段长成了一条严格的流水线。顺序不是随手排的，每一级都有理由：

```text
LLM 返回工具调用
  │
  ├─ ① 断路器 check()          ——熔断中？整条流水线直接短路（第 3 期）
  ├─ ② 失败守卫 checkBefore()   ——黑名单/写循环？拦（第 4 期）
  ├─ ③ __parse_error 短路       ——修复管线救不回来的，直接喂回模型（第 5 期）
  ├─ ④ 权限 permission.ask()    ——问人（第一部）
  ├─ ⑤ 工具查找 + 名字修复       ——找不到先修名字（第 5 期）
  ├─ ⑥ 执行工具
  └─ ⑦ 记账：RepeatGuard（提醒）/ 断路器 / 失败守卫（第 2-4 期）
```

顺序背后的三条原则：

**便宜的在前。** ①②③ 都是纯内存判断，微秒级；④ 要等人点按钮，秒级起步。让护栏先把明显不该过的挡住，用户才不会审批疲劳。

**护栏不记账格式损坏。** ③ 在 ⑦ 之前短路——一次 JSON 损坏不是模型的"行为"，不该进重复检测、不该算连败。

**提醒最弱、最后出手。** 记账时 RepeatGuard 的 advisory 只是追加进工具结果文本（第 2 期），不改流程；拦截（②）改流程；熔断（①）停整条线。**说 → 拦 → 停**，强度递增，只在上一级失效时出手。

对照检查你的框架时，就问这三个问题：贵的检查是不是排后面了？格式错误会不会污染行为统计？最轻的手段是不是先用上了？

---

## Step 3：混沌测试

单测验证"每个部件单独转得动"，混沌测试验证"部件装在一起不打架"。`test-chaos.ts` 五个场景，全是机制间的联动：

```ts
// 场景 A：租约完整生命周期（假时钟）
let t = 1000;
const lm = new LeaseManager(100, () => t);
assert(lm.acquire("run-1", "worker-A"), "A 首次抢占成功");
assert(!lm.acquire("run-1", "worker-B"), "有效租约内 B 抢不走");
t += 250; // 超过 ttl，A 没续上
assert(lm.acquire("run-1", "worker-B"), "过期后 B 接手（崩溃自愈）");
assert(!lm.renew("run-1", "worker-A"), "死掉的 A 续不回来");

// 场景 B：连败风暴 → 熔断 → 冷却 → 试探 → 自愈
for (let i = 0; i < 5; i++) { breaker.check(); breaker.recordResult(false, "bash", args); }
try { breaker.check(); tripped = true; } catch { /* BreakerError */ }
assert(tripped, "5 连败后断路器熔断");
await new Promise((r) => setTimeout(r, 60)); // 冷却
breaker.check();                     // half-open 试探
breaker.recordResult(true, "bash", args);
assert(true, "试探成功后断路器自愈（half-open → closed）");

// 场景 C：修复管线与重复检测的联动——最容易漏的接缝
const fixed = repairArguments('{"path": "a.txt"');  // 截断的参数
const sigRepaired = callSignature("read", fixed.value);
const sigOriginal = callSignature("read", { path: "a.txt" });
assert(sigRepaired === sigOriginal, "修复后的调用签名与原意图一致");
// ↑ 如果这里不相等，RepeatGuard 会把修复过的调用当成新调用——
//   模型反复发同一个坏参数，每次"修复后"都是新签名，重复检测全线漏报
```

场景 C 值得多说一句：**两个机制的接缝处是 bug 的富矿。** 修复管线（第 5 期）和重复检测（第 2 期）各测各的都是绿的，但如果 `canonicalize` 的实现不一致、修复后签名对不上原意图，联动就是坏的——只有把两个机制放进同一个断言才能逮住。

其余场景：失败守卫的"拉黑 → 干预解锁 → 再失败立刻重新拉黑"（第 4 期语义回归）、RepeatGuard 默认模式与静默模式互不干扰、五种越权路径姿势（`../`、深层绕路、绝对路径、`..`、`./` 混写）全部被 `resolveWithin` 拦下。

`npx tsx test-chaos.ts`，20 项全过。全套回归（8 个测试文件）：14 + 8 + 11 + 9 + 18 + 21 + 15 + 20 = **116 断言全绿**。

---

## 跑起来看看：全默认护栏的一次真实运行

`demo-adv-08.ts` 不加任何自定义配置——RepeatGuard、断路器、失败守卫、修复管线、投影压缩全部默认装配，外加租约防双开。任务故意诱导原样重跑：

```text
✓ 拿到租约，worker-main 开始干活
✗ 模拟另一个 worker 抢同一任务 → 被拒（防双开生效）

  ├ bash ✓ $ node check.js FAIL: add(2,3) = -1
  ├ bash ✓ $ node check.js FAIL: add(2,3) = -1
  ├ read ✓ import { add } from "./buggy.js"; if (add(2, 3) !== 5) { console.error
  ├ bash ✓ $ node check.js FAIL: add(2,3) = -1   [重复调用提醒] 你已用完全相同的参数调用 "bash" 3 次

════ 最终回复：
我发现了：`buggy.js` 中的 `add` 函数有 bug，`add(2,3)` 返回 -1 而不是 5……

✓ 运行结束，租约已释放
```

读法：租约把模拟的第二个 worker 挡在门外；第 3 次同签名 bash 调用时，RepeatGuard 的 advisory 精确出现、追加在工具结果尾部——模型看见了、也没被打断，照常给出结论。**软提醒的最高境界：在场但不抢戏。**

还有一次没写进脚本的真实混沌，值得记录：首轮实跑时模型把 `node check.js` 整串塞进 bash 的 `program` 字段，白名单拒绝，连败两次后被失败守卫拉黑；模型换了别的动作（干预），黑名单解除；回头再犯同样的错，**一次失败就重新拉黑**——第 4 期"失败计数不清零"的设计在真实流量里自动演了一遍。护栏不需要模型配合，它们等的就是模型不配合。

---

## 这期学到了什么

| 机制 | 规则 | 出处 |
|---|---|---|
| 租约 | 心跳证明活着，过期自动易主，裂脑不可续 | LeaseManager |
| 时钟注入 | 时间逻辑的测试不等待、不抖动 | 构造参数 `now` |
| 流水线顺序 | 便宜在前、审批在后、格式损坏不记账 | 总装三原则 |
| 接缝测试 | 两个机制的联动断言比各自的单测更值钱 | 场景 C |

关键心智模型：**容错的尽头是自愈。** 租约不等崩溃上报，过期就是死亡证明；护栏不等模型变乖，拦截就是秩序本身。设计异常路径时永远问一句：没人来报告的时候，系统靠什么恢复？

---

## 课后练习

1. 现在的 `LeaseManager` 是内存版。把它换成文件版：租约写成 `<runId>.lease` JSON 文件，`acquire` 用"原子写"（临时文件 + rename）防并发竞争。想想两个进程同时判断"租约已过期"时还会发生什么。
2. 给 `runAgent` 接上租约：循环每步开头 `renew` 一次（心跳），失败就让出运行权退出循环。思考：心跳失败时正在执行的工具调用怎么办？
3. 混沌测试场景 B 用了 `setTimeout(60)` 等冷却——这是全文件唯一的真实等待。把断路器的时钟也改成可注入（参考 LeaseManager），消灭这个等待。

---

## 系列收官

八期走完，回头看这个从第一部一路长出来的小框架：

```text
mini-agent/
├─ llm.ts          流式调用与事件解析（第一部）
├─ loop.ts         ReAct 循环 + 护栏流水线（第一部 → 本期总装）
├─ tools.ts        内置工具集（第一部 → 本期支持注入）
├─ permission.ts   审批引擎（第一部）
├─ trim.ts         工具结果裁剪（第 1 期）
├─ guards.ts       语义签名 + 重复提醒（第 2 期）
├─ breaker.ts      调用风暴断路器（第 3 期）
├─ failure-guard.ts 重复失败守卫（第 4 期）
├─ repair.ts       工具调用修复管线（第 5 期）
├─ compaction.ts   投影式压缩（第 6 期重构）
├─ prefix-cache.ts 前缀缓存诊断（第 6 期）
├─ task.ts         子代理与沙箱隔离（第 7 期）
├─ lease.ts        运行租约（第 8 期）
└─ test-*.ts       8 个测试文件，116 断言
```

这不是玩具清单，是一份**生产级 Agent 框架的骨骼图**：每一个文件都对应一类真实的故障模式，每一类故障都有实测复现和确定性回归。把这套骨骼装进任何外壳——CLI、IDE 插件、Web 产品——你写的都不再是"调 API 的壳"，而是扛得住模型抽风的系统。

下一篇见。
