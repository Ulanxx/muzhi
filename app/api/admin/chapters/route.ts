import { NextResponse, type NextRequest } from "next/server";
import { isValidObjectId } from "mongoose";
import { z } from "zod";

import { authorizeAdminMutation } from "@/app/lib/admin-api";
import { connectMongo } from "@/providers/database/mongodb/connection";
import { CourseChapterModel } from "@/providers/database/mongodb/models/learning";
import { CourseModel } from "@/providers/database/mongodb/models/series";

const chapterInput = z.object({
  courseId: z.string().refine(isValidObjectId),
  title: z.string().trim().min(1).max(200),
  position: z.number().int().min(0).max(10_000),
  body: z.string().max(200_000).default(""),
  isPreview: z.boolean().default(false),
});

export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminMutation(request);
  if (!authorization.ok) {
    return authorization.response;
  }

  const parsed = chapterInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "章节数据格式错误" }, { status: 400 });
  }

  await connectMongo();
  const course = await CourseModel.findById(parsed.data.courseId);
  if (!course) {
    return NextResponse.json({ error: "课时不存在" }, { status: 404 });
  }
  if (course.contentType !== "document") {
    return NextResponse.json(
      { error: "只有文档课可以添加章节" },
      { status: 400 },
    );
  }

  const chapter = await CourseChapterModel.create(parsed.data);

  return NextResponse.json(
    {
      chapter: {
        id: chapter._id.toString(),
        title: chapter.title,
        position: chapter.position,
        isPreview: chapter.isPreview,
      },
    },
    { status: 201 },
  );
}
