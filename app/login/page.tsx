import { redirect } from "next/navigation";

import { getServerEnv } from "@/config/env";

/**
 * muzhi 的 /login 已并入 auth SSO。
 * 登录走 auth.zmzai.cloud，登录后 cookie 父域共享，muzhi 直接识别登录态。
 * 注册/找回密码/邮箱验证仍在 muzhi 自己处理（auth 只做登录）。
 */
const AUTH_URL =
  getServerEnv().AUTH_SSO_URL ?? "https://auth.zmzai.cloud";

export default function LoginPage() {
  redirect(`${AUTH_URL}/login?next=${encodeURIComponent("https://muzhi.zmzai.cloud")}`);
}
