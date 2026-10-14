import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ShopifyInventoryStore } from "../inventory/shopify-store.server";
import { recordStoreSale } from "../selling.server";

// A buyer checked out on the seller's store. If that was the last one, the
// order locks it and flags every other marketplace listing for take-down,
// exactly as if the seller had tapped "Sold" themselves.

interface OrderPayload {
  name?: string;
  line_items?: Array<{ product_id: number | null }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  // No admin session means the app was uninstalled; nothing to update.
  if (!admin) return new Response();

  const order = payload as OrderPayload;
  const productIds = [...new Set((order.line_items ?? []).flatMap((l) => (l.product_id ? [String(l.product_id)] : [])))];
  const store = new ShopifyInventoryStore(admin.graphql, shop);
  for (const id of productIds) {
    const sale = await recordStoreSale(store, id, order.name);
    if (sale) console.log(`${topic} ${order.name ?? ""}: product ${id} sold on ${shop}; ${sale.left} left, ${sale.toDelist.length} listings to take down`);
  }
  return new Response();
};
