"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CheckoutPanel } from "@/components/checkout-panel";

interface ChapterMeta {
  chapterId: string;
  title: string;
  position: number;
  isPreview: boolean;
}

interface ProductView {
  id: string;
  title: string;
  description: string;
  amountInMinorUnits: number;
  currency: "CNY";
  entitlementType: string;
  durationDays: number | null;
}

/**
 * 文档课阅读器。试读章正文由服务端随页面注入（公开内容，利于 SEO）；
 * 付费章正文在客户端按需向鉴权 API 拉取——未授权得到 403，渲染付费墙，
 * 正文一个字都不会提前出现在页面里。
 */
export function DocumentReader({
  courseId,
  chapters,
  previewBodies,
  hasAccess,
  signedIn,
  products,
  paymentMethods,
  lockedProductId,
}: {
  courseId: string;
  chapters: ChapterMeta[];
  /** 仅试读章的正文，键为 chapterId。付费章正文永远不在其中。 */
  previewBodies: Record<string, string>;
  hasAccess: boolean;
  signedIn: boolean;
  products: ProductView[];
  paymentMethods: string[];
  lockedProductId: string | null;
}) {
  const router = useRouter();
  const [activeId, setActiveId] = useState(chapters[0]?.chapterId ?? "");
  const [bodyCache, setBodyCache] = useState<Record<string, string>>({});
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState(false);

  const active = useMemo(
    () => chapters.find((chapter) => chapter.chapterId === activeId),
    [chapters, activeId],
  );

  const activeBody = active
    ? (previewBodies[active.chapterId] ?? bodyCache[active.chapterId] ?? null)
    : null;

  const markRead = useCallback(
    (chapterId: string) => {
      if (!signedIn || readIds.has(chapterId)) {
        return;
      }
      setReadIds((prev) => new Set(prev).add(chapterId));
      void fetch(`/api/courses/${courseId}/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chapterId, read: true }),
      }).catch(() => undefined);
    },
    [courseId, readIds, signedIn],
  );

  useEffect(() => {
    if (!active) {
      return;
    }
    // 试读章正文已在 SSR 注入，直接标记已读。
    if (active.isPreview) {
      markRead(active.chapterId);
      return;
    }
    // 已授权但正文未缓存：向鉴权 API 拉取。
    if (hasAccess && !bodyCache[active.chapterId]) {
      setLoading(true);
      setDenied(false);
      void fetch(`/api/chapters/${active.chapterId}`, { cache: "no-store" })
        .then(async (response) => {
          if (response.status === 403) {
            setDenied(true);
            return;
          }
          if (!response.ok) {
            return;
          }
          const payload = (await response.json()) as { body: string };
          setBodyCache((prev) => ({
            ...prev,
            [active.chapterId]: payload.body,
          }));
          markRead(active.chapterId);
        })
        .catch(() => undefined)
        .finally(() => setLoading(false));
      return;
    }
    // 未授权点进付费章：显示付费墙。
    if (!hasAccess) {
      setDenied(true);
    }
  }, [active, hasAccess, bodyCache, markRead]);

  function selectChapter(chapterId: string) {
    setActiveId(chapterId);
    setDenied(false);
  }

  const activeIndex = chapters.findIndex((c) => c.chapterId === activeId);
  const previous = activeIndex > 0 ? chapters[activeIndex - 1] : null;
  const next =
    activeIndex < chapters.length - 1 ? chapters[activeIndex + 1] : null;

  return (
    <div className="mt-9 grid gap-10 lg:grid-cols-[16rem_1fr]">
      {/* 章节目录 */}
      <nav aria-label="章节目录" className="lg:sticky lg:top-24 lg:self-start">
        <p className="eyebrow text-[var(--muted)]">目录</p>
        <ol className="mt-4 border-t border-[var(--line)]">
          {chapters.map((chapter, index) => {
            const isActive = chapter.chapterId === activeId;
            const isRead = readIds.has(chapter.chapterId);
            return (
              <li key={chapter.chapterId}>
                <button
                  className={`focus-ring flex w-full items-baseline gap-3 border-b border-[var(--line)] px-2 py-3 text-left transition-colors ${
                    isActive
                      ? "bg-[var(--accent)] font-bold text-[var(--accent-ink)]"
                      : "hover:bg-[var(--surface)]"
                  }`}
                  onClick={() => selectChapter(chapter.chapterId)}
                  type="button"
                >
                  <span className="font-mono text-xs tabular-nums">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="flex-1 text-sm leading-5">
                    {chapter.title}
                  </span>
                  {chapter.isPreview ? (
                    <span className="eyebrow whitespace-nowrap text-[var(--accent-readable)]">
                      试读
                    </span>
                  ) : null}
                  {isRead ? (
                    <span aria-label="已读" className="text-xs">
                      ✓
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {/* 当前章正文 / 付费墙 */}
      <article>
        {active ? (
          <>
            <h2 className="text-3xl font-black tracking-[-0.02em]">
              {active.title}
            </h2>

            {denied && !hasAccess ? (
              <div className="mt-8 border-t-2 border-[var(--rule)] pt-8">
                <p className="eyebrow text-[var(--accent-readable)]">付费内容</p>
                <h3 className="mt-4 text-2xl font-bold">
                  这一章需要购买后才能阅读
                </h3>
                <p className="mt-3 max-w-[32rem] leading-7 text-[var(--muted)]">
                  试读内容到此为止。购买本课程即可解锁全部 {chapters.length}{" "}
                  章，并同步保存你的阅读进度。
                </p>
                {lockedProductId ? (
                  <div className="mt-4 max-w-[36rem]">
                    <CheckoutPanel
                      lockedProductId={lockedProductId}
                      onFulfilled={() => router.refresh()}
                      paymentMethods={paymentMethods}
                      products={products}
                      signedIn={signedIn}
                    />
                  </div>
                ) : (
                  <a
                    className="focus-ring mt-6 inline-block bg-[var(--ink)] px-6 py-3 font-bold text-[var(--page)]"
                    href="/pricing"
                  >
                    去购买
                  </a>
                )}
              </div>
            ) : loading ? (
              <p className="mt-8 text-[var(--muted)]">正在加载正文…</p>
            ) : activeBody !== null ? (
              <div className="mt-8">
                <ChapterMarkdown body={activeBody} />
              </div>
            ) : (
              <p className="mt-8 text-[var(--muted)]">这一章暂时没有内容。</p>
            )}

            {/* 上一章 / 下一章 */}
            <nav className="mt-14 grid gap-px border-t-2 border-[var(--rule)] pt-6 sm:grid-cols-2">
              {previous ? (
                <button
                  className="focus-ring group py-3 text-left"
                  onClick={() => selectChapter(previous.chapterId)}
                  type="button"
                >
                  <span className="eyebrow text-[var(--muted)]">上一章</span>
                  <span className="mt-1 block font-bold group-hover:underline">
                    {previous.title}
                  </span>
                </button>
              ) : (
                <span />
              )}
              {next ? (
                <button
                  className="focus-ring group py-3 text-left sm:text-right"
                  onClick={() => selectChapter(next.chapterId)}
                  type="button"
                >
                  <span className="eyebrow text-[var(--muted)]">下一章</span>
                  <span className="mt-1 block font-bold group-hover:underline">
                    {next.title}
                  </span>
                </button>
              ) : (
                <span />
              )}
            </nav>
          </>
        ) : (
          <p className="text-[var(--muted)]">这门课还没有章节。</p>
        )}
      </article>
    </div>
  );
}

/** 极简 Markdown 渲染：标题/加粗/代码块/列表/引用/段落，与全站排版一致。 */
function ChapterMarkdown({ body }: { body: string }) {
  const blocks = body.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, index) => (
        <MarkdownBlock block={block} key={index} />
      ))}
    </>
  );
}

function MarkdownBlock({ block }: { block: string }) {
  const trimmed = block.trim();
  if (trimmed.startsWith("```")) {
    const code = trimmed.replace(/^```[a-z]*\n?/, "").replace(/```$/, "");
    return (
      <pre className="mt-8 overflow-x-auto bg-[var(--ink)] p-5 font-mono text-sm leading-7 text-[var(--page)]">
        <code>{code}</code>
      </pre>
    );
  }
  if (trimmed.startsWith("## ")) {
    return (
      <h3 className="mt-12 border-t-2 border-[var(--rule)] pt-6 text-2xl font-black tracking-[-0.02em]">
        {trimmed.slice(3)}
      </h3>
    );
  }
  if (trimmed.startsWith("### ")) {
    return (
      <h4 className="mt-10 text-xl font-bold">{trimmed.slice(4)}</h4>
    );
  }
  if (trimmed.startsWith("> ")) {
    return (
      <blockquote className="mt-8 border-l-4 border-[var(--rule)] bg-[var(--surface)] py-2 pl-6 italic text-[var(--muted)]">
        {trimmed.slice(2)}
      </blockquote>
    );
  }
  if (/^[-*] /m.test(trimmed)) {
    return (
      <ul className="mt-6 list-disc space-y-2 pl-6 leading-8">
        {trimmed.split("\n").map((line, index) => (
          <li key={index}>{renderInline(line.replace(/^[-*] /, ""))}</li>
        ))}
      </ul>
    );
  }
  return <p className="mt-6 leading-8">{renderInline(trimmed)}</p>;
}

function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          className="rounded bg-[var(--surface-strong)] px-1.5 py-0.5 font-mono text-[0.9em]"
          key={index}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={index}>{part}</span>;
  });
}
