import type { CategoryGroup, ChannelId } from "./channels.ts";
import type { ChannelPrice } from "./pricing.ts";

export type Condition = "new_with_tags" | "new_without_tags" | "excellent" | "good" | "fair" | "poor";

/** What the intake agent learns from photos plus the seller's notes. */
export interface ItemFacts {
  title: string;
  brand: string | null;
  itemType: string;
  categoryGroups: CategoryGroup[];
  department: "women" | "men" | "unisex" | "kids" | "none";
  size: string | null;
  colors: string[];
  materials: string[];
  condition: Condition;
  flaws: string[];
  measurements: Array<{ name: string; value: string }>;
  styleKeywords: string[];
  /** Approximate era, only when the photos or tags support it. */
  era: string | null;
  /** Rough resale estimate from the model's own knowledge, before real comps are pulled. */
  estimatedSoldPriceRange: { low: number; high: number; currency: "USD" };
  confidence: "high" | "medium" | "low";
  /** Things the seller should confirm (tag unreadable, possible counterfeit risk, etc.). */
  questionsForSeller: string[];
}

export interface ListingDraft {
  channel: ChannelId;
  title: string;
  description: string;
  tags: string[];
  /** Platform category path as best guessed; adapters map it to real category IDs. */
  categoryHint: string;
  price: ChannelPrice;
}

/**
 * needs_delist: the item sold elsewhere and this listing must come down. For
 * platforms without an API the seller does it by hand, so it stays here until
 * they confirm.
 */
export type ListingStatus = "draft" | "queued" | "active" | "sold" | "needs_delist" | "delisted" | "error";

/** Per-channel state, stored as a Shopify metafield on the product. */
export interface ChannelListingState {
  channel: ChannelId;
  status: ListingStatus;
  externalId?: string;
  /** Link to the listing (or its edit page) on the platform. */
  url?: string;
  listedPrice?: number;
  updatedAt: string;
  error?: string;
}

/** One AI call as served through the gateway: which model answered, where, how fast, at what cost. */
export interface ModelCall {
  task: string;
  requested: string;
  servedBy: string;
  provider: string | null;
  fellBack: boolean;
  failed: string[];
  ms: number;
  costUsd: number | null;
}
