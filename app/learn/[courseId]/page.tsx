import Link from "next/link";
import { isValidObjectId } from "mongoose";
import { notFound } from "next/navigation";

import { canCurrentUserAccessCourse } from "@/app/lib/course-access";
import { DocumentReader } from "@/components/document-reader";
import { SiteHeader } from "@/components/site-header";
import { VideoPlayer } from "@/components/video-player";
import { sortChapters } from "@/modules/catalog/chapters";
import { getSiteConfig } from "@/config/site.config";
import { getFeaturesConfig } from "@/config/features.config";
import { getPaymentProvider } from "@/providers/payment";
import { getCurrentUser } from "@/providers/auth/session";
import { connectMongo } from "@/providers/database/mongodb/connection";
import { ProductModel } from "@/providers/database/mongodb/models/commerce";
import {
  CourseChapterModel,
  CourseMaterialModel,
} from "@/providers/database/mongodb/models/learning";
import { MediaAssetModel } from "@/providers/database/mongodb/models/media";
import {
  CourseModel,
  SeriesModel,
} from "@/providers/database/mongodb/models/series";

export const dynamic = "force-dynamic";

export default async function LearnPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  if (!isValidObjectId(courseId)) {
    notFound();
  }

  await connectMongo();
  const course = await CourseModel.findOne({
    _id: courseId,
    status: "published",
  });
  if (!course) {
    notFound();
  }

  const [series, materials, allowed] = await Promise.all([
    SeriesModel.findById(course.seriesId).lean(),
    CourseMaterialModel.find({ courseId: course._id })
      .sort({ position: 1 })
      .lean(),
    canCurrentUserAccessCourse(course),
  ]);

  const asset = course.videoAssetId
    ? await MediaAssetModel.findById(course.videoAssetId).lean()
    : null;
  const site = getSiteConfig();
  const isDocument = course.contentType === "document";

  // 文档课：取章节元数据 + 仅试读章正文（付费章正文绝不进 SSR）。
  let chapters: Array<{
    chapterId: string;
    title: string;
    position: number;
    isPreview: boolean;
  }> = [];
  const previewBodies: Record<string, string> = {};
  let lockedProduct: {
    id: string;
    title: string;
    description: string;
    amountInMinorUnits: number;
    currency: "CNY";
    entitlementType: string;
    durationDays: number | null;
  } | null = null;
  let signedIn = false;
  let paymentMethods: string[] = [];

  if (isDocument) {
    const rawChapters = await CourseChapterModel.find({
      courseId: course._id,
    }).lean();
    const sorted = sortChapters(rawChapters);
    chapters = sorted.map((chapter) => ({
      chapterId: chapter._id.toString(),
      title: chapter.title,
      position: chapter.position,
      isPreview: chapter.isPreview,
    }));
    // 只把试读章正文放进页面。付费章正文由客户端向鉴权 API 拉取。
    for (const chapter of sorted) {
      if (chapter.isPreview) {
        previewBodies[chapter._id.toString()] = chapter.body;
      }
    }

    // 付费墙内嵌购买：找到指向本课程的单课商品。
    const user = await getCurrentUser().catch(() => null);
    signedIn = user !== null;
    paymentMethods = [...getPaymentProvider().supportedMethods];
    const features = getFeaturesConfig();
    if (features.singleCoursePurchase) {
      const product = await ProductModel.findOne({
        entitlementType: "course",
        entitlementTargetId: course._id.toString(),
        active: true,
      }).lean();
      if (product) {
        lockedProduct = {
          id: product.sku,
          title: product.title,
          description: product.description,
          amountInMinorUnits: product.amountInMinorUnits,
          currency: product.currency,
          entitlementType: product.entitlementType,
          durationDays: product.entitlementDurationDays,
        };
      }
    }
  }

  return (
    <>
      <SiteHeader site={site} />
      <main className="page-shell py-12">
        <Link
          className="focus-ring rounded-md text-sm text-[var(--muted)] hover:text-[var(--ink)]"
          href="/courses"
        >
          返回课程
        </Link>

        <div
          className={
            isDocument
              ? "mt-6"
              : "mt-6 grid gap-10 lg:grid-cols-[1fr_20rem]"
          }
        >
          <article>
            <p className="font-mono text-xs text-[var(--accent-readable)]">
              {series?.title ?? "课程"}
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">
              {course.title}
            </h1>
            <p className="mt-4 max-w-3xl leading-7 text-[var(--muted)]">
              {course.summary}
            </p>

            <div className="mt-9">
              {isDocument ? (
                <DocumentReader
                  chapters={chapters}
                  courseId={course._id.toString()}
                  hasAccess={allowed}
                  lockedProductId={lockedProduct?.id ?? null}
                  paymentMethods={paymentMethods}
                  previewBodies={previewBodies}
                  products={lockedProduct ? [lockedProduct] : []}
                  signedIn={signedIn}
                />
              ) : !allowed ? (
                <div className="surface p-8">
                  <h2 className="text-xl font-semibold">这节课需要有效权益</h2>
                  <p className="mt-2 text-[var(--muted)]">
                    登录后系统会检查全站会员或单课购买记录。
                  </p>
                  <Link
                    className="focus-ring mt-5 inline-block rounded-lg bg-[var(--accent)] px-4 py-2.5 font-semibold text-[var(--accent-ink)]"
                    href={`/login?next=/learn/${courseId}`}
                  >
                    登录
                  </Link>
                </div>
              ) : asset?.status === "ready" ? (
                <VideoPlayer
                  assetId={asset._id.toString()}
                  courseId={course._id.toString()}
                  title={course.title}
                />
              ) : (
                <div className="surface p-8">
                  <h2 className="text-xl font-semibold">视频尚未就绪</h2>
                  <p className="mt-2 text-[var(--muted)]">
                    发布前媒体校验会阻止缺少视频文件的课程上线。
                  </p>
                </div>
              )}
            </div>
          </article>

          {!isDocument ? (
            <aside>
              <div className="surface p-5">
                <h2 className="font-semibold">课程资料</h2>
                {!allowed ? (
                  <p className="mt-3 text-sm text-[var(--muted)]">
                    获得课程权益后显示资料。
                  </p>
                ) : materials.length === 0 ? (
                  <p className="mt-3 text-sm text-[var(--muted)]">暂无资料</p>
                ) : (
                  <div className="mt-4 grid gap-2">
                    {materials.map((material) => (
                      <a
                        className="focus-ring rounded-lg border border-[var(--line)] bg-[var(--page)] px-4 py-3 text-sm font-medium hover:border-[var(--accent)]"
                        href={`/api/materials/${material._id.toString()}/download`}
                        key={material._id.toString()}
                      >
                        {material.title}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </aside>
          ) : null}
        </div>
      </main>
    </>
  );
}
