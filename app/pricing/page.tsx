import type { Metadata } from "next";

import { CheckoutPanel } from "@/components/checkout-panel";
import { SiteHeader } from "@/components/site-header";
import { listActiveProducts } from "@/app/lib/commerce-service";
import { getSiteConfig } from "@/config/site.config";
import { getCurrentUser } from "@/providers/auth/session";
import { getPaymentProvider } from "@/providers/payment";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "价格与购买",
};

export default async function PricingPage() {
  const site = getSiteConfig();
  const user = await getCurrentUser();
  const provider = getPaymentProvider();
  const products = await listActiveProducts().catch(() => []);

  return (
    <>
      <SiteHeader site={site} />
      <main className="page-shell py-16 lg:py-20">
        <p className="eyebrow text-[var(--muted)]">
          {provider.name.toUpperCase()} PAYMENT
        </p>
        <h1 className="headline mt-6 text-[clamp(3rem,9vw,7rem)]">
          两种买法
        </h1>
        <p className="mt-8 max-w-[38rem] border-t-2 border-[var(--rule)] pt-6 text-xl leading-9">
          按年订阅解锁全部内容，或者只买你想看的那一门。买了就是你的。
        </p>

        <CheckoutPanel
          paymentMethods={[...provider.supportedMethods]}
          products={products.map((product) => ({
            id: product.sku,
            title: product.title,
            description: product.description,
            amountInMinorUnits: product.amountInMinorUnits,
            currency: product.currency,
            entitlementType: product.entitlementType,
            durationDays: product.entitlementDurationDays,
          }))}
          signedIn={user !== null}
        />
      </main>
    </>
  );
}
