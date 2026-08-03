export interface ChapterLike {
  position: number;
  isPreview: boolean;
}

/** 按 position 升序排序章节，position 相同保持稳定。 */
export function sortChapters<T extends ChapterLike>(
  chapters: readonly T[],
): T[] {
  return [...chapters].sort((a, b) => a.position - b.position);
}

/**
 * 判断某章正文是否可以对当前用户直接渲染。
 * 试读章永远公开；付费章只有 hasAccess 为 true 时才可读。
 * 这是「付费章零泄漏」的单一判定入口，阅读页和章节 API 都走这里。
 */
export function canReadChapter(
  chapter: ChapterLike,
  hasAccess: boolean,
): boolean {
  return chapter.isPreview || hasAccess;
}

/** 已读章节数达到总章节数即视为整课完成。 */
export function isDocumentCourseComplete(
  totalChapters: number,
  readChapterIds: readonly string[],
): boolean {
  if (totalChapters <= 0) {
    return false;
  }
  return readChapterIds.length >= totalChapters;
}

/** 把某章加入已读列表并去重，返回新数组。 */
export function markChapterRead(
  readChapterIds: readonly string[],
  chapterId: string,
): string[] {
  if (readChapterIds.includes(chapterId)) {
    return [...readChapterIds];
  }
  return [...readChapterIds, chapterId];
}
