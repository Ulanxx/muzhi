import type { Metadata } from "next";
import Link from "next/link";

import { SiteHeader } from "@/components/site-header";
import { getSiteConfig } from "@/config/site.config";
import { listPosts } from "@/modules/blog";

export const metadata: Metadata = {
  title: "博客",
  description: "免费免登的 AI 实操文章，写给想真正用起来的人。",
};

export default async function BlogIndexPage() {
  const site = getSiteConfig();
  const posts = await listPosts();

  return (
    <>
      <SiteHeader site={site} />
      <main className="page-shell py-16 lg:py-20">
        <p className="eyebrow text-[var(--muted)]">免费 · 免登录</p>
        <h1 className="headline mt-6 text-[clamp(3rem,9vw,7rem)]">博客</h1>
        <p className="mt-8 max-w-[38rem] border-t-2 border-[var(--rule)] pt-6 text-xl leading-9">
          写给想把 AI 真正用起来的人。全部免费，不用注册。
        </p>

        {posts.length === 0 ? (
          <p className="mt-16 border-t border-[var(--line)] pt-8 text-lg text-[var(--muted)]">
            还没有发布文章。
          </p>
        ) : (
          <ol className="mt-16">
            {posts.map((post, index) => (
              <li key={post.slug}>
                <Link
                  className="focus-ring group grid gap-4 border-t border-[var(--line)] py-8 transition-colors hover:bg-[var(--surface)] sm:grid-cols-[4rem_1fr_auto] sm:items-baseline sm:gap-8"
                  href={`/blog/${post.slug}`}
                >
                  <span className="font-mono text-2xl font-black text-[var(--muted)] tabular-nums">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <span className="block text-2xl font-bold tracking-[-0.02em] group-hover:underline sm:text-3xl">
                      {post.title}
                    </span>
                    <span className="mt-3 block max-w-[42rem] leading-7 text-[var(--muted)]">
                      {post.summary}
                    </span>
                    {post.tags.length > 0 ? (
                      <span className="mt-3 flex flex-wrap gap-2">
                        {post.tags.map((tag) => (
                          <span
                            className="eyebrow bg-[var(--surface-strong)] px-2 py-1"
                            key={tag}
                          >
                            {tag}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </span>
                  <time className="eyebrow whitespace-nowrap text-[var(--muted)]">
                    {post.date}
                  </time>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </main>
    </>
  );
}
