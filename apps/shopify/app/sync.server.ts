import { syncSales, type InventoryStore } from "@agentic-selling/core";
import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { ShopifyInventoryStore } from "./inventory/shopify-store.server";

// Sale sync: reads each live listing's public page and, if it has sold, locks
// the item in Shopify and flags every other listing for takedown.

const UA = "Mozilla/5.0 (compatible; SellieSaleSync/1.0; +https://sellie-dusky.vercel.app)";

async function fetchListing(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: AbortSignal.timeout(12_000),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

export function syncStore(store: InventoryStore) {
  return syncSales(store, fetchListing);
}

/** Every installed shop; used by the scheduled job. */
export async function syncAllShops() {
  const shops = await db.session.findMany({ where: { isOnline: false }, select: { shop: true }, distinct: ["shop"] });
  const results = [];
  for (const { shop } of shops) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const r = await syncStore(new ShopifyInventoryStore(admin.graphql, shop));
      results.push({ shop, checked: r.checked.length, sold: r.sold.map((s) => ({ item: s.item.title, on: s.soldOn })) });
    } catch (err) {
      results.push({ shop, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
