import { expect, test } from "@playwright/test";
import { createConnection, Types } from "mongoose";

import { hashInvitationCode } from "@/modules/entitlement/invitation";
import { hashOpaqueToken } from "@/modules/identity/credentials";

const e2eOrigin = "http://127.0.0.1:3210";
const e2eSecret =
  process.env.AUTH_SECRET ??
  "playwright-local-secret-value-with-more-than-32-characters";
const mongoUri =
  process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/muzhi_knowledge";

/**
 * 文档课完整闭环：后台建课加章 → 发布（无需视频）→ 未授权试读可见、
 * 付费章 403 零泄漏 → 邀请码授权 → 全部章节可读 → 逐章进度。
 */
test("document course: preview public, paid chapters gated, reading progress tracked", async ({
  page,
}) => {
  const suffix = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  const email = `reader-${suffix}@example.com`;
  const password = "reader-password-2026";

  // 1. admin 建文档课
  const adminLogin = await page.request.post("/api/auth/login", {
    headers: { Origin: e2eOrigin },
    data: {
      email: "admin@example.com",
      password: "local-demo-admin-password-2026",
    },
  });
  expect(adminLogin.ok()).toBe(true);

  const seriesResponse = await page.request.post("/api/admin/series", {
    headers: { Origin: e2eOrigin },
    data: {
      title: `文档课系列 ${suffix}`,
      slug: `doc-series-${suffix}`,
      description: "验证文档课交付与付费墙。",
      accessLevel: "course",
    },
  });
  expect(seriesResponse.status()).toBe(201);
  const series = (await seriesResponse.json()) as { series: { id: string } };

  const courseResponse = await page.request.post("/api/admin/courses", {
    headers: { Origin: e2eOrigin },
    data: {
      seriesId: series.series.id,
      title: `AI 手册 ${suffix}`,
      slug: `doc-course-${suffix}`,
      summary: "一门按章节阅读的文档课。",
      accessLevel: "course",
      contentType: "document",
      position: 0,
    },
  });
  expect(courseResponse.status()).toBe(201);
  const course = (await courseResponse.json()) as { course: { id: string } };

  // 无章节时发布应被拒绝
  expect(
    (
      await page.request.post(
        `/api/admin/courses/${course.course.id}/publish`,
        { headers: { Origin: e2eOrigin } },
      )
    ).status(),
  ).toBe(400);

  // 2. 加三章：一章试读 + 两章付费
  async function addChapter(
    title: string,
    position: number,
    isPreview: boolean,
    body: string,
  ) {
    const response = await page.request.post("/api/admin/chapters", {
      headers: { Origin: e2eOrigin },
      data: { courseId: course.course.id, title, position, body, isPreview },
    });
    expect(response.status()).toBe(201);
    return ((await response.json()) as { chapter: { id: string } }).chapter;
  }

  const previewChapter = await addChapter(
    `试读章 ${suffix}`,
    0,
    true,
    `这是试读内容 ${suffix}，任何人都能看。`,
  );
  const paidChapter1 = await addChapter(
    `付费章一 ${suffix}`,
    1,
    false,
    `付费正文一 ${suffix} 的独特密语 ALPHA-${suffix}。`,
  );
  const paidChapter2 = await addChapter(
    `付费章二 ${suffix}`,
    2,
    false,
    `付费正文二 ${suffix} 的独特密语 BETA-${suffix}。`,
  );

  // 有章节后发布成功（无需视频）
  expect(
    (
      await page.request.post(
        `/api/admin/courses/${course.course.id}/publish`,
        { headers: { Origin: e2eOrigin } },
      )
    ).ok(),
  ).toBe(true);
  await page.request.post("/api/auth/logout", {
    headers: { Origin: e2eOrigin },
  });

  // 3. 未授权：试读章公开，付费章 403 零泄漏
  const previewPublic = await page.request.get(
    `/api/chapters/${previewChapter.id}`,
  );
  expect(previewPublic.status()).toBe(200);
  expect((await previewPublic.json()).body).toContain("试读内容");

  for (const paid of [paidChapter1, paidChapter2]) {
    const response = await page.request.get(`/api/chapters/${paid.id}`);
    expect(response.status()).toBe(403);
    const payload = await response.json();
    expect(payload.body).toBeUndefined();
  }

  // 未授权学习页：SSR 不含付费章正文密语
  await page.goto(`/learn/${course.course.id}`);
  const ssrText = await page.locator("body").innerText();
  expect(ssrText).not.toContain(`ALPHA-${suffix}`);
  expect(ssrText).not.toContain(`BETA-${suffix}`);
  // 试读章正文直接可见
  await expect(page.getByText(`这是试读内容 ${suffix}`)).toBeVisible();
  // 点进付费章：出现付费墙，正文不渲染
  await page
    .getByRole("button", { name: new RegExp(`付费章一 ${suffix}`) })
    .first()
    .click();
  await expect(page.getByText("这一章需要购买后才能阅读")).toBeVisible();
  const paidTabText = await page.locator("body").innerText();
  expect(paidTabText).not.toContain(`ALPHA-${suffix}`);

  // 4. 注册 + 验证邮箱 + 登录
  const registration = await page.request.post("/api/auth/register", {
    headers: { Origin: e2eOrigin },
    data: { name: "Reader", email, password },
  });
  expect(registration.status()).toBe(201);
  const registered = (await registration.json()) as { user: { id: string } };

  const database = await createConnection(mongoUri).asPromise();
  const verificationToken = `verify-${suffix}`;
  await database.collection("identitytokens").insertOne({
    userId: new Types.ObjectId(registered.user.id),
    purpose: "verify_email",
    tokenHash: hashOpaqueToken(verificationToken, e2eSecret),
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    usedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await page.request.post("/api/auth/verify-email", {
    headers: { Origin: e2eOrigin },
    data: { token: verificationToken },
  });

  // 登录后仍未购买：付费章依旧 403
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/courses$/);
  expect(
    (await page.request.get(`/api/chapters/${paidChapter1.id}`)).status(),
  ).toBe(403);

  // 5. 用邀请码授予单课权益（复用现成机制，不依赖支付 provider）
  const invitationCode = `MUZHI-DOC-${suffix.toUpperCase()}`;
  const admin = await database
    .collection("users")
    .findOne({ role: "admin", status: "active" });
  expect(admin).not.toBeNull();
  await database.collection("invitations").insertOne({
    codeHash: hashInvitationCode(invitationCode, e2eSecret),
    codeHint: "MUZHI-DOC…TEST",
    entitlementType: "course",
    targetId: course.course.id,
    durationDays: null,
    maxRedemptions: 1,
    redemptionCount: 0,
    status: "active",
    expiresAt: null,
    createdBy: admin!._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const redeem = await page.request.post("/api/entitlements/redeem", {
    headers: { Origin: e2eOrigin },
    data: { code: invitationCode },
  });
  expect(redeem.ok()).toBe(true);

  // 6. 授权后：付费章可读
  const unlocked = await page.request.get(`/api/chapters/${paidChapter1.id}`);
  expect(unlocked.status()).toBe(200);
  expect((await unlocked.json()).body).toContain(`ALPHA-${suffix}`);

  // 7. 逐章进度：标记全部章节已读 → completed
  for (const chapter of [previewChapter, paidChapter1, paidChapter2]) {
    const mark = await page.request.put(
      `/api/courses/${course.course.id}/progress`,
      {
        headers: { Origin: e2eOrigin },
        data: { chapterId: chapter.id, read: true },
      },
    );
    expect(mark.ok()).toBe(true);
  }
  const progressResponse = await page.request.get(
    `/api/courses/${course.course.id}/progress`,
  );
  const progressPayload = (await progressResponse.json()) as {
    progress: { readChapterIds: string[]; completed: boolean };
  };
  expect(progressPayload.progress.readChapterIds).toHaveLength(3);
  expect(progressPayload.progress.completed).toBe(true);

  await database.close();
});
