import { NextResponse } from "next/server";

/** 注册已迁移到 auth.zmzai.cloud，此端点下线（410 Gone）。 */
export async function POST() {
  return NextResponse.json({ error: "注册已迁移到 auth.zmzai.cloud/register" }, { status: 410 });
}
