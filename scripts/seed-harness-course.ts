/**
 * 一次性入库脚本：把 docs/tutorial-harness/*.md 作为「Harness 拆解课」10 期写入 Mongo。
 * 结构：复用「从零造一个 Coding Agent 框架」系列（第三部，position 2）+ 1 门 document 课程 + 10 个 chapter。
 * 全部免费（accessLevel: public，全章 isPreview: true）。
 *
 * 运行：cd muzhi && npx tsx scripts/seed-harness-course.ts [env文件，默认 .env.local]
 * 入库 HK 生产：npx tsx scripts/seed-harness-course.ts .env.production.local
 * 幂等：重复跑会 findOneAndUpdate 更新，不重复创建。系列已存在则不动（第一部脚本管）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

// tsx(cjs) 不支持顶层 await，且不经 Next env 加载。同步读 env 文件，不引入 dotenv。
// 第一个命令行参数指定 env 文件（默认 .env.local；生产入库传 .env.production.local）。
import { readFileSync } from "node:fs";
const envFileName = process.argv[2] ?? ".env.local";
const envFile = (() => { try { return readFileSync(path.join(process.cwd(), envFileName), "utf8"); } catch { return ""; } })();
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
const COURSE_SLUG = "harness-teardown";
const TUTORIAL_DIR = path.join(process.cwd(), "docs", "tutorial-harness");

/** 每期的元数据（文件名 → chapter 标题） */
const CHAPTERS: { file: string; title: string }[] = [
  { file: "01-harness.md", title: "第 1 期 · 什么是 harness：拆解方法论与七家全景" },
  { file: "02-codex.md", title: "第 2 期 · Codex CLI：apply_patch 与 approval×sandbox 双轴" },
  { file: "03-claude.md", title: "第 3 期 · Claude Code：分层指令、权限规则与钩子执法" },
  { file: "04-opencode.md", title: "第 4 期 · OpenCode：读穿开源循环，移植会话分叉" },
  { file: "05-gemini.md", title: "第 5 期 · Gemini CLI：上下文预算与免费额度工程" },
  { file: "06-pi.md", title: "第 6 期 · Pi：极简派的一千 token 提示词与会话树" },
  { file: "07-deepseek.md", title: "第 7 期 · DeepSeek Harness：一切皆插件与 KV 缓存执念" },
  { file: "08-permissions.md", title: "第 8 期 · 权限与沙箱七家横评：同一个动作，六张裁决书" },
  { file: "09-storage.md", title: "第 9 期 · 会话存储与断点续跑：resume 不是读文件，是重放" },
  { file: "10-graduation.md", title: "第 10 期 · 毕业改造：把九期的精华装回 zmzai-agent" },
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
  body = body.replace(new RegExp("\n---\n", "g"), "\n\n");
  // 3. 把后续的 # 一级标题降级为 ##（DocumentMarkdown 只认 ##/###）
  body = body.replace(/^# /gm, "## ");
  // 4. 逐块处理：代码块原样保留；其余块里表格 → 列表、有序列表 → 无序列表
  body = body
    .split(/(```[\s\S]*?```)/g)
    .map((seg) => {
      if (seg.startsWith("```")) return seg;
      let text = seg.replace(/(?:^|\n)((?:\|[^\n]+\|\s*\n)+)/g, (block) => {
        const lines = block.trim().split("\n").map((l) => l.trim());
        if (lines.length < 2) return block; // 单行竖线不是表格
        const sepIdx = lines.findIndex((l) => /^\|[\s:-]+(\|[\s:-]+)*\|?$/.test(l) && l.includes("-"));
        if (sepIdx <= 0) return block; // 没有表头 + 分隔行，不是 GFM 表格
        const header = parseRow(lines[0]!);
        const rows = [...lines.slice(1, sepIdx), ...lines.slice(sepIdx + 1)].filter(Boolean).map(parseRow);
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
      text = text.replace(/^(\s*)\d+\.\s/gm, "$1- ");
      return text;
    })
    .join("");
  return body.trim() + "\n";
}

function parseRow(line: string): string[] {
  return line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

async function main() {
  console.log(`→ env 文件：${envFileName}`);
  await connectMongo();

  // 1. 系列：存在则沿用，不存在才创建（字段用 $setOnInsert，不覆盖前两部写好的）
  const series = await SeriesModel.findOneAndUpdate(
    { slug: SERIES_SLUG },
    {
      $setOnInsert: {
        slug: SERIES_SLUG,
        title: "从零造一个 Coding Agent 框架",
        description:
          "动手实现型教程系列。第一部 8 期造出 mini coding agent；进阶篇 8 期给它装上生产级护栏；第三部反过来拆真实产品——六家开源 harness 的源码级拆解与毕业改造。参考实现：zmzai-agent。",
        accessLevel: "public",
        status: "published",
      },
    },
    { upsert: true, new: true, runValidators: true },
  );
  console.log(`✓ 系列：${series.title} (${series._id})`);

  // 2. 建 Harness 拆解课文档课（系列内第三门，position 2）
  const course = await CourseModel.findOneAndUpdate(
    { seriesId: series._id, slug: COURSE_SLUG },
    {
      $set: {
        title: "Harness 拆解课",
        summary:
          "10 期源码级拆解：Codex CLI、Claude Code、OpenCode、Gemini CLI、Pi、DeepSeek Harness 六家 harness 逐一读穿（证据钉到文件与行级），每期在沙箱里移植验证——12 个零件、276 条确定性断言、9 场真实 LLM 实跑，毕业课把精华装回 zmzai-agent。",
        position: 2,
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

  // 3. 建 10 章
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
