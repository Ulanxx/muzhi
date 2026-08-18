// 一次性脚本：把 docs/tutorial/*.md 转成 content/blog/*.mdx
import { promises as fs } from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "docs", "tutorial");
const DST = path.join(process.cwd(), "content", "blog");

// 每期的元数据（slug / title / summary / tags / date）
// date 用 2026-08-14 起，每期 +1 天，保证降序排列 = 1→8 期顺序
const META = {
  "01-data-model":    { slug: "build-agent-01-data-model",   title: "从零造 Agent 框架 · 01：为什么 agent 的消息不是一串文本", summary: "一个 agent 框架的地基——Session/Message/Part 三级数据模型，Part 联合类型，ToolState 状态机。动手实现 types.ts。", tags: ["Agent 框架", "教程"] },
  "02-tools":         { slug: "build-agent-02-tools",        title: "从零造 Agent 框架 · 02：让 LLM 长出手脚", summary: "工具系统设计：ToolDef 抽象、zod 参数校验+JSON Schema、6 个内置工具、输出截断、程序白名单。", tags: ["Agent 框架", "教程"] },
  "03-llm":           { slug: "build-agent-03-llm",          title: "从零造 Agent 框架 · 03：流式、工具调用解析、容错", summary: "LLM 调用层最难的部分——SSE 流式解析、工具调用参数的分片累积、空响应/网络错误重试。第一个难度高峰。", tags: ["Agent 框架", "教程"] },
  "04-loop":          { slug: "build-agent-04-loop",         title: "从零造 Agent 框架 · 04：ReAct 循环的工程实现", summary: "核心期：ReAct 循环、PartProjector（流式事件转 Part）、消息格式转换、停止条件。概念密度峰值。", tags: ["Agent 框架", "教程"] },
  "05-permission":    { slug: "build-agent-05-permission",   title: "从零造 Agent 框架 · 05：不能让 agent 乱删文件", summary: "权限系统：Ruleset DSL（最后匹配胜出）、通配匹配、PermissionEngine 三态审批（once/always/reject）、单一闸口。", tags: ["Agent 框架", "教程"] },
  "06-events":        { slug: "build-agent-06-events",       title: "从零造 Agent 框架 · 06：断线重连怎么续上", summary: "会话存储与事件流——事件溯源、per-session 递增 seq、live+回放合并订阅、可靠断线续传。", tags: ["Agent 框架", "教程"] },
  "07-compaction":    { slug: "build-agent-07-compaction",   title: "从零造 Agent 框架 · 07：对话太长怎么办", summary: "上下文压缩：85% 阈值触发、head 压摘要 + tail 保留原文、便宜模型生成摘要、失败降级。", tags: ["Agent 框架", "教程"] },
  "08-assembly":      { slug: "build-agent-08-assembly",     title: "从零造 Agent 框架 · 08：拼成一个能用的 mini agent", summary: "完结篇：把前 7 期模块拼成可交互 CLI agent，回顾设计哲学，对照 zmzai-agent 生产代码，进阶方向。", tags: ["Agent 框架", "教程"] },
};

async function main() {
  await fs.mkdir(DST, { recursive: true });
  const files = (await fs.readdir(SRC)).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const key = file.replace(/\.md$/, "");
    const meta = META[key];
    if (!meta) { console.warn(`跳过（无元数据）：${file}`); continue; }
    const raw = await fs.readFile(path.join(SRC, file), "utf8");
    // mdx 正文：去掉源文件里第一个 H1（标题已在 frontmatter，避免重复）
    const body = raw.replace(/^# .*\n+/, "");
    const date = `2026-08-${14 + Number(key.slice(0, 2)) - 1}`;
    const frontmatter = [
      "---",
      `title: ${JSON.stringify(meta.title)}`,
      `date: ${date}`,
      `summary: ${JSON.stringify(meta.summary)}`,
      `tags: [${meta.tags.map((t) => JSON.stringify(t)).join(", ")}]`,
      `draft: false`,
      "---",
      "",
    ].join("\n");
    const out = frontmatter + body + "\n";
    const dstPath = path.join(DST, `${meta.slug}.mdx`);
    await fs.writeFile(dstPath, out, "utf8");
    console.log(`✓ ${meta.slug}.mdx (${out.length} 字符)`);
  }
  console.log("完成");
}
main().catch((e) => { console.error(e); process.exit(1); });
