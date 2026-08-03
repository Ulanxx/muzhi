import type { ProductDefinition } from "@/modules/commerce";

export const productsConfig = [
  {
    id: "membership-yearly",
    title: "全站年度会员",
    description: "在有效期内访问所有标记为会员内容的课程和资料。",
    price: {
      amountInMinorUnits: 49900,
      currency: "CNY",
    },
    entitlement: {
      type: "membership",
      targetId: null,
      durationDays: 365,
    },
    active: true,
  },
  {
    id: "course-demo-foundations",
    title: "单课永久访问",
    description: "购买一门指定课程，不依赖全站会员状态。",
    price: {
      amountInMinorUnits: 9900,
      currency: "CNY",
    },
    entitlement: {
      type: "course",
      targetId: null,
      targetSlug: "single-course-delivery",
      durationDays: null,
    },
    active: true,
  },
  {
    id: "course-ai-playbook",
    title: "AI 实操手册（文档课）",
    description: "一套按章节阅读的 AI 实操手册，购买后永久解锁全部章节。",
    price: {
      amountInMinorUnits: 19900,
      currency: "CNY",
    },
    entitlement: {
      type: "course",
      targetId: null,
      targetSlug: "ai-playbook",
      durationDays: null,
    },
    active: true,
  },
] as const satisfies readonly ProductDefinition[];
