/**
 * zmzai cloud 牧之 — wordmark。
 * `zmzai` 是可被占用的罗马化 handle，用等宽字体敲出来像铭牌；
 * `cloud` 是更轻的载体后缀。不做图形 logo。
 * 品牌锁定见 zmzai-cloud/design.md 与 BRAND.md §4.4。
 */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`font-mono font-bold tracking-[0.08em] uppercase ${className}`}
    >
      <span className="text-[var(--ink)]">zmzai</span>
      <span className="text-[var(--muted)] font-normal">.cloud</span>
    </span>
  );
}
