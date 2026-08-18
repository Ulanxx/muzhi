import Link from "next/link";

import { Navbar } from "@zmzai/theme";

import { LogoutButton } from "@/components/logout-button";
import type { SiteConfig } from "@/modules/site";
import { getCurrentUser } from "@/providers/auth/session";

/* theme navItemClass(false) 同款 pill（navItemClass 是 client 导出，
   server 组件里不能调用，只能内联；muzhi 导航无 active 态） */
const navLinkClass =
  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink";

/**
 * SiteHeader — 全域统一顶栏（theme Navbar）。
 *
 * 本组件是 server component：登录态在服务端取，登录/订单/后台等条件
 * 渲染好的 JSX 作为 children/actions 传入 client 的 Navbar。
 */
export async function SiteHeader({ site }: { site: SiteConfig }) {
  const user = await getCurrentUser().catch(() => null);

  return (
    <Navbar
      sublabel="muzhi"
      brandHref="/"
      mobileMenu
      badge={
        <span className="hidden rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink-3 sm:inline">
          {site.name}
        </span>
      }
      actions={
        user === null ? (
          <Link
            className="rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-paper transition-colors hover:bg-ink/85"
            href="/login"
          >
            登录
          </Link>
        ) : (
          <>
            <Link
              className="hidden max-w-[10rem] truncate text-sm font-medium text-ink-2 transition-colors hover:text-ink md:block"
              href="/account/security"
              title={user.email}
            >
              {user.name}
            </Link>
            <LogoutButton />
          </>
        )
      }
    >
      <Link className={navLinkClass} href="/courses">
        课程
      </Link>
      <Link className={navLinkClass} href="/blog">
        博客
      </Link>
      <Link className={navLinkClass} href="/pricing">
        价格
      </Link>
      {user !== null ? (
        <>
          <Link className={navLinkClass} href="/account/orders">
            订单
          </Link>
          {user.role === "admin" ? (
            <Link className={navLinkClass} href="/admin">
              后台
            </Link>
          ) : null}
        </>
      ) : null}
    </Navbar>
  );
}
