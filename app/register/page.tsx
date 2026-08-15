import { redirect } from "next/navigation";

/** 注册已迁移到 auth.zmzai.cloud（单点注册），muzhi 不再承载注册。 */
export default function RegisterPage() {
  redirect("https://auth.zmzai.cloud/register");
}
