import { promises as fs } from "node:fs";
import path from "node:path";

import matter from "gray-matter";

import {
  parsePostFrontmatter,
  type Post,
} from "./frontmatter";
import { filterPublishedPosts, sortPostsByDateDesc } from "./sorting";

export const BLOG_CONTENT_DIR = path.join(process.cwd(), "content", "blog");

/**
 * 读取 content/blog 下所有 .mdx 文件的 frontmatter，返回按日期倒序、
 * 已过滤草稿的文章列表。只读元数据，不编译正文。
 * 这一层负责文件系统 IO；校验和排序逻辑在纯函数里。
 */
export async function listPosts(): Promise<Post[]> {
  let fileNames: string[];
  try {
    fileNames = await fs.readdir(BLOG_CONTENT_DIR);
  } catch {
    return [];
  }

  const posts = await Promise.all(
    fileNames
      .filter((name) => name.endsWith(".mdx"))
      .map(async (fileName) => {
        const slug = fileName.replace(/\.mdx$/, "");
        const raw = await fs.readFile(
          path.join(BLOG_CONTENT_DIR, fileName),
          "utf8",
        );
        const { data } = matter(raw);
        const frontmatter = parsePostFrontmatter(data, slug);
        return frontmatter === null ? null : { slug, ...frontmatter };
      }),
  );

  const valid = posts.filter((post): post is Post => post !== null);
  return sortPostsByDateDesc(filterPublishedPosts(valid));
}

/** 取最新 N 篇，用于首页「最新文章」区块。 */
export async function listRecentPosts(count: number): Promise<Post[]> {
  const posts = await listPosts();
  return posts.slice(0, count);
}
