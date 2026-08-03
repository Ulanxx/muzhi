import { NextResponse, type NextRequest } from "next/server";
import { isValidObjectId } from "mongoose";

import { canCurrentUserAccessCourse } from "@/app/lib/course-access";
import { canReadChapter } from "@/modules/catalog/chapters";
import { connectMongo } from "@/providers/database/mongodb/connection";
import { CourseChapterModel } from "@/providers/database/mongodb/models/learning";
import { CourseModel } from "@/providers/database/mongodb/models/series";

/**
 * 单章正文。安全核心：付费章正文必须在权限通过之后才从数据库读出。
 * - 试读章：公开内容，可直接返回（利于 SEO 与试读）。
 * - 付费章：未授权返回 403，正文一个字都不出现在响应里。
 * 存在性检查全部合并为 404，不向未授权用户泄露章节是否存在。
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ chapterId: string }> },
) {
  const { chapterId } = await context.params;
  if (!isValidObjectId(chapterId)) {
    return NextResponse.json({ error: "章节不存在" }, { status: 404 });
  }

  await connectMongo();
  const chapter = await CourseChapterModel.findById(chapterId);
  if (!chapter) {
    return NextResponse.json({ error: "章节不存在" }, { status: 404 });
  }

  const course = await CourseModel.findOne({
    _id: chapter.courseId,
    status: "published",
  });
  if (!course) {
    return NextResponse.json({ error: "章节不存在" }, { status: 404 });
  }

  if (!chapter.isPreview) {
    const hasAccess = await canCurrentUserAccessCourse(course);
    if (!canReadChapter(chapter, hasAccess)) {
      return NextResponse.json({ error: "无权阅读此章节" }, { status: 403 });
    }
  }

  return NextResponse.json(
    {
      chapterId: chapter._id.toString(),
      courseId: chapter.courseId.toString(),
      title: chapter.title,
      position: chapter.position,
      body: chapter.body,
      isPreview: chapter.isPreview,
    },
    {
      headers: {
        "Cache-Control": "private, no-store",
      },
    },
  );
}
