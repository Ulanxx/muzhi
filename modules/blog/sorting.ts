import type { Post } from "./frontmatter";

/** 按日期从新到旧排序。日期相同则按 slug 字典序保证稳定性。 */
export function sortPostsByDateDesc(posts: readonly Post[]): Post[] {
  return [...posts].sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    return byDate !== 0 ? byDate : a.slug.localeCompare(b.slug);
  });
}

/** 过滤掉草稿。发布环境只应看到 draft !== true 的文章。 */
export function filterPublishedPosts(posts: readonly Post[]): Post[] {
  return posts.filter((post) => !post.draft);
}
