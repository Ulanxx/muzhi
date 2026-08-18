# 从零造一个 Coding Agent 框架 · 教程目录

> 8 期动手实现型教程。读者跟着敲出一个 ~1000 行 TypeScript 的 mini coding agent，最终拥有一个能读文件、改文件、跑命令、要权限、压缩上下文的端到端 agent。
>
> 参考实现：[zmzai-agent](https://github.com/zmzai-cloud)（真实生产代码，每期对照源码位置）。

## 适合谁

- 会 TypeScript 基础（类型、泛型、async/await）
- 调过大模型 API，理解 function calling 概念
- 想搞懂 agent 框架内部机制，而不只是调 SDK

## 期数

| # | 标题 | 产出 | 难度 |
|---|---|---|---|
| 1 | [数据模型——为什么 agent 的消息不是一串文本](01-data-model.md) | `types.ts` | ⭐ |
| 2 | [工具系统——让 LLM 长出手脚](02-tools.md) | `tools.ts` | ⭐⭐ |
| 3 | [LLM 调用层——流式、工具调用解析、容错](03-llm.md) | `llm.ts` | ⭐⭐⭐ |
| 4 | [Agent 循环——ReAct 的工程实现](04-loop.md) | `loop.ts` + `projector.ts` | ⭐⭐⭐⭐ |
| 5 | [权限系统——不能让 agent 乱删文件](05-permission.md) | `permission.ts` | ⭐⭐⭐ |
| 6 | [会话存储与事件流——断线重连怎么续上](06-events.md) | `store.ts` + `events.ts` | ⭐⭐⭐ |
| 7 | [上下文压缩——对话太长怎么办](07-compaction.md) | `compaction.ts` | ⭐⭐ |
| 8 | [组装与收尾——拼成一个能用的 mini agent](08-assembly.md) | `cli.ts` | ⭐⭐ |

## 难度曲线

第 3-4 期是高峰（流式解析 + ReAct 循环），过了这两期后面越来越顺。

## 最终产出

```
mini-agent/
├─ types.ts        数据模型
├─ tools.ts        工具系统（6 内置）
├─ llm.ts          LLM 调用（流式+累积+重试）
├─ loop.ts         Agent 循环（ReAct + 投影）
├─ permission.ts   权限引擎（三态+缓存）
├─ events.ts       事件流（seq+订阅）
├─ store.ts        会话存储
├─ compaction.ts   上下文压缩
└─ cli.ts          CLI 入口
```

## 配套阅读

- zmzai-agent 完整技术方案：`../zmzai-agent-architecture.md`
- 进阶机制研究（Reasonix/dsh 借鉴）：`../../zmzai-agent/docs/borrowable-techniques.md`
