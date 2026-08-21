# Agent 健壮性进阶篇 · 教程目录

> 8 期动手实现型教程，第一部「从零造一个 Coding Agent 框架」的正统续集。这一部只干一件事：**给能跑的 agent 加护栏，让它能跑很久、跑很多轮、出事了还能救回来**。
>
> 前置要求：完成第一部 8 期（`docs/tutorial/`），手里有一个能用的 mini-agent。本系列所有代码直接长在第一部的项目上。
>
> 每个机制都有真实出处：Claude Code、Codex、OpenCode、Reasonix、dsh 等 harness 的内部设计（见 `../../zmzai-agent/docs/borrowable-techniques.md`）。

## 为什么需要这一部

第一部的 mini-agent 能完成"读文件 → 改代码 → 跑测试"这样的短任务。但只要让它跑长一点，立刻暴露三类问题：

1. **信息过载**：一次 `npm test` 输出 5000 行，全塞进上下文，模型被噪音淹没，token 账单爆炸
2. **行为失控**：同一个失败命令重试 20 次、调用风暴烧穿预算、畸形 JSON 让循环直接崩
3. **不可恢复**：进程崩了，跑到一半的会话什么都剩不下

真实生产 agent 和玩具 agent 的差距，全在护栏上。这一部我们把 8 个生产级机制一个个装上去。

## 期数

| # | 标题 | 产出 | 难度 |
|---|---|---|---|
| 1 | [工具结果的聪明裁剪——砍哪里决定 agent 的智商](01-trim.md) | `trim.ts` | ⭐⭐ |
| 2 | [重复调用检测——别让 agent 原地打转](02-dedup.md) | `guards.ts` | ⭐⭐ |
| 3 | [调用风暴断路器——烧钱前熔断](03-breaker.md) | `breaker.ts` | ⭐⭐⭐ |
| 4 | [重复失败守卫——重试前先验状态](04-retry-guard.md) | `guards.ts` 续 | ⭐⭐⭐ |
| 5 | [工具调用修复管线——畸形 JSON 的多遍修复](05-repair.md) | `repair.ts` | ⭐⭐⭐⭐ |
| 6 | [投影式压缩——canonical 历史不可变](06-projection.md) | `compaction.ts` 重构 | ⭐⭐⭐ |
| 7 | [子代理与权限隔离——写路径就是权限边界](07-subagent.md) | `task.ts` | ⭐⭐⭐⭐ |
| 8 | [运行恢复与总装——lease、护栏接线、混沌测试](08-recovery.md) | `lease.ts` + 总装 | ⭐⭐⭐⭐ |

## 难度曲线

第 5 期（修复管线）和第 7 期（子代理）是高峰。第 1-3 期是独立小件，可以单独拿去用。

## 最终产出

第一部 10 个文件之上，新增 6 个模块：

```
mini-agent/
├─ …（第一部全部文件）
├─ trim.ts         结果裁剪（head+tail + 失败日志剪裁）
├─ guards.ts       重复检测 + 失败守卫
├─ breaker.ts      调用风暴断路器
├─ repair.ts       工具调用修复管线
├─ task.ts         子代理（路径隔离）
└─ lease.ts        执行租约与恢复
```

## 配套阅读

- 第一部教程：`../tutorial/`
- 机制出处与源码级研究：`../../zmzai-agent/docs/borrowable-techniques.md`
- 三方架构比对：`../../zmzai-agent/docs/architecture-comparison.md`
