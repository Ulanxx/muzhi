import { describe, expect, it } from "vitest";

import { parsePostFrontmatter } from "@/modules/blog/frontmatter";

describe("parsePostFrontmatter", () => {
  it("接受完整的合法 frontmatter", () => {
    const result = parsePostFrontmatter(
      {
        title: "测试文章",
        date: "2026-08-03",
        summary: "这是一篇测试",
        tags: ["AI", "入门"],
        draft: false,
      },
      "test-post",
    );
    expect(result?.title).toBe("测试文章");
    expect(result?.date).toBe("2026-08-03");
    expect(result?.tags).toEqual(["AI", "入门"]);
    expect(result?.draft).toBe(false);
  });

  it("tags 和 draft 缺省时用默认值", () => {
    const result = parsePostFrontmatter(
      { title: "测试", date: "2026-08-03", summary: "摘要" },
      "test",
    );
    expect(result?.tags).toEqual([]);
    expect(result?.draft).toBe(false);
  });

  it("缺标题时返回 null 并告警", () => {
    expect(
      parsePostFrontmatter(
        { date: "2026-08-03", summary: "摘要" },
        "missing-title",
      ),
    ).toBeNull();
  });

  it("日期格式不对时返回 null", () => {
    expect(
      parsePostFrontmatter(
        { title: "测试", date: "2026/08/03", summary: "摘要" },
        "bad-date",
      ),
    ).toBeNull();
  });

  it("完全不是对象时返回 null", () => {
    expect(parsePostFrontmatter(null, "null-data")).toBeNull();
  });

  it("Date 对象会被归一成 YYYY-MM-DD 字符串", () => {
    const result = parsePostFrontmatter(
      {
        title: "测试",
        date: new Date("2026-08-01T00:00:00Z"),
        summary: "摘要",
      },
      "date-object",
    );
    expect(result?.date).toBe("2026-08-01");
  });
});
