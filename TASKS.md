# 开发任务

状态约定：`TODO`、`IN PROGRESS`、`BLOCKED`、`DONE`。

## Phase 0：边界与治理

- DONE：创建无私有 Git 历史的新仓；
- DONE：归档现状分析、迁移映射和目标拓扑；
- DONE：明确 v0.1 核心、可选和不进入范围；
- DONE：建立安全基线和仓库协作规则；
- DONE：正式英文展示名使用 `mdldm Knowledge Kit`，见 ADR 0001；
- DONE：公共核心采用 Apache-2.0，见 ADR 0002；
- DONE：v0.1 同时支持全站订阅会员与单课购买，见 ADR 0003；
- DONE：为旧站功能补齐 `core / optional / private / drop` 清单。

退出条件：产品名、许可证、v0.1 权益范围均有正式决策记录。

## Phase 1：应用骨架

- DONE：初始化 Next.js、React、TypeScript 和 Tailwind；
- DONE：建立 `modules/`、`providers/`、`config/` 模块边界；
- DONE：接入 MongoDB Adapter；
- DONE：实现 Feature Flags 和站点配置；
- DONE：加入 `.env.example`、Docker Compose 和配置校验；
- DONE：实现 `create-admin`、`seed-demo` 和 `check-config`；
- DONE：建立 Lint、类型检查、单测、构建和 E2E CI。

退出条件：在无支付、OSS、SMTP 配置时可启动 Demo 站。

## Phase 2：课程交付闭环

- DONE：Series、Course、CourseMaterial 和 CourseProgress；
- DONE：后台系列与课时管理；
- DONE：统一 MediaAsset；
- DONE：Local Storage Provider；
- DONE：本地 MP4 播放和安全下载；
- DONE：断点续播和系列进度；
- DONE：发布前媒体可用性校验。

退出条件：管理员能发布一节课，普通用户能观看、续播和下载授权资料。

## Phase 3：身份与权益

- DONE：唯一邮箱注册入口；
- DONE：邮箱验证、登录、退出、找回和修改密码；
- DONE：服务端固定新用户角色；
- DONE：Cookie、CSRF、CORS、安全 Header 和 MongoDB 共享速率限制；
- DONE：Entitlement 模型与统一鉴权服务；
- DONE：`public / registered / member / course / series` 权限矩阵；
- DONE：邀请码授予权益；
- DONE：越权与到期回收测试；
- DONE：Vercel、MongoDB Atlas、阿里云 OSS 与 SMTP 配置文档。

退出条件：权限矩阵通过自动化测试，越权请求全部失败。

## Phase 4：交易与支付

- DONE：Product、Order、OrderItem 和 PaymentEvent；
- DONE：服务端 SKU 定价；
- DONE：Manual Payment Provider；
- DONE：Mock Payment Provider；
- DONE：XorPay Adapter；
- DONE：Webhook 验签、幂等和失败重放；
- DONE：支付与授权事务边界；
- DONE：订单后台。

退出条件：客户端无法篡改金额，重复回调不会重复授予权益。

## Phase 5：后台与监控

- DONE：用户、课程、订单、权益、媒体和学习数据总览；
- DONE：支付、转码、邮件和存储失败队列；
- DONE：`/api/health`；
- DONE：结构化日志和 ErrorReporter；
- DONE：通用 Webhook 告警；
- DONE：数据导出、备份和恢复说明。

退出条件：管理员无需查看服务器日志即可发现主要故障。

## Phase 6：公开发布

- DONE：全新环境 15 分钟安装测试；
- DONE：虚构 Demo 数据、截图和演示课程；
- DONE：部署、Provider、升级、备份和回滚文档；
- DONE：依赖、安全、隐私和密钥扫描；
- DONE：贡献指南、Issue 模板和 Release 流程；
- DONE：发布 `v0.1.0`。

退出条件：陌生贡献者只读 README 即可跑通发布和学习主流程。

## Phase 7：自有站点定制（牧之知识产品）

基于公开底座的二次开发，面向「牧之知识产品」实例。

- DONE：全站品牌标识改为 `muzhi` / 牧之知识产品（Cookie、邀请码前缀、localStorage、Webhook 头与 payload、导出文件名、邮件标题、数据库名），同步 12 处测试断言；
- DONE：杂志编辑部视觉改版（纸感底/墨色字/荧光绿点缀）；修复 `@layer base` 层叠 bug（此前 `a { color: inherit }` 使链接文字色工具类静默失效）与 16 处强调色低对比；
- DONE：前台导航感知登录态并补登出入口（此前登出仅在管理员面板）；
- DONE：免费免登博客（MDX + frontmatter zod 校验 + GFM），`/feed.xml`、sitemap、robots 全套 SEO，接入 `remark-frontmatter` 剥离 YAML 头；
- DONE：文档型付费课程，见 ADR 0012——Course 加 `contentType`、章节独立成表、付费章正文零泄漏、逐章阅读进度、页内付费墙复用 CheckoutPanel、发布校验按类型分支、后台章节编辑；权益/支付/邀请码链路零改动复用；
- DONE：E2E 覆盖文档课全流程（建课加章、试读公开、付费 403 零泄漏、授权解锁、逐章进度）。

退出条件：站点能以「免费博客建信任 → 文档/视频付费课变现」的闭环运行，付费文字不在任何未授权响应中泄漏。
