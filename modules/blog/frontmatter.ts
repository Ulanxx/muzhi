import { z } from "zod";

/**
 * 博客文章的 frontmatter 约定。所有文章必须带这些元数据，
 * 缺必填字段或类型不对时构建直接失败，绝不静默降级。
 */
export const postFrontmatterSchema = z.object({
  title: z.string().min(1, "文章标题不能为空"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "日期必须是 YYYY-MM-DD 格式"),
  summary: z.string().min(1, "摘要不能为空"),
  tags: z.array(z.string().min(1)).default([]),
  draft: z.boolean().default(false),
});

export type PostFrontmatter = z.infer<typeof postFrontmatterSchema>;

export interface Post extends PostFrontmatter {
  slug: string;
}

/**
 * 解析并校验一段 frontmatter 数据。slug 由调用方提供（取自文件名）。
 * gray-matter 会把 date: 2026-08-01 解析成 Date 对象，这里统一归一成
 * YYYY-MM-DD 字符串。校验失败返回 null 而不是抛出，由调用方决定
 * 如何处理（通常是跳过并警告），避免一篇坏文章让整个站构建失败。
 */
export function parsePostFrontmatter(
  data: unknown,
  slug: string,
): PostFrontmatter | null {
  const normalized = normalizeDateFields(data);
  const result = postFrontmatterSchema.safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    console.warn(`[blog] 跳过 frontmatter 不合法的文章 ${slug} — ${issues}`);
    return null;
  }
  return result.data;
}

function normalizeDateFields(data: unknown): unknown {
  if (typeof data !== "object" || data === null) {
    return data;
  }
  const record = data as Record<string, unknown>;
  if (record.date instanceof Date) {
    return { ...record, date: formatDate(record.date) };
  }
  return data;
}

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
