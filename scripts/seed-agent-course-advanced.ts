/**
 * 一次性入库脚本：把 docs/tutorial-advanced/*.md 作为进阶篇文档课 + 8 章写入 Mongo。
 * 结构：复用第一部系列（build-coding-agent-framework）+ 1 门 document 课程 + 8 个 chapter。
 * 全部免费（accessLevel: public，全章可读）。
 *
 * 运行：cd muzhi && npx tsx scripts/seed-agent-course-advanced.ts
 * 幂等：重复跑会 findOneAndUpdate 更新，不重复创建。系列已存在则不动（第一部脚本管）。
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
const COURSE_SLUG = "agent-robustness-advanced";
const TUTORIAL_DIR = path.join(process.cwd(), "docs", "tutorial-advanced");

/** 每期的元数据（文件名 → chapter 标题） */
const CHAPTERS: { file: string; title: string }[] = [
  { file: "01-trim.md", title: "第 1 期 · 工具结果裁剪：head+tail 与失败日志剪裁" },
  { file: "02-dedup.md", title: "第 2 期 · 重复调用检测：语义签名与阈值提醒" },
  { file: "03-breaker.md", title: "第 3 期 · 调用风暴断路器：烧钱前熔断" },
  { file: "04-retry-guard.md", title: "第 4 期 · 重复失败守卫：重试前先验状态" },
  { file: "05-repair.md", title: "第 5 期 · 工具调用修复管线：畸形 JSON 的多遍修复" },
  { file: "06-projection.md", title: "第 6 期 · 投影式压缩：canonical 历史不可变" },
  { file: "07-subagent.md", title: "第 7 期 · 子代理与权限隔离：写路径就是权限边界" },
  { file: "08-recovery.md", title: "第 8 期 · 运行恢复与总装：lease、护栏接线、混沌测试" },
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
  // 5. 有序列表 → 无序列表（DocumentMarkdown 不认 1. 2. 3.）
  body = body.replace(/^(\s*)\d+\.\s/gm, "$1- ");
  return body.trim() + "\n";
}

function parseRow(line: string): string[] {
  return line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

async function main() {
  await connectMongo();

  // 1. 系列：存在则沿用，不存在才创建（字段用 $setOnInsert，不覆盖第一部写好的）
  const series = await SeriesModel.findOneAndUpdate(
    { slug: SERIES_SLUG },
    {
      $setOnInsert: {
        slug: SERIES_SLUG,
        title: "从零造一个 Coding Agent 框架",
        description:
          "动手实现型教程系列。第一部 8 期造出 mini coding agent；进阶篇 8 期给它装上生产级护栏。参考实现：zmzai-agent。",
        accessLevel: "public",
        status: "published",
      },
    },
    { upsert: true, new: true, runValidators: true },
  );
  console.log(`✓ 系列：${series.title} (${series._id})`);

  // 2. 建进阶篇文档课（系列内第二门，position 1）
  const course = await CourseModel.findOneAndUpdate(
    { seriesId: series._id, slug: COURSE_SLUG },
    {
      $set: {
        title: "Agent 健壮性进阶篇",
        summary:
          "8 期续集：在第一部造出的 mini agent 之上，亲手实现生产级护栏——结果裁剪、重复检测、断路器、失败守卫、修复管线、投影式压缩、子代理隔离、运行恢复。每期代码实跑验证，116 个确定性断言全绿。",
        position: 1,
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
          isPreview: true, // 全免费：所有章都可读
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
