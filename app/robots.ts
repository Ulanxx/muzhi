import type { MetadataRoute } from "next";

import { getSiteConfig } from "@/config/site.config";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  const site = getSiteConfig();
  const base = site.url.replace(/\/$/, "");

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/account", "/api", "/learn"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
