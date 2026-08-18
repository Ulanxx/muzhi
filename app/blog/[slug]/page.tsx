import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SiteHeader } from "@/components/site-header";
import { getSiteConfig } from "@/config/site.config";
import { listPosts } from "@/modules/blog";

interface BlogPostPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  const posts = await listPosts();
  return posts.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: BlogPostPageProps): Promise<Metadata> {
  const { slug } = await params;
  const posts = await listPosts();
  const post = posts.find((item) => item.slug === slug);
  if (!post) {
    return {};
  }
  return {
    title: post.title,
    description: post.summary,
    openGraph: {
      title: post.title,
      description: post.summary,
      type: "article",
      publishedTime: post.date,
    },
  };
}

export default async function BlogPostPage({ params }: BlogPostPageProps) {
  const site = getSiteConfig();
  const { slug } = await params;
  const posts = await listPosts();
  const postIndex = posts.findIndex((item) => item.slug === slug);
  const post = posts[postIndex];

  if (!post) {
    notFound();
  }

  const { default: PostContent } = await import(
    `@/content/blog/${slug}.mdx`
  );

  const newer = postIndex > 0 ? posts[postIndex - 1] : null;
  const older = postIndex < posts.length - 1 ? posts[postIndex + 1] : null;

  return (
    <>
      <SiteHeader site={site} />
      <main className="page-shell max-w-[46rem] py-16 lg:py-20">
        <Link
          className="eyebrow text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
          href="/blog"
        >
          ← 返回博客
        </Link>

        <article className="mt-10">
          <div className="flex flex-wrap items-center gap-4">
            <time className="eyebrow text-[var(--muted)]">{post.date}</time>
            {post.tags.map((tag) => (
              <span
                className="eyebrow bg-[var(--accent)] px-2 py-1 text-[var(--accent-ink)]"
                key={tag}
              >
                {tag}
              </span>
            ))}
          </div>

          <h1 className="mt-6 text-4xl font-black leading-tight tracking-[-0.03em] sm:text-5xl">
            {post.title}
          </h1>
          <p className="mt-6 border-t-2 border-[var(--rule)] pt-6 text-xl leading-9 text-[var(--muted)]">
            {post.summary}
          </p>

          <div className="mt-12">
            <PostContent />
          </div>
        </article>

        <nav className="mt-20 grid gap-px border-t-2 border-[var(--rule)] pt-8 sm:grid-cols-2">
          {older ? (
            <Link
              className="focus-ring group py-4"
              href={`/blog/${older.slug}`}
            >
              <span className="eyebrow text-[var(--muted)]">上一篇</span>
              <span className="mt-2 block font-bold group-hover:underline">
                {older.title}
              </span>
            </Link>
          ) : (
            <span />
          )}
          {newer ? (
            <Link
              className="focus-ring group py-4 sm:text-right"
              href={`/blog/${newer.slug}`}
            >
              <span className="eyebrow text-[var(--muted)]">下一篇</span>
              <span className="mt-2 block font-bold group-hover:underline">
                {newer.title}
              </span>
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </main>
    </>
  );
}
