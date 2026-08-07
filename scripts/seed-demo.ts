import { loadEnvConfig } from "@next/env";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import mongoose from "mongoose";

import { syncConfiguredProducts } from "@/app/lib/commerce-service";
import { connectMongo } from "@/providers/database/mongodb/connection";
import { CourseChapterModel } from "@/providers/database/mongodb/models/learning";
import { CourseMaterialModel } from "@/providers/database/mongodb/models/learning";
import { MediaAssetModel } from "@/providers/database/mongodb/models/media";
import {
  CourseModel,
  SeriesModel,
} from "@/providers/database/mongodb/models/series";
import { UserModel } from "@zmzai/db";
import { getStorageProvider } from "@/providers/storage";

loadEnvConfig(process.cwd());

async function main() {
  await connectMongo();
  const owner = await UserModel.findOne({ role: "admin", status: "active" });
  if (!owner) {
    throw new Error(
      "请先运行 create-admin，再执行 seed-demo，以便为 Demo 媒体记录合法 owner。",
    );
  }

  const series = await SeriesModel.findOneAndUpdate(
    { slug: "creator-foundations" },
    {
      $set: {
        title: "创作者知识产品入门",
        description: "一套完全虚构的 Demo 系列，用于验证发布与学习闭环。",
        status: "published",
        accessLevel: "public",
      },
      $setOnInsert: {
        slug: "creator-foundations",
      },
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
    },
  );

  const demoCourses = [
    {
      slug: "public-introduction",
      title: "从一节公开课开始",
      summary: "展示无需登录即可访问的公开内容。",
      position: 0,
      accessLevel: "public",
      status: "published",
    },
    {
      slug: "member-workflow",
      title: "会员内容交付流程",
      summary: "展示全站会员权益控制的课程。",
      position: 1,
      accessLevel: "member",
      status: "published",
    },
    {
      slug: "single-course-delivery",
      title: "单课购买与交付",
      summary: "展示指定课程权益控制的内容。",
      position: 2,
      accessLevel: "course",
      status: "published",
    },
  ] as const;

  const seededCourses = [];
  for (const course of demoCourses) {
    const seededCourse = await CourseModel.findOneAndUpdate(
      { seriesId: series._id, slug: course.slug },
      {
        $set: {
          ...course,
          publishedAt: course.status === "published" ? new Date() : null,
        },
        $setOnInsert: {
          seriesId: series._id,
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
      },
    );
    seededCourses.push(seededCourse);
  }

  const publicCourse = seededCourses[0];
  const storage = getStorageProvider();
  const videoObjectKey = "demo/public-introduction.mp4";
  let videoAsset = await MediaAssetModel.findOne({ objectKey: videoObjectKey });

  if (!videoAsset || !(await storage.exists(videoObjectKey))) {
    const temporaryVideo = path.join(
      os.tmpdir(),
      `muzhi-demo-${process.pid}.mp4`,
    );
    const ffmpeg = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=30:duration=8",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        temporaryVideo,
      ],
      { stdio: "ignore" },
    );

    if (ffmpeg.status !== 0) {
      throw new Error("生成 Demo MP4 失败，请确认本机已安装 ffmpeg");
    }

    const videoData = await readFile(temporaryVideo);
    await storage.delete(videoObjectKey);
    const storedVideo = await storage.put(videoObjectKey, videoData, {
      mimeType: "video/mp4",
    });
    await unlink(temporaryVideo).catch(() => undefined);

    videoAsset = await MediaAssetModel.findOneAndUpdate(
      { objectKey: videoObjectKey },
      {
        $set: {
          ownerId: owner._id,
          kind: "video",
          status: "ready",
          provider: storage.name,
          originalName: "demo-public-introduction.mp4",
          mimeType: "video/mp4",
          size: storedVideo.size,
          checksum: storedVideo.checksum,
        },
        $setOnInsert: { objectKey: videoObjectKey },
      },
      { upsert: true, new: true, runValidators: true },
    );
  }

  if (!videoAsset) {
    throw new Error("Demo 视频资产创建失败");
  }

  for (const course of seededCourses) {
    course.videoAssetId = videoAsset._id;
    await course.save();
  }

  const materialObjectKey = "demo/public-introduction-notes.txt";
  const materialContent = new TextEncoder().encode(
    "牧之知识产品 Demo\n\n这是一份完全虚构的课程资料，用于验证安全下载链路。\n",
  );
  if (!(await storage.exists(materialObjectKey))) {
    await storage.put(materialObjectKey, materialContent, {
      mimeType: "text/plain; charset=utf-8",
    });
  }
  const materialAsset = await MediaAssetModel.findOneAndUpdate(
    { objectKey: materialObjectKey },
    {
      $set: {
        ownerId: owner._id,
        kind: "document",
        status: "ready",
        provider: storage.name,
        originalName: "课程说明.txt",
        mimeType: "text/plain; charset=utf-8",
        size: materialContent.byteLength,
        checksum: createHash("sha256").update(materialContent).digest("hex"),
      },
      $setOnInsert: { objectKey: materialObjectKey },
    },
    { upsert: true, new: true, runValidators: true },
  );

  await CourseMaterialModel.findOneAndUpdate(
    { courseId: publicCourse._id, mediaAssetId: materialAsset._id },
    {
      $set: {
        title: "Demo 课程说明",
        position: 0,
        accessLevel: "public",
      },
      $setOnInsert: {
        courseId: publicCourse._id,
        mediaAssetId: materialAsset._id,
      },
    },
    { upsert: true, new: true, runValidators: true },
  );

  // 文档课示例：独立系列 + 一门文档课 + 三章（一章试读）。
  const docSeries = await SeriesModel.findOneAndUpdate(
    { slug: "ai-playbook-series" },
    {
      $set: {
        title: "AI 实操手册",
        description: "一套按章节阅读的 AI 实操手册，先看试读再决定购买。",
        accessLevel: "course",
        status: "published",
      },
      $setOnInsert: { slug: "ai-playbook-series" },
    },
    { upsert: true, new: true, runValidators: true },
  );

  const docCourse = await CourseModel.findOneAndUpdate(
    { seriesId: docSeries._id, slug: "ai-playbook" },
    {
      $set: {
        title: "AI 实操手册（文档课）",
        summary: "一套按章节阅读的 AI 实操手册，购买后永久解锁全部章节。",
        position: 0,
        accessLevel: "course",
        contentType: "document",
        status: "published",
        publishedAt: new Date(),
      },
      $setOnInsert: {
        seriesId: docSeries._id,
        slug: "ai-playbook",
        videoAssetId: null,
      },
    },
    { upsert: true, new: true, runValidators: true },
  );

  const docChapters = [
    {
      title: "为什么 AI 工具值得学",
      position: 0,
      isPreview: true,
      body: [
        "很多人买了很多 AI 工具，却几乎没真正用起来。问题不在工具，在于没人把「第一步该做什么」讲清楚。",
        "",
        "## 这本手册讲什么",
        "",
        "这本手册不讨论模型原理，只做一件事：带你把三件最常用的事亲手做出来。每一章结束，你都有一个能运行的结果。",
        "",
        "- 第一章：把环境准备好，别怕那个黑窗口",
        "- 第二章：写出你的第一个能跑的脚本",
        "",
        "> 先试读这一章，觉得对胃口再决定购买。",
      ].join("\n"),
    },
    {
      title: "命令行基本功",
      position: 1,
      isPreview: false,
      body: [
        "几乎所有 AI 工具的本地教程，第一步都绕不开命令行。这一章把它讲到你能跟着任何教程走。",
        "",
        "## 五个命令就够",
        "",
        "- `pwd` 看当前位置",
        "- `ls` 看目录内容",
        "- `cd` 进入目录",
        "- `mkdir` 新建目录",
        "- `clear` 清空屏幕",
        "",
        "把这五个练熟，90% 的入门教程你都能跟下来。",
      ].join("\n"),
    },
    {
      title: "你的第一个 AI 脚本",
      position: 2,
      isPreview: false,
      body: [
        "这一章我们写一个真正能跑的脚本：读取一段文字，调用模型，把结果存到文件。",
        "",
        "```",
        "echo \"hello ai\" > input.txt",
        "node run.js input.txt",
        "```",
        "",
        "跑通之后，你就跨过了从「看教程」到「自己做」的那条线。",
      ].join("\n"),
    },
  ] as const;

  for (const chapter of docChapters) {
    await CourseChapterModel.findOneAndUpdate(
      { courseId: docCourse._id, position: chapter.position },
      {
        $set: {
          title: chapter.title,
          body: chapter.body,
          isPreview: chapter.isPreview,
        },
        $setOnInsert: {
          courseId: docCourse._id,
          position: chapter.position,
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
  }

  // 商品同步放在所有课程建完之后，避免新商品的目标课程还不存在时被下架。
  const productSync = await syncConfiguredProducts();

  console.log(
    `Demo 数据已就绪：2 个系列，${demoCourses.length + 1} 节课程（含 1 门文档课、${docChapters.length} 章），1 个视频，1 份资料，${productSync.synced} 个商品`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
