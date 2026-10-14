import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ShopifyInventoryStore } from "../inventory/shopify-store.server";
import { recordStoreSale } from "../selling.server";

// Stock changed. When a buyer checks out on the seller's store, the item's one
// unit goes to 0; that locks it and flags every other marketplace listing for
// take-down, exactly as if the seller had tapped "Sold". Our own changes
// (new item at 1, a manual sale zeroing it) are ignored by recordStoreSale.

interface InventoryLevelPayload {
  inventory_item_id?: number;
  available?: number | null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, admin } = await authenticate.webhook(request);
  // No admin session means the app was uninstalled; nothing to update.
  if (!admin) return new Response();

  const level = payload as InventoryLevelPayload;
  if (!level.inventory_item_id || (level.available ?? 1) > 0) return new Response();

  const store = new ShopifyInventoryStore(admin.graphql, shop);
  const productId = await store.productForInventoryItem(level.inventory_item_id);
  const sale = productId ? await recordStoreSale(store, productId) : null;
  if (sale) console.log(`Store checkout: ${productId} sold on ${shop}; ${sale.toDelist.length} listings to take down`);
  return new Response();
};
