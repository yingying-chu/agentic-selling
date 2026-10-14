import { improvePhotos, type PhotoInput } from "@agentic-selling/agents";
import type { InventoryItem, InventoryStore } from "@agentic-selling/core";
import { unauthenticated } from "./shopify.server";
import { ShopifyInventoryStore } from "./inventory/shopify-store.server";
import { shopForKey } from "./mcp/connections.server";

// Server side of the phone page (/s/<key>): the seller's private link works
// without a Shopify login, like the assistant link.

export async function phoneContext(key: string | undefined) {
  const shop = await shopForKey(key ?? null);
  if (!shop) throw new Response("This link isn't valid anymore. Create a new one in the app.", { status: 404 });
  const { admin } = await unauthenticated.admin(shop);
  return { shop, store: new ShopifyInventoryStore(admin.graphql, shop) };
}

/**
 * The presenter's own phone link (set DEMO_PRESENTER_KEY to its key). Only it
 * shows "Reset demo", so judges sharing the other link can't wipe each other's items.
 */
export function isPresenter(key: string | undefined): boolean {
  const presenter = process.env.DEMO_PRESENTER_KEY;
  return Boolean(presenter && key === presenter);
}

export async function loadItem(store: InventoryStore, id: string): Promise<InventoryItem> {
  const item = await store.getItem(id);
  if (!item) throw new Response("Item not found", { status: 404 });
  return item;
}

/** Fetches the seller's original photos (resized by Shopify's CDN) as pipeline input. */
async function originals(item: InventoryItem): Promise<PhotoInput[]> {
  const photos = item.photos.filter((p) => p.kind === "original").slice(0, 8);
  return Promise.all(
    photos.map(async (p) => {
      const res = await fetch(p.url);
      if (!res.ok) throw new Error(`Couldn't load photo (${res.status})`);
      const type = res.headers.get("content-type") ?? "image/jpeg";
      const mediaType = type.includes("png") ? ("image/png" as const) : type.includes("webp") ? ("image/webp" as const) : ("image/jpeg" as const);
      return { source: p.url, data: Buffer.from(await res.arrayBuffer()), mediaType };
    }),
  );
}

/** Runs the photo pipeline and saves the results to the item. Returns notes for the seller. */
export async function makeListingPhotos(store: InventoryStore, item: InventoryItem, modelPhoto: boolean) {
  const inputs = await originals(item);
  if (!inputs.length) throw new Error("This item has no photos yet.");
  // On a redo, the corrected photos already exist; only the AI photos are made again.
  const skipEnhance = item.photos.some((p) => p.kind === "enhanced");
  const result = await improvePhotos(inputs, item.facts, { modelPhoto, skipEnhance });
  await store.addPhotos(
    item.id,
    result.outputs.map((o) => ({ data: o.data, mediaType: o.mediaType, alt: o.alt, kind: o.kind, sourceUrl: o.source })),
  );
  return {
    added: result.outputs.length,
    retakeTips: result.retakeTips,
    missingShots: result.assessment.missingShots,
    rejected: result.rejected.map((r) => ({ kind: r.kind, why: r.issues.slice(0, 2).join(" ") })),
  };
}
