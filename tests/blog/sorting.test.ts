import { describe, expect, it } from "vitest";

import {
  filterPublishedPosts,
  sortPostsByDateDesc,
} from "@/modules/blog/sorting";
import type { Post } from "@/modules/blog/frontmatter";

function makePost(overrides: Partial<Post>): Post {
  return {
    slug: "post",
    title: "标题",
    date: "2026-01-01",
    summary: "摘要",
    tags: [],
    draft: false,
    ...overrides,
  };
}

describe("sortPostsByDateDesc", () => {
  it("按日期从新到旧排序", () => {
    const sorted = sortPostsByDateDesc([
      makePost({ slug: "old", date: "2026-01-01" }),
      makePost({ slug: "new", date: "2026-08-03" }),
      makePost({ slug: "mid", date: "2026-05-15" }),
    ]);
    expect(sorted.map((post) => post.slug)).toEqual(["new", "mid", "old"]);
  });

  it("日期相同时按 slug 字典序保证稳定", () => {
    const sorted = sortPostsByDateDesc([
      makePost({ slug: "b", date: "2026-08-03" }),
      makePost({ slug: "a", date: "2026-08-03" }),
    ]);
    expect(sorted.map((post) => post.slug)).toEqual(["a", "b"]);
  });
});

describe("filterPublishedPosts", () => {
  it("过滤掉草稿", () => {
    const published = filterPublishedPosts([
      makePost({ slug: "live", draft: false }),
      makePost({ slug: "wip", draft: true }),
    ]);
    expect(published.map((post) => post.slug)).toEqual(["live"]);
  });
});
