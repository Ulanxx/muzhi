import Link from "next/link";

import { LogoutButton } from "@/components/logout-button";
import type { SiteConfig } from "@/modules/site";
import { getCurrentUser } from "@/providers/auth/session";

export async function SiteHeader({ site }: { site: SiteConfig }) {
  const user = await getCurrentUser().catch(() => null);

  return (
    <header className="sticky top-0 z-50 border-b-2 border-[var(--rule)] bg-[var(--page)]">
      <div className="page-shell flex h-16 items-center justify-between gap-6">
        <Link className="focus-ring flex min-w-0 items-center gap-2.5" href="/">
          <span
            aria-hidden="true"
            className="grid size-7 place-items-center bg-[var(--ink)] font-mono text-xs font-bold text-[var(--page)]"
          >
            牧
          </span>
          <span className="truncate text-sm font-bold tracking-[-0.01em]">
            {site.name}
          </span>
        </Link>

        <nav
          aria-label="主导航"
          className="flex items-center gap-6 text-sm font-medium"
        >
          <Link
            className="focus-ring transition-colors hover:text-[var(--muted)]"
            href="/courses"
          >
            课程
          </Link>
          <Link
            className="focus-ring transition-colors hover:text-[var(--muted)]"
            href="/blog"
          >
            博客
          </Link>
          <Link
            className="focus-ring hidden transition-colors hover:text-[var(--muted)] sm:block"
            href="/pricing"
          >
            价格
          </Link>

          {user === null ? (
            <Link
              className="focus-ring whitespace-nowrap bg-[var(--ink)] px-4 py-2 text-sm font-bold text-[var(--page)] transition-colors hover:bg-[var(--muted)]"
              href="/login"
            >
              登录
            </Link>
          ) : (
            <>
              <Link
                className="focus-ring hidden transition-colors hover:text-[var(--muted)] md:block"
                href="/account/orders"
              >
                订单
              </Link>
              {user.role === "admin" ? (
                <Link
                  className="focus-ring hidden transition-colors hover:text-[var(--muted)] md:block"
                  href="/admin"
                >
                  后台
                </Link>
              ) : null}
              <Link
                className="focus-ring hidden max-w-[10rem] truncate font-bold md:block"
                href="/account/security"
                title={user.email}
              >
                {user.name}
              </Link>
              <LogoutButton />
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
