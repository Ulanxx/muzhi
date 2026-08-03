import type { MDXComponents } from "mdx/types";

/**
 * MDX 正文的元素样式映射，走杂志编辑部风格。
 * 只覆盖排版元素，交互组件按需另行注册。
 */
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h2: (props) => (
      <h2
        className="mt-14 border-t-2 border-[var(--rule)] pt-6 text-3xl font-black tracking-[-0.02em]"
        {...props}
      />
    ),
    h3: (props) => (
      <h3 className="mt-10 text-xl font-bold tracking-[-0.01em]" {...props} />
    ),
    p: (props) => <p className="mt-6 leading-8" {...props} />,
    a: (props) => (
      <a
        className="font-semibold text-[var(--accent-readable)] underline underline-offset-4"
        {...props}
      />
    ),
    ul: (props) => (
      <ul className="mt-6 list-disc space-y-2 pl-6 leading-8" {...props} />
    ),
    ol: (props) => (
      <ol className="mt-6 list-decimal space-y-2 pl-6 leading-8" {...props} />
    ),
    blockquote: (props) => (
      <blockquote
        className="mt-8 border-l-4 border-[var(--rule)] bg-[var(--surface)] py-2 pl-6 italic text-[var(--muted)]"
        {...props}
      />
    ),
    code: (props) => (
      <code
        className="rounded bg-[var(--surface-strong)] px-1.5 py-0.5 font-mono text-[0.9em]"
        {...props}
      />
    ),
    pre: (props) => (
      <pre
        className="mt-8 overflow-x-auto bg-[var(--ink)] p-5 font-mono text-sm leading-7 text-[var(--page)]"
        {...props}
      />
    ),
    hr: () => <hr className="mt-12 border-t border-[var(--line)]" />,
    table: (props) => (
      <div className="mt-8 overflow-x-auto">
        <table className="w-full border-collapse text-left" {...props} />
      </div>
    ),
    th: (props) => (
      <th
        className="border-b-2 border-[var(--rule)] px-3 py-2 font-bold"
        {...props}
      />
    ),
    td: (props) => (
      <td className="border-b border-[var(--line)] px-3 py-2" {...props} />
    ),
    ...components,
  };
}
