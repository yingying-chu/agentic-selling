import { identifyItem, photosFromUrls, writeListings } from "@agentic-selling/agents";
import type { InventoryItem, InventoryStore } from "@agentic-selling/core";
import { planFor, saveListingTexts, type SellerSettings } from "./selling.server";

// Server-side AI, for sellers who work in the Shopify admin instead of a chat
// assistant. In chat, the assistant does this work itself through MCP tools.

export async function analyzeWithAI(
  store: InventoryStore,
  item: InventoryItem,
  settings: SellerSettings,
  sellerNotes?: string,
) {
  let facts = item.facts;
  if (!facts || sellerNotes) {
    const photos = await photosFromUrls(
      item.photos.map((p) => p.url),
      8,
    );
    if (!photos.length) throw new Error("Add photos to this product first.");
    facts = await identifyItem(photos, sellerNotes);
    await store.saveFacts(item.id, facts);
  }

  const updated = { ...item, facts };
  const plan = planFor(updated, settings);
  // Without a floor there's nothing to price yet; details alone are still useful.
  if ("missing" in plan) return { facts, drafts: [] };

  const texts = await writeListings(facts, plan.prices, ["shopify", ...plan.selected]);
  const drafts = await saveListingTexts(store, updated, settings, texts);
  return { facts, drafts };
}
