import { describe, expect, it } from "vitest";

import {
  canReadChapter,
  isDocumentCourseComplete,
  markChapterRead,
  sortChapters,
} from "@/modules/catalog/chapters";

describe("sortChapters", () => {
  it("按 position 升序", () => {
    const sorted = sortChapters([
      { position: 2, isPreview: false, id: "c" },
      { position: 0, isPreview: true, id: "a" },
      { position: 1, isPreview: false, id: "b" },
    ]);
    expect(sorted.map((c) => c.position)).toEqual([0, 1, 2]);
  });
});

describe("canReadChapter", () => {
  it("试读章对未授权用户也公开", () => {
    expect(canReadChapter({ position: 0, isPreview: true }, false)).toBe(true);
  });

  it("付费章对未授权用户不可读", () => {
    expect(canReadChapter({ position: 1, isPreview: false }, false)).toBe(
      false,
    );
  });

  it("付费章对已授权用户可读", () => {
    expect(canReadChapter({ position: 1, isPreview: false }, true)).toBe(true);
  });
});

describe("isDocumentCourseComplete", () => {
  it("读完全部章节才完成", () => {
    expect(isDocumentCourseComplete(3, ["a", "b", "c"])).toBe(true);
    expect(isDocumentCourseComplete(3, ["a", "b"])).toBe(false);
  });

  it("零章节不算完成", () => {
    expect(isDocumentCourseComplete(0, [])).toBe(false);
  });
});

describe("markChapterRead", () => {
  it("新增章节", () => {
    expect(markChapterRead(["a"], "b")).toEqual(["a", "b"]);
  });

  it("重复标记不重复计数", () => {
    expect(markChapterRead(["a", "b"], "a")).toEqual(["a", "b"]);
  });
});
