import Link from "next/link";
import type { Types } from "mongoose";

import { Logo } from "@zmzai/theme";

import { SiteHeader } from "@/components/site-header";
import { CountUp } from "@/components/count-up";
import { RollingWord } from "@/components/rolling-word";
import { productsConfig } from "@/config/products.config";
import { getSiteConfig } from "@/config/site.config";
import { listRecentPosts } from "@/modules/blog";
import { connectMongo } from "@/providers/database/mongodb/connection";
import {
  CourseModel,
  type CourseRecord,
  SeriesModel,
} from "@/providers/database/mongodb/models/series";

export const dynamic = "force-dynamic";

const accessLabel: Record<string, string> = {
  public: "免费试看",
  registered: "登录可看",
  member: "会员专享",
  course: "单课购买",
  series: "系列购买",
};

export default async function HomePage() {
  const site = getSiteConfig();

  let courses: Array<CourseRecord & { _id: Types.ObjectId }> = [];
  try {
    await connectMongo();
    const series = await SeriesModel.find({ status: "published" })
      .sort({ createdAt: -1 })
      .lean();
    if (series.length > 0) {
      courses = await CourseModel.find({
        seriesId: { $in: series.map((item) => item._id) },
        status: "published",
      })
        .sort({ position: 1 })
        .limit(3)
        .lean();
    }
  } catch {
    courses = [];
  }

  const recentPosts = await listRecentPosts(3).catch(() => []);

  return (
    <>
      <SiteHeader site={site} />
      <main>
        {/* 头版：超大标题压满版心；eyebrow + 副文案第一句 + 右栏「形式」
            三处同时点明「这是牧之的付费 AI 视频课」，解决「不知道干啥」 */}
        <section className="page-shell pb-24 pt-20 lg:pb-32 lg:pt-28">
          <p className="eyebrow text-[var(--muted)] hero-rise d1">
            牧之主讲 · AI 实操视频课
          </p>

          <h1 className="headline mt-8 text-[clamp(3.5rem,11vw,10rem)] hero-rise d2">
            从零开始
            <br />
            把{" "}
            <span className="ai-glow inline-block bg-[var(--accent)] px-3 text-[var(--accent-ink)]">
              AI
            </span>{" "}
            <RollingWord />
          </h1>

          <div className="mt-16 grid gap-12 border-t-2 border-[var(--rule)] pt-12 lg:grid-cols-[1.15fr_0.85fr] lg:gap-20">
            <div>
              <p className="max-w-[40rem] text-lg leading-8 sm:text-xl sm:leading-9 hero-rise d3">
                这是一套给零基础同学的在线 AI 课程：不堆概念、不考理论，跟着视频一节一节做，结课你手里就多一个能用的东西。
              </p>
              <div className="mt-10 flex flex-wrap items-center gap-5 hero-rise d4">
                <Link
                  className="focus-ring bg-[var(--ink)] px-8 py-4 text-base font-bold text-[var(--page)] transition-[transform,colors] hover:-translate-y-0.5 hover:bg-[var(--muted)]"
                  href="/courses"
                >
                  免费试看课程
                </Link>
                <Link
                  className="focus-ring border-b-2 border-[var(--ink)] pb-1 text-base font-bold"
                  href="/pricing"
                >
                  了解会员方案
                </Link>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-y-8 self-start border-l-0 lg:border-l lg:border-[var(--line)] lg:pl-10 hero-rise d5">
              <div className="col-span-2">
                <dt className="eyebrow text-[var(--muted)]">形式</dt>
                <dd className="mt-2 leading-7">
                  视频课 + 跟练，随时回看
                </dd>
              </div>
              <div>
                <dt className="eyebrow text-[var(--muted)]">课程数</dt>
                <dd className="mt-2 text-4xl font-black tabular-nums">
                  <CountUp value={courses.length} delay={700} />
                </dd>
              </div>
              <div>
                <dt className="eyebrow text-[var(--muted)]">付费方式</dt>
                <dd className="mt-2 text-4xl font-black tabular-nums">
                  <CountUp value={productsConfig.length} delay={700} />
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="eyebrow text-[var(--muted)]">适合谁</dt>
                <dd className="mt-2 leading-7">
                  没写过代码、被 AI 工具劝退过、想真正用起来的人。
                </dd>
              </div>
            </dl>
          </div>
        </section>

        {/* 课程：文章式条目，大编号 + 标题 + 导读，不用圆角卡片 */}
        <section className="rule-top bg-[var(--surface)] py-20" id="courses">
          <div className="page-shell">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <h2 className="headline text-[clamp(2.5rem,6vw,5rem)]">课程</h2>
              <Link
                className="focus-ring border-b-2 border-[var(--ink)] pb-1 text-sm font-bold"
                href="/courses"
              >
                查看全部
              </Link>
            </div>

            {courses.length === 0 ? (
              <p className="mt-12 border-t border-[var(--line)] pt-8 text-lg text-[var(--muted)]">
                还没有已发布的课程。
              </p>
            ) : (
              <ol className="mt-12">
                {courses.map((course, index) => (
                  <li key={course._id.toString()}>
                    <Link
                      className="focus-ring group grid gap-4 border-t border-[var(--line)] py-8 transition-colors hover:bg-[var(--page)] sm:grid-cols-[5rem_1fr_auto] sm:items-baseline sm:gap-8"
                      href={`/learn/${course._id.toString()}`}
                    >
                      <span className="font-mono text-3xl font-black text-[var(--muted)] tabular-nums">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span>
                        <span className="block text-2xl font-bold tracking-[-0.02em] group-hover:underline sm:text-3xl">
                          {course.title}
                        </span>
                        <span className="mt-3 block max-w-[42rem] leading-7 text-[var(--muted)]">
                          {course.summary}
                        </span>
                      </span>
                      <span className="eyebrow whitespace-nowrap bg-[var(--accent)] px-2.5 py-1.5 text-[var(--accent-ink)]">
                        {accessLabel[course.accessLevel] ?? course.accessLevel}
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>

        {/* 价格：两条编辑式条目，不用对比表 */}
        <section className="rule-top py-20" id="pricing">
          <div className="page-shell">
            <h2 className="headline text-[clamp(2.5rem,6vw,5rem)]">
              两种买法
            </h2>
            <p className="mt-6 max-w-[38rem] text-lg leading-8 text-[var(--muted)]">
              按年订阅解锁全部内容，或者只买你想看的那一门。买了就是你的。
            </p>

            <div className="mt-14 grid gap-px bg-[var(--line)] sm:grid-cols-2">
              {productsConfig.map((product, index) => (
                <article
                  className={
                    index === 0
                      ? "flex flex-col bg-[var(--accent)] p-8 sm:p-10"
                      : "flex flex-col bg-[var(--page)] p-8 sm:p-10"
                  }
                  key={product.id}
                >
                  <p className="eyebrow opacity-70">
                    {String(index + 1).padStart(2, "0")}
                  </p>
                  <h3 className="mt-6 text-3xl font-black tracking-[-0.03em] sm:text-4xl">
                    {product.title}
                  </h3>
                  <p className="mt-4 max-w-[26rem] flex-1 leading-7 opacity-80">
                    {product.description}
                  </p>
                  <Link
                    className="focus-ring mt-10 self-start border-b-2 border-current pb-1 text-base font-bold"
                    href="/pricing"
                  >
                    去购买
                  </Link>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* 最新文章：免费内容承上启下 */}
        {recentPosts.length > 0 ? (
          <section className="rule-top bg-[var(--surface)] py-20" id="blog">
            <div className="page-shell">
              <div className="flex flex-wrap items-end justify-between gap-6">
                <h2 className="headline text-[clamp(2.5rem,6vw,5rem)]">
                  最新文章
                </h2>
                <Link
                  className="focus-ring border-b-2 border-[var(--ink)] pb-1 text-sm font-bold"
                  href="/blog"
                >
                  全部文章
                </Link>
              </div>

              <ol className="mt-12 grid gap-px bg-[var(--line)] sm:grid-cols-3">
                {recentPosts.map((post) => (
                  <li key={post.slug}>
                    <Link
                      className="focus-ring group flex h-full flex-col bg-[var(--page)] p-7 transition-colors hover:bg-[var(--accent)]"
                      href={`/blog/${post.slug}`}
                    >
                      <time className="eyebrow text-[var(--muted)]">
                        {post.date}
                      </time>
                      <span className="mt-4 block text-xl font-bold leading-snug tracking-[-0.01em] group-hover:underline">
                        {post.title}
                      </span>
                      <span className="mt-3 block flex-1 leading-7 text-[var(--muted)]">
                        {post.summary}
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        ) : null}
      </main>

      <footer className="rule-top py-10">
        <div className="page-shell flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-3">
            <Logo size={40} />
            <p className="font-mono text-xs text-[var(--muted)]">
              {site.name}
              <br />
              zmzai.cloud · 牧之 署名
            </p>
          </div>
          <p className="font-mono text-xs text-[var(--muted)] sm:text-right">
            作者在场。不自托管即不署名。
            <br />
            Apache-2.0 · {new Date().getFullYear()}
          </p>
        </div>
      </footer>
    </>
  );
}
