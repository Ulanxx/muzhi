/**
 * 一次性入库脚本：把 docs/tutorial/*.md 作为一门文档课 + 8 章写入 Mongo。
 * 结构：1 个 series（"从零造 Agent 框架"）+ 1 门 document 课程 + 8 个 chapter。
 * 全部免费（accessLevel: public，全章可读）。
 *
 * 运行：cd muzhi && npx tsx scripts/seed-agent-course.ts
 * 幂等：重复跑会 findOneAndUpdate 更新，不重复创建。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

// tsx(cjs) 不支持顶层 await，且不经 Next env 加载。同步读 .env.local，不引入 dotenv。
import { readFileSync } from "node:fs";
const envFile = (() => { try { return readFileSync(path.join(process.cwd(), ".env.local"), "utf8"); } catch { return ""; } })();
for (const line of envFile.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const idx = trimmed.indexOf("=");
  if (idx === -1) continue;
  const key = trimmed.slice(0, idx).trim();
  const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
  if (!(key in process.env)) process.env[key] = value;
}

import { connectMongo } from "@/providers/database/mongodb/connection";
import { CourseChapterModel } from "@/providers/database/mongodb/models/learning";
import { CourseModel, SeriesModel } from "@/providers/database/mongodb/models/series";

const SERIES_SLUG = "build-coding-agent-framework";
const COURSE_SLUG = "build-coding-agent-framework";
const TUTORIAL_DIR = path.join(process.cwd(), "docs", "tutorial");

/** 每期的元数据（文件名 → {chapter 标题, 顺序}） */
const CHAPTERS: { file: string; title: string }[] = [
  { file: "01-data-model.md", title: "第 1 期 · 数据模型：为什么 agent 的消息不是一串文本" },
  { file: "02-tools.md", title: "第 2 期 · 工具系统：让 LLM 长出手脚" },
  { file: "03-llm.md", title: "第 3 期 · LLM 调用层：流式、工具调用解析、容错" },
  { file: "04-loop.md", title: "第 4 期 · Agent 循环：ReAct 的工程实现" },
  { file: "05-permission.md", title: "第 5 期 · 权限系统：不能让 agent 乱删文件" },
  { file: "06-events.md", title: "第 6 期 · 会话存储与事件流：断线重连怎么续上" },
  { file: "07-compaction.md", title: "第 7 期 · 上下文压缩：对话太长怎么办" },
  { file: "08-assembly.md", title: "第 8 期 · 组装与收尾：拼成一个能用的 mini agent" },
];

/**
 * 把教程正文清洗成 ChapterMarkdown 支持的 markdown 子集。
 * ChapterMarkdown 支持：代码块 / ## / ### / > / -或* 列表 / **粗** / `行内` / 段落。
 * 不支持：表格、# 一级标题、---- 分隔线、有序列表。这里做转换。
 */
function cleanForReader(raw: string): string {
  let body = raw;
  // 1. 去掉第一个一级标题（H1）——章节标题已在 chapter.title，避免重复
  body = body.replace(/^# .*\n+/m, "");
  // 2. 去掉 ---- 水平分隔线（DocumentReader 不渲染，会显示成原始文本）
  body = body.replace(/\n---\n/g, "\n\n");
  // 3. 把后续的 # 一级标题（如「先看效果」）降级为 ## （DocumentMarkdown 只认 ##/###）
  body = body.replace(/^# /gm, "## ");
  // 4. 表格 → 列表。匹配 GFM 表格块（含 | 分隔行 + 分隔行 ---）
  body = body.replace(/(?:^|\n)((?:\|[^\n]+\|\s*\n)+\|[^\n]+\|\s*\n?(?:\|[\s:-]+\|[^\n]*\n)((?:\|[^\n]+\|\s*\n)+))/g, (block) => {
    const lines = block.trim().split("\n").map((l) => l.trim());
    // 第一行是表头，第二行是 |---|，其余是数据行
    const header = parseRow(lines[0]!);
    const rows = lines.slice(2).filter((l) => l && !/^\|[\s:-]+\|?$/.test(l)).map(parseRow);
    let out = "";
    if (header.length) out += `**${header.join(" / ")}**\n\n`;
    for (const row of rows) {
      const cells = row.map((cell, i) => {
        const h = header[i] ?? `列${i + 1}`;
        return `**${h}**：${cell}`;
      });
      out += `- ${cells.join("；")}\n`;
    }
    return `\n${out}\n`;
  });
  return body.trim() + "\n";
}

function parseRow(line: string): string[] {
  return line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

async function main() {
  await connectMongo();

  // 1. 建系列
  const series = await SeriesModel.findOneAndUpdate(
    { slug: SERIES_SLUG },
    {
      $set: {
        title: "从零造一个 Coding Agent 框架",
        description:
          "8 期动手实现型教程。跟着敲出一个约 1000 行 TypeScript 的 mini coding agent——能读文件、改文件、跑命令、要权限、压缩上下文。每一期产出一个能跑的模块，最终拼成一个端到端的 agent。参考实现：zmzai-agent。",
        accessLevel: "public",
        status: "published",
      },
      $setOnInsert: { slug: SERIES_SLUG },
    },
    { upsert: true, new: true, runValidators: true },
  );
  console.log(`✓ 系列：${series.title} (${series._id})`);

  // 2. 建文档课
  const course = await CourseModel.findOneAndUpdate(
    { seriesId: series._id, slug: COURSE_SLUG },
    {
      $set: {
        title: "从零造一个 Coding Agent 框架",
        summary:
          "8 期教程，亲手实现 coding agent 框架的核心：数据模型、工具系统、LLM 流式调用、ReAct 循环、权限闸口、事件流、上下文压缩。学完你能读懂任何生产级 agent 框架（zmzai-agent / OpenCode / Reasonix）。",
        position: 0,
        accessLevel: "public",
        contentType: "document",
        status: "published",
        publishedAt: new Date(),
      },
      $setOnInsert: {
        seriesId: series._id,
        slug: COURSE_SLUG,
        videoAssetId: null,
      },
    },
    { upsert: true, new: true, runValidators: true },
  );
  console.log(`✓ 课程：${course.title} (${course._id})`);

  // 3. 建 8 章
  for (let i = 0; i < CHAPTERS.length; i++) {
    const meta = CHAPTERS[i]!;
    const raw = await fs.readFile(path.join(TUTORIAL_DIR, meta.file), "utf8");
    const body = cleanForReader(raw);
    await CourseChapterModel.findOneAndUpdate(
      { courseId: course._id, position: i },
      {
        $set: {
          title: meta.title,
          body,
          isPreview: true, // 全免费：所有章都可读（public 课程下 isPreview 控制是否 SSR 直出）
        },
        $setOnInsert: {
          courseId: course._id,
          position: i,
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
    console.log(`✓ 第 ${i + 1} 章：${meta.title}（${body.length} 字符）`);
  }

  console.log(`\n完成。访问 /courses 查看，课程页 /learn/${course._id}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
