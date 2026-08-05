/**
 * 朱文方印 — 牧之。
 * 品牌唯一签名 motif：footer、长内容末尾、favicon 用。不作导航栏贴片。
 * 骨架用 SVG <text>；真篆刻/手写「牧之」替换进来时只换此处，系统不动。
 * 品牌锁定见 zmzai-cloud/BRAND.md §4.3。
 */
export function Seal({
  size = 40,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="牧之印"
      className={className}
    >
      <rect
        x="4"
        y="4"
        width="92"
        height="92"
        rx="2"
        fill="var(--accent-strong)"
      />
      {/* 朱文方印：两字竖排，传统印章读法上→下。字号留足内边距避免溢出。 */}
      <text
        x="50"
        y="42"
        textAnchor="middle"
        fontSize="34"
        fontWeight="700"
        fill="var(--accent-ink)"
        fontFamily="var(--font-serif), serif"
      >
        牧
      </text>
      <text
        x="50"
        y="80"
        textAnchor="middle"
        fontSize="34"
        fontWeight="700"
        fill="var(--accent-ink)"
        fontFamily="var(--font-serif), serif"
      >
        之
      </text>
    </svg>
  );
}
