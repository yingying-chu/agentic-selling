// Detects whether a marketplace listing is still for sale from its public
// page. Marketplaces publish schema.org product data (JSON-LD) on listing pages
// for search engines; its Offer.availability flips from InStock to SoldOut /
// OutOfStock when the item sells. That's a stable, documented signal, unlike
// page layout, and needs no login.
//
// Only the JSON-LD blocks are read, and only the first Product in them: listing
// pages also carry other sellers' items (recommendations, "similar sold"), and
// matching loose text could mistake someone else's sale for ours.

import type { ChannelId } from "./channels.ts";
import { recordSale, type InventoryStore, type SaleResult } from "./inventory.ts";

export type Availability = "for_sale" | "sold" | "unknown";

const SOLD = /(SoldOut|OutOfStock|Discontinued|SoldOutOnline)$/i;
const FOR_SALE = /(InStock|LimitedAvailability|OnlineOnly|InStoreOnly|PreOrder)$/i;

type Json = Record<string, unknown>;

function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      blocks.push(JSON.parse(m[1]!.trim()));
    } catch {
      // Malformed block; ignore it.
    }
  }
  return blocks;
}

function findProduct(node: unknown): Json | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const p = findProduct(n);
      if (p) return p;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const obj = node as Json;
  const type = obj["@type"];
  if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return obj;
  return findProduct(obj["@graph"]);
}

export function availabilityFromHtml(html: string): Availability {
  for (const block of jsonLdBlocks(html)) {
    const product = findProduct(block);
    if (!product) continue;
    const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    const raw = offers && typeof offers === "object" ? (offers as Json).availability : undefined;
    if (typeof raw !== "string") return "unknown";
    if (SOLD.test(raw)) return "sold";
    if (FOR_SALE.test(raw)) return "for_sale";
    return "unknown";
  }
  return "unknown";
}

export interface ListingCheck {
  itemId: string;
  title: string;
  channel: ChannelId;
  url: string;
  availability: Availability;
}

/**
 * Checks every live listing that has a link. The first one found sold wins:
 * the item is locked (quantity 0) and every other live listing is flagged for
 * takedown. "unknown" never changes anything.
 */
export async function syncSales(
  store: InventoryStore,
  fetchHtml: (url: string) => Promise<string | null>,
): Promise<{ checked: ListingCheck[]; sold: Array<SaleResult & { soldOn: ChannelId }> }> {
  const checked: ListingCheck[] = [];
  const sold: Array<SaleResult & { soldOn: ChannelId }> = [];
  const { items } = await store.listItems({ stage: "listed", limit: 100 });

  for (const item of items) {
    for (const listing of item.channels.filter((c) => c.status === "active" && c.url)) {
      const html = await fetchHtml(listing.url!);
      const availability = html ? availabilityFromHtml(html) : "unknown";
      checked.push({ itemId: item.id, title: item.facts?.title ?? item.title, channel: listing.channel, url: listing.url!, availability });
      if (availability === "sold") {
        sold.push({ ...(await recordSale(store, item.id, listing.channel)), soldOn: listing.channel });
        break;
      }
    }
  }
  return { checked, sold };
}
