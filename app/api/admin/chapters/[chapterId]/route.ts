import { NextResponse, type NextRequest } from "next/server";
import { isValidObjectId } from "mongoose";
import { z } from "zod";

import { authorizeAdminMutation } from "@/app/lib/admin-api";
import { connectMongo } from "@/providers/database/mongodb/connection";
import { CourseChapterModel } from "@/providers/database/mongodb/models/learning";

const chapterPatch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  body: z.string().max(200_000).optional(),
  isPreview: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ chapterId: string }> },
) {
  const authorization = await authorizeAdminMutation(request);
  if (!authorization.ok) {
    return authorization.response;
  }

  const { chapterId } = await context.params;
  if (!isValidObjectId(chapterId)) {
    return NextResponse.json({ error: "章节不存在" }, { status: 404 });
  }

  const parsed = chapterPatch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "章节数据格式错误" }, { status: 400 });
  }

  await connectMongo();
  const chapter = await CourseChapterModel.findByIdAndUpdate(
    chapterId,
    { $set: parsed.data },
    { new: true, runValidators: true },
  );
  if (!chapter) {
    return NextResponse.json({ error: "章节不存在" }, { status: 404 });
  }

  return NextResponse.json({
    chapter: {
      id: chapter._id.toString(),
      title: chapter.title,
      position: chapter.position,
      isPreview: chapter.isPreview,
    },
  });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ chapterId: string }> },
) {
  const authorization = await authorizeAdminMutation(request);
  if (!authorization.ok) {
    return authorization.response;
  }

  const { chapterId } = await context.params;
  if (!isValidObjectId(chapterId)) {
    return NextResponse.json({ error: "章节不存在" }, { status: 404 });
  }

  await connectMongo();
  const result = await CourseChapterModel.findByIdAndDelete(chapterId);
  if (!result) {
    return NextResponse.json({ error: "章节不存在" }, { status: 404 });
  }

  return NextResponse.json({ deleted: true });
}
