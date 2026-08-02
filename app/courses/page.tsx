import type { Metadata } from "next";
import Link from "next/link";
import type { Types } from "mongoose";

import { SiteHeader } from "@/components/site-header";
import { getSiteConfig } from "@/config/site.config";
import { connectMongo } from "@/providers/database/mongodb/connection";
import {
  CourseModel,
  type SeriesRecord,
  SeriesModel,
} from "@/providers/database/mongodb/models/series";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "课程",
};

const accessLabel: Record<string, string> = {
  public: "免费试看",
  registered: "登录可看",
  member: "会员专享",
  course: "单课购买",
  series: "系列购买",
};

export default async function CoursesPage() {
  const site = getSiteConfig();
  let series: Array<SeriesRecord & { _id: Types.ObjectId }> = [];

  try {
    await connectMongo();
    series = await SeriesModel.find({ status: "published" })
      .sort({ createdAt: -1 })
      .lean();
  } catch {
    series = [];
  }

  const entries = await Promise.all(
    series.map(async (item) => ({
      series: item,
      courses: await CourseModel.find({
        seriesId: item._id,
        status: "published",
      })
        .sort({ position: 1 })
        .lean(),
    })),
  );

  return (
    <>
      <SiteHeader site={site} />
      <main className="page-shell py-16 lg:py-20">
        <p className="eyebrow text-[var(--muted)]">全部内容</p>
        <h1 className="headline mt-6 text-[clamp(3rem,9vw,7rem)]">课程</h1>
        <p className="mt-8 max-w-[38rem] border-t-2 border-[var(--rule)] pt-6 text-xl leading-9">
          先从免费内容看起，需要时再用会员或单课解锁后面的部分。
        </p>

        {entries.length === 0 ? (
          <p className="mt-16 border-t border-[var(--line)] pt-8 text-lg text-[var(--muted)]">
            还没有已发布课程。运行 `npm run seed-demo` 可创建示例内容。
          </p>
        ) : (
          <div className="mt-16 space-y-20">
            {entries.map(({ series: item, courses }, seriesIndex) => (
              <section key={item._id.toString()}>
                <div className="flex items-baseline gap-6">
                  <span className="eyebrow text-[var(--muted)]">
                    {String(seriesIndex + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <h2 className="text-4xl font-black tracking-[-0.03em] sm:text-5xl">
                      {item.title}
                    </h2>
                    <p className="mt-4 max-w-[42rem] leading-7 text-[var(--muted)]">
                      {item.description}
                    </p>
                  </div>
                </div>

                <ol className="mt-10">
                  {courses.map((course, index) => (
                    <li key={course._id.toString()}>
                      <Link
                        className="focus-ring group grid gap-4 border-t border-[var(--line)] py-7 transition-colors hover:bg-[var(--surface)] sm:grid-cols-[4rem_1fr_auto] sm:items-baseline sm:gap-8"
                        href={`/learn/${course._id.toString()}`}
                      >
                        <span className="font-mono text-2xl font-black text-[var(--muted)] tabular-nums">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span>
                          <span className="block text-xl font-bold tracking-[-0.02em] group-hover:underline sm:text-2xl">
                            {course.title}
                          </span>
                          <span className="mt-2 block max-w-[42rem] leading-7 text-[var(--muted)]">
                            {course.summary}
                          </span>
                        </span>
                        <span className="eyebrow whitespace-nowrap bg-[var(--accent)] px-2.5 py-1.5 text-[var(--accent-ink)]">
                          {accessLabel[course.accessLevel] ??
                            course.accessLevel}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
