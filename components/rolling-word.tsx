"use client";

import { useEffect, useState } from "react";

const DEFAULT_WORDS = ["用起来", "玩得转", "说明白", "做出来", "真落地"];

type RollingWordProps = {
  words?: string[];
  interval?: number;
  className?: string;
};

/**
 * RollingWord — 标题尾部词「逐字上滚」，每位字符是独立的竖向卷轴（老虎机/odometer 感）。
 * - 从 words 派生成 L 条卷轴，第 p 条 = 每个词的第 p 个字符。
 * - 全局步进取 i，每个卷轴显示 words[i] 的第 p 位，因此同步时正好拼出原词。
 * - 视差：每位字符的过渡时长与延迟依次递增（p*90ms 延迟、p*110ms 时长），
 *   形成「一个字一个字错峰上滚」的层次感。开「减少动态效果」时静止显示首词。
 */
export function RollingWord({
  words = DEFAULT_WORDS,
  interval = 2200,
  className,
}: RollingWordProps) {
  const [i, setI] = useState(0);
  const n = words.length;
  const length = words[0]?.length ?? 0;

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => {
      setI((p) => (p + 1) % n);
    }, interval);
    return () => clearInterval(id);
  }, [n, interval]);

  const reels = Array.from({ length }, (_, p) => words.map((w) => w[p]));

  return (
    <span className={`inline-flex ${className ?? ""}`} aria-label={words.join("，")}>
      {reels.map((reel, p) => {
        const rn = reel.length;
        const duration = 620 + p * 110;
        const delay = p * 90;
        return (
          <span
            key={p}
            className="relative inline-grid overflow-hidden align-baseline"
            style={{ transitionDelay: `${delay}ms` }}
          >
            {reel.map((ch, idx) => {
              const offset = ((idx - i) % rn + rn) % rn;
              const y = offset === 0 ? 0 : offset <= rn / 2 ? 100 : -100;
              const opacity = offset === 0 ? 1 : 0;
              return (
                <span
                  key={idx}
                  className="col-start-1 row-start-1"
                  style={{
                    transform: `translateY(${y}%)`,
                    opacity,
                    transition: `transform ${duration}ms var(--ease-spring) ${delay}ms, opacity ${duration}ms var(--ease-spring) ${delay}ms`,
                  }}
                >
                  {ch}
                </span>
              );
            })}
          </span>
        );
      })}
    </span>
  );
}
