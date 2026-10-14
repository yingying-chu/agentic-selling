import {
  CHANNELS,
  CHANNEL_IDS,
  fitText,
  planItem,
  recordSale,
  upsertChannelState,
  type ChannelId,
  type InventoryItem,
  type InventoryStore,
  type ItemPlan,
  type ListingDraft,
} from "@agentic-selling/core";
import db from "./db.server";

// Selling operations shared by the admin screens and the MCP tools, so both
// entry points behave exactly the same.

export interface SellerSettings {
  enabledChannels: ChannelId[];
  labelCost: number;
  sellerPaysShipping: boolean;
}

export function isChannelId(value: string): value is ChannelId {
  return (CHANNEL_IDS as readonly string[]).includes(value);
}

export async function getSettings(shop: string): Promise<SellerSettings> {
  const row = await db.shopSettings.upsert({ where: { shop }, create: { shop }, update: {} });
  return {
    enabledChannels: row.enabledChannels.filter(isChannelId),
    labelCost: row.labelCost,
    sellerPaysShipping: row.sellerPaysShipping,
  };
}

export async function updateSettings(shop: string, patch: Partial<SellerSettings>): Promise<SellerSettings> {
  await db.shopSettings.upsert({ where: { shop }, create: { shop, ...patch }, update: patch });
  return getSettings(shop);
}

/** Prices and channel picks for an item, or the reason it can't be planned yet. */
export function planFor(item: InventoryItem, settings: SellerSettings): ItemPlan | { missing: string } {
  if (!item.facts) return { missing: "item details (brand, size, condition, estimated value)" };
  if (item.floorNet === null) return { missing: "a take-home floor price" };
  return planItem(item.facts, { floorNet: item.floorNet, ...settings });
}

export interface ListingText {
  channel: ChannelId;
  title: string;
  description: string;
  tags: string[];
  categoryHint: string;
}

/** Fits text to each platform's limits, attaches the computed price, and saves. */
export async function saveListingTexts(
  store: InventoryStore,
  item: InventoryItem,
  settings: SellerSettings,
  texts: ListingText[],
): Promise<ListingDraft[]> {
  const plan = planFor(item, settings);
  if ("missing" in plan) throw new Error(`Can't price this item yet: missing ${plan.missing}`);

  const drafts = texts.flatMap((t): ListingDraft[] => {
    const price = plan.prices[t.channel] ?? planItem(item.facts!, {
      floorNet: item.floorNet!,
      ...settings,
      enabledChannels: [...settings.enabledChannels, t.channel],
    }).prices[t.channel];
    if (!price) return [];
    const c = CHANNELS[t.channel];
    return [
      {
        channel: t.channel,
        title: fitText(t.title, c.titleMaxLength),
        description: fitText(t.description, c.descriptionMaxLength),
        tags: t.tags,
        categoryHint: t.categoryHint,
        price,
      },
    ];
  });

  // Replace drafts for these channels, keep the rest.
  const kept = item.listings.filter((l) => !drafts.some((d) => d.channel === l.channel));
  const all = [...kept, ...drafts];
  await store.saveListings(item.id, all);

  const now = new Date().toISOString();
  let states = item.channels;
  for (const d of drafts) {
    const existing = states.find((s) => s.channel === d.channel);
    if (!existing || existing.status === "draft") {
      states = upsertChannelState(states, { channel: d.channel, status: "draft", listedPrice: d.price.listPrice }, now);
    }
  }
  await store.saveChannelStates(item.id, states);
  return drafts;
}

export async function markPosted(store: InventoryStore, item: InventoryItem, channel: ChannelId, url?: string) {
  const listing = item.listings.find((l) => l.channel === channel);
  const states = upsertChannelState(
    item.channels,
    { channel, status: "active", ...(url ? { url } : {}), ...(listing ? { listedPrice: listing.price.listPrice } : {}) },
    new Date().toISOString(),
  );
  await store.saveChannelStates(item.id, states);
  return states;
}

export async function markSold(store: InventoryStore, item: InventoryItem, channel: ChannelId) {
  return recordSale(store, item.id, channel);
}

export async function confirmDelisted(store: InventoryStore, item: InventoryItem, channel: ChannelId) {
  const states = upsertChannelState(item.channels, { channel, status: "delisted" }, new Date().toISOString());
  await store.saveChannelStates(item.id, states);
  return states.filter((s) => s.status === "needs_delist").map((s) => s.channel);
}

/** Where a seller goes to post or edit on platforms we can't post to automatically. */
export const POST_LINKS: Partial<Record<ChannelId, string>> = {
  poshmark: "https://poshmark.com/create-listing",
  mercari: "https://www.mercari.com/sell/",
  depop: "https://www.depop.com/products/create/",
  vinted: "https://www.vinted.com/items/new",
  grailed: "https://www.grailed.com/sell/new",
  fb_marketplace: "https://www.facebook.com/marketplace/create/item",
  ebay: "https://www.ebay.com/sl/sell",
  etsy: "https://www.etsy.com/your/shops/me/listing-editor/create",
};
