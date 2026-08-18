import type { Metadata, Viewport } from "next";
import { JetBrains_Mono } from "next/font/google";

import { getSiteConfig } from "@/config/site.config";

import "./globals.css";

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-mono",
  display: "swap",
});

const site = getSiteConfig();

export const metadata: Metadata = {
  title: {
    default: site.name,
    template: `%s | ${site.name}`,
  },
  description: site.description,
  applicationName: site.name,
  authors: [{ name: site.creator.name }],
  creator: site.creator.name,
  metadataBase: new URL(site.url),
  openGraph: {
    type: "website",
    locale: site.locale,
    title: site.name,
    description: site.description,
    siteName: site.name,
  },
};

export const viewport: Viewport = {
  themeColor: "#FFFFFF",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang={site.locale} className={mono.variable}>
      <body>{children}</body>
    </html>
  );
}
