import { CHANNELS, type ChannelId } from "./channels.ts";
import type { PhotoKind } from "./photos.ts";
import type { ChannelListingState, ItemFacts, ListingDraft, ModelCall } from "./types.ts";

// The inventory layer. Shopify is the first implementation; a hosted database
// for sellers without Shopify can implement the same interface later. All the
// selling logic talks to InventoryStore, never to Shopify directly.

export interface InventoryPhoto {
  url: string;
  alt: string | null;
  kind: PhotoKind;
  /** For edited photos, the URL of the photo they were made from. */
  sourceUrl?: string;
}

export interface NewPhoto {
  data: Uint8Array;
  mediaType: string;
  alt: string;
  kind: PhotoKind;
  sourceUrl?: string;
}

/** Where an item is in its life, derived from what's been saved. */
export type ItemStage = "needs_details" | "needs_floor" | "ready_to_list" | "listed" | "sold";

export interface InventoryItem {
  id: string;
  title: string;
  photos: InventoryPhoto[];
  /** null when the store isn't tracking quantity for this item. */
  quantity: number | null;
  floorNet: number | null;
  /** What the seller said about it when adding it ("worn twice, runs small"). */
  notes: string | null;
  facts: ItemFacts | null;
  listings: ListingDraft[];
  channels: ChannelListingState[];
  /** Recent AI calls for this item, newest last. */
  aiTrace: ModelCall[];
  stage: ItemStage;
  /** Link to the item in the store's own admin, if there is one. */
  adminUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListItemsOptions {
  stage?: ItemStage;
  limit?: number;
  after?: string;
}

export interface InventoryStore {
  listItems(opts?: ListItemsOptions): Promise<{ items: InventoryItem[]; nextCursor?: string }>;
  getItem(id: string): Promise<InventoryItem | null>;
  saveFacts(id: string, facts: ItemFacts): Promise<void>;
  saveFloor(id: string, floorNet: number): Promise<void>;
  saveListings(id: string, drafts: ListingDraft[]): Promise<void>;
  saveChannelStates(id: string, states: ChannelListingState[]): Promise<void>;
  /** Sets on-hand quantity to zero so the item can't sell twice. */
  zeroQuantity(id: string): Promise<void>;
  /** Creates a new item from the seller's photos (quantity defaults to 1); returns its ID. */
  createItem(title: string, photos: NewPhoto[], notes?: string, quantity?: number): Promise<string>;
  /**
   * Sets on-hand quantity. With `from`, it's compare-and-set: fails if the
   * quantity is no longer `from` (someone else changed it, e.g. another sale).
   */
  setQuantity(id: string, quantity: number, from?: number): Promise<void>;
  renameItem(id: string, title: string): Promise<void>;
  /** Appends AI calls to the item's trace (keeps the most recent ones). */
  appendTrace(id: string, calls: ModelCall[]): Promise<void>;
  /** Attaches processed photos (enhanced, studio, AI) to an item. */
  addPhotos(id: string, photos: NewPhoto[]): Promise<void>;
  /**
   * Puts the item up for sale on the store's own storefront, for stores that
   * have one. Returns the buyer-facing product link.
   */
  publish?(id: string, listing: StorefrontListing): Promise<string>;
}

export interface StorefrontListing {
  title: string;
  /** Plain text; paragraphs separated by blank lines. */
  description: string;
  price: number;
  /** Photo URLs in display order, cover first. */
  photoUrls: string[];
}

export function stageOf(item: Pick<InventoryItem, "facts" | "floorNet" | "channels" | "quantity">): ItemStage {
  if (item.channels.some((c) => c.status === "sold") || item.quantity === 0) return "sold";
  if (!item.facts) return "needs_details";
  if (item.floorNet === null) return "needs_floor";
  if (item.channels.some((c) => c.status === "active")) return "listed";
  return "ready_to_list";
}

/**
 * New channel states after a sale on `soldOn`: the sale channel is marked sold
 * and every other live listing must come down. The store's own listing comes
 * down by itself, since zeroing the quantity takes it off sale.
 */
export function applySale(states: ChannelListingState[], soldOn: ChannelId, now: string): ChannelListingState[] {
  const next = states.map((s): ChannelListingState => {
    if (s.channel === soldOn) return { ...s, status: "sold", updatedAt: now };
    if (s.status === "active" || s.status === "queued") {
      return { ...s, status: s.channel === "shopify" ? "delisted" : "needs_delist", updatedAt: now };
    }
    return s;
  });
  if (!next.some((s) => s.channel === soldOn)) next.push({ channel: soldOn, status: "sold", updatedAt: now });
  return next;
}

export function upsertChannelState(
  states: ChannelListingState[],
  update: Omit<ChannelListingState, "updatedAt">,
  now: string,
): ChannelListingState[] {
  const merged = { ...states.find((s) => s.channel === update.channel), ...update, updatedAt: now };
  return [...states.filter((s) => s.channel !== update.channel), merged];
}

export interface SaleResult {
  item: InventoryItem;
  /** Listings the seller still has to take down, with links where we have them. */
  toDelist: Array<{ channel: ChannelId; name: string; url?: string; automatic: boolean }>;
  /** How many the seller still has. Above 0, every listing stays up. */
  left: number;
}

/**
 * Records a sale. If the seller has more than one, it takes one off and leaves
 * every listing up. Otherwise it zeroes quantity first (the lock), then updates
 * every channel's state.
 */
export async function recordSale(store: InventoryStore, id: string, soldOn: ChannelId): Promise<SaleResult> {
  const item = await store.getItem(id);
  if (!item) throw new Error(`Item ${id} not found`);

  if (item.quantity !== null && item.quantity > 1) {
    const left = item.quantity - 1;
    await store.setQuantity(id, left, item.quantity);
    return { item: { ...item, quantity: left }, toDelist: [], left };
  }

  await store.zeroQuantity(id);
  const states = applySale(item.channels, soldOn, new Date().toISOString());
  await store.saveChannelStates(id, states);

  const toDelist = states
    .filter((s) => s.status === "needs_delist")
    .map((s) => ({
      channel: s.channel,
      name: CHANNELS[s.channel].name,
      url: s.url,
      // Nothing is delisted through an API yet; eBay will flip this once its adapter lands.
      automatic: false,
    }));
  const updated = { ...item, quantity: 0, channels: states, stage: "sold" as const };
  return { item: updated, toDelist, left: 0 };
}
