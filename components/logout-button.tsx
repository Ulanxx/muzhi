"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      className="focus-ring whitespace-nowrap border-b-2 border-transparent pb-0.5 text-sm font-medium transition-colors hover:border-[var(--ink)] disabled:opacity-50"
      disabled={pending}
      onClick={() => void logout()}
      type="button"
    >
      {pending ? "退出中" : "退出"}
    </button>
  );
}
