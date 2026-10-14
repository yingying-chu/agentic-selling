// Static knowledge about each marketplace: how we integrate, listing limits,
// and what sells there. Fees live separately in fees.ts because they change
// more often than anything here.

export const CHANNEL_IDS = [
  "shopify",
  "ebay",
  "poshmark",
  "mercari",
  "depop",
  "vinted",
  "grailed",
  "fb_marketplace",
  "etsy",
] as const;

export type ChannelId = (typeof CHANNEL_IDS)[number];

/** api = official API; extension = automated in the user's own browser session. */
export type Integration = "api" | "extension";

/** Broad buckets used for routing. Apparel-heavy because that is the launch focus. */
export type CategoryGroup =
  | "womens_clothing"
  | "mens_clothing"
  | "shoes"
  | "bags"
  | "accessories"
  | "jewelry"
  | "vintage"
  | "streetwear"
  | "luxury"
  | "kids"
  | "electronics"
  | "home"
  | "furniture"
  | "collectibles"
  | "other";

export interface ChannelProfile {
  id: ChannelId;
  name: string;
  integration: Integration;
  titleMaxLength: number;
  descriptionMaxLength: number;
  maxPhotos: number;
  /**
   * Typical discount buyers expect off list price (offers, bundles, "make an offer").
   * The pricing engine pads list price by this much so accepted offers still clear the floor.
   */
  offerCushion: number;
  /** 0..1 affinity per category group; missing groups score 0. */
  affinity: Partial<Record<CategoryGroup, number>>;
  /** Style notes the listing writer follows for this platform's search and audience. */
  listingStyle: string;
}

export const CHANNELS: Record<ChannelId, ChannelProfile> = {
  shopify: {
    id: "shopify",
    name: "Shopify (source of truth)",
    integration: "api",
    titleMaxLength: 255,
    descriptionMaxLength: 20000,
    maxPhotos: 250,
    offerCushion: 0,
    affinity: {},
    listingStyle:
      "Canonical record. Clean, factual title (Brand + Item + Key attribute + Size). Full structured description with measurements and condition.",
  },
  ebay: {
    id: "ebay",
    name: "eBay",
    integration: "api",
    titleMaxLength: 80,
    descriptionMaxLength: 500000,
    maxPhotos: 24,
    offerCushion: 0.1,
    affinity: {
      mens_clothing: 0.9,
      womens_clothing: 0.7,
      shoes: 0.9,
      bags: 0.8,
      accessories: 0.8,
      jewelry: 0.7,
      vintage: 0.9,
      luxury: 0.7,
      electronics: 1,
      collectibles: 1,
      home: 0.7,
      other: 0.7,
    },
    listingStyle:
      "Keyword-dense title using all 80 chars: Brand, model/style name, item type, gender, size, color, material, notable feature. No emojis or filler words. Fill item specifics completely; buyers filter on them.",
  },
  poshmark: {
    id: "poshmark",
    name: "Poshmark",
    integration: "extension",
    titleMaxLength: 80,
    descriptionMaxLength: 1500,
    maxPhotos: 16,
    offerCushion: 0.25,
    affinity: {
      womens_clothing: 1,
      mens_clothing: 0.6,
      shoes: 0.8,
      bags: 0.9,
      accessories: 0.8,
      jewelry: 0.6,
      luxury: 0.7,
      kids: 0.6,
      home: 0.3,
    },
    listingStyle:
      "Title: Brand + item + standout detail, readable not keyword-stuffed. Description is friendly and scannable: condition, measurements, fabric, fit notes. Brand and size fields matter more than title keywords.",
  },
  mercari: {
    id: "mercari",
    name: "Mercari",
    integration: "extension",
    titleMaxLength: 80,
    descriptionMaxLength: 1000,
    maxPhotos: 12,
    offerCushion: 0.15,
    affinity: {
      womens_clothing: 0.7,
      mens_clothing: 0.7,
      shoes: 0.7,
      bags: 0.7,
      accessories: 0.7,
      electronics: 0.8,
      collectibles: 0.8,
      kids: 0.7,
      home: 0.6,
      other: 0.6,
    },
    listingStyle:
      "Short, keyword-forward title. Description front-loads condition and key specs; Mercari search indexes description text, so include common search terms naturally.",
  },
  depop: {
    id: "depop",
    name: "Depop",
    integration: "extension",
    titleMaxLength: 0, // Depop has no separate title; the description's first line acts as one.
    descriptionMaxLength: 1000,
    maxPhotos: 8,
    offerCushion: 0.15,
    affinity: {
      womens_clothing: 0.8,
      mens_clothing: 0.7,
      streetwear: 1,
      vintage: 1,
      accessories: 0.7,
      shoes: 0.6,
      bags: 0.6,
    },
    listingStyle:
      "Gen-Z voice, casual and aesthetic-driven. First line works as the title. Use style/aesthetic terms buyers search (y2k, 90s, grunge, coquette, etc.) only when accurate. End with up to 5 relevant hashtags.",
  },
  vinted: {
    id: "vinted",
    name: "Vinted",
    integration: "extension",
    titleMaxLength: 100,
    descriptionMaxLength: 2000,
    maxPhotos: 20,
    offerCushion: 0.15,
    affinity: {
      womens_clothing: 0.9,
      mens_clothing: 0.7,
      kids: 0.9,
      shoes: 0.6,
      bags: 0.6,
      accessories: 0.6,
    },
    listingStyle:
      "Plain, honest, concise. Title: Brand + item + size. Buyers are price-sensitive; mention flaws clearly.",
  },
  grailed: {
    id: "grailed",
    name: "Grailed",
    integration: "extension",
    titleMaxLength: 60,
    descriptionMaxLength: 3000,
    maxPhotos: 25,
    offerCushion: 0.15,
    affinity: {
      mens_clothing: 1,
      streetwear: 1,
      luxury: 0.9,
      shoes: 0.8,
      vintage: 0.7,
      accessories: 0.5,
    },
    listingStyle:
      "Menswear enthusiast audience. Precise designer/collection/season names, exact measurements (pit to pit, length), fit and fabric details. No hype language.",
  },
  fb_marketplace: {
    id: "fb_marketplace",
    name: "Facebook Marketplace",
    integration: "extension",
    titleMaxLength: 100,
    descriptionMaxLength: 5000,
    maxPhotos: 10,
    offerCushion: 0.2,
    affinity: {
      furniture: 1,
      home: 0.9,
      electronics: 0.7,
      kids: 0.6,
      other: 0.6,
      womens_clothing: 0.2,
      mens_clothing: 0.2,
    },
    listingStyle:
      "Local buyers skimming on phones. Plain title of what it is plus brand. Short description: condition, dimensions, pickup/shipping terms.",
  },
  etsy: {
    id: "etsy",
    name: "Etsy",
    integration: "api",
    titleMaxLength: 140,
    descriptionMaxLength: 10000,
    maxPhotos: 20,
    offerCushion: 0,
    affinity: { vintage: 0.9, jewelry: 0.6, home: 0.5 },
    listingStyle:
      "Only vintage (20+ years old), handmade, or craft supplies are allowed. Descriptive, search-friendly title; 13 tags; story-driven description including era and provenance.",
  },
};
