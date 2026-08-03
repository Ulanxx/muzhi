# ADR 0012：文档型课程的内容模型与付费墙边界

- 状态：Accepted
- 日期：2026-08-03

## 背景

v0.1 的 Course 假设「课时 = 一个视频 + 若干资料附件」。需要支持按章节阅读的文字课程（文档课），且付费文字必须受到与视频、资料同等级的访问控制。

关键约束：付费文字一旦在未授权的响应里出现（哪怕前端再隐藏），就等于免费送出——通过查看源码或抓包即可获取。因此「正文必须在服务端判权通过之后才读取、才渲染」是不可谈判的硬约束。

## 决策

1. **Course 增加 `contentType`（`video` / `document`），默认 `video`**。文档课仍是 Course 记录，因此 Entitlement、Order、Payment、邀请码、幂等发放对 `course` 类型的链路零改动复用。不引入新的内容类型实体。
2. **章节独立成表 `CourseChapter`**（courseId、title、position、body、isPreview），而不是塞进 Course 的一个大字段。这从第一天就支持逐章试读、上一章/下一章导航与逐章进度。
3. **付费章正文零泄漏**。试读章（isPreview）是公开营销内容，可随页面 SSR（利于 SEO）；付费章正文不进 SSR，由客户端在判权后向鉴权 API `/api/chapters/[chapterId]` 拉取。该 API 沿用 `stream`/`download` 的「存在性合并 404 + 未授权 403 + private,no-store」模式。
4. **试读边界判定收敛到单一纯函数 `canReadChapter`**（`modules/catalog/chapters.ts`），阅读页与章节 API 共用，避免判定逻辑散落。
5. **阅读进度复用 `CourseProgress`**，新增 `readChapterIds: string[]`，与现有视频秒级字段并存。读完全部章节即 `completed=true`。不新建进度模型。
6. **发布校验按 contentType 分支**：视频课仍要求绑定 ready 视频；文档课要求至少一个章节。
7. **进度 API 扩展为判别联合**：视频分支（currentTime/duration）与阅读分支（chapterId）共用同一路由，阅读分支校验章节真实存在且属于本课程。

## 备选方案

### Course 直接加一个 body 大字段

最简单，但无法逐章试读、无法分章导航，只能整篇一个付费墙。试读是知识付费转化的核心，放弃它代价太大。

### 把正文存成 MediaAsset 的 Markdown 文件

正文是结构化内容而非文件，塞进文件存储语义别扭，且试读、分章、进度都要在文件之上再建一层，反而更复杂。

### 所有章节（含试读）都走鉴权 API

最严格，但试读章本是公开营销内容，这样做既多一次请求，也不利于 SEO。只对真正需要保护的付费章施加零泄漏。

### 文档课建独立的内容类型实体

会把购买、权益、邀请码链路全部复制一遍。文档课与视频课在交易与权益上完全同构，差别只在内容形态，用 `contentType` 区分即可。

## 影响

- 权益、支付、幂等发放链路对文档课零改动复用，新商品只在 `products.config.ts` 增加条目。
- `Course` schema 是 `strict: "throw"`，`contentType` 必须显式声明；现有课程因默认值 `video` 零迁移。
- 付费章正文不会出现在未授权的任何响应（HTML、RSC 流、API）中；这是安全验收的一部分。
- 付费墙在课程页内复用 `CheckoutPanel`（新增 `lockedProductId` 与 `onFulfilled`），购买成功后 `router.refresh()` 就地解锁，不跳转。
- 后台章节编辑首版用纯 Markdown 文本框，与博客一致；富文本、章节内嵌媒体留待后续。
