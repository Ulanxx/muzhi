import { getServerEnv } from "@/config/env";
import type { SiteConfig } from "@/modules/site";

export function getSiteConfig(): SiteConfig {
  const env = getServerEnv();

  return {
    name: env.APP_NAME,
    description: "牧之的知识产品交付站：课程、会员与单课购买的一体化底座。",
    url: env.APP_URL,
    locale: "zh-CN",
    creator: {
      name: "牧之",
      supportEmail: "support@example.com",
    },
  };
}
