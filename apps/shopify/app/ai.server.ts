import { identifyItem, photosFromUrls, writeListings } from "@agentic-selling/agents";
import type { InventoryItem, InventoryStore } from "@agentic-selling/core";
import { planFor, saveListingTexts, type SellerSettings } from "./selling.server";

// Server-side AI, for sellers who work in the Shopify admin or the phone page
// instead of a chat assistant. In chat, the assistant does this work itself
// through MCP tools.

/** Step 1: read the photos and tags and save the item's details. */
export async function identifyStep(store: InventoryStore, item: InventoryItem, sellerNotes?: string) {
  const photos = await photosFromUrls(
    item.photos.filter((p) => p.kind === "original").map((p) => p.url),
    8,
  );
  if (!photos.length) throw new Error("Add photos to this item first.");
  const facts = await identifyItem(photos, sellerNotes);
  await store.saveFacts(item.id, facts);
  // The AI's title is more useful than a placeholder in Shopify and in lists.
  if (item.title === "New item") await store.renameItem(item.id, facts.title);
  return { ...item, facts };
}

/** Step 2: price for each platform and write the listings. Needs details and a floor. */
export async function listingsStep(store: InventoryStore, item: InventoryItem, settings: SellerSettings) {
  const plan = planFor(item, settings);
  if ("missing" in plan) return [];
  const texts = await writeListings(item.facts!, plan.prices, ["shopify", ...plan.selected]);
  return saveListingTexts(store, item, settings, texts);
}

/** Both steps, for the admin's single "Write listings with AI" button. */
export async function analyzeWithAI(
  store: InventoryStore,
  item: InventoryItem,
  settings: SellerSettings,
  sellerNotes?: string,
) {
  const withFacts = !item.facts || sellerNotes ? await identifyStep(store, item, sellerNotes) : item;
  const drafts = await listingsStep(store, withFacts, settings);
  return { facts: withFacts.facts!, drafts };
}
