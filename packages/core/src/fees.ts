import type { ChannelId } from "./channels.ts";

// Seller-side fee schedules (US). Marketplaces change these often, so every
// entry records when it was last checked and how sure we are. Treat
// "estimate" rows as placeholders until checked against the platform's own
// fee page, and re-review on a schedule.

export interface FeeSchedule {
  channel: ChannelId;
  /** Commission on the sale, as a fraction (0.2 = 20%). */
  commissionPercent: number;
  /** Fixed per-order fee (e.g. eBay's per-order fee). */
  fixedPerOrder: number;
  processingPercent: number;
  processingFixed: number;
  /** Commission and processing are also charged on buyer-paid shipping. */
  appliesToShipping: boolean;
  /** Flat fee instead of commission below a price threshold (Poshmark). */
  flatUnder?: { threshold: number; fee: number };
  /** Minimum total fee per order (FB shipped orders). */
  minFee?: number;
  /** Fees waived for local pickup (FB Marketplace). */
  localPickupFree?: boolean;
  /** Per-listing insertion fee (Etsy). */
  listingFee?: number;
  lastReviewed: string;
  confidence: "verified" | "estimate";
  notes?: string;
}

export const FEE_SCHEDULES: Record<ChannelId, FeeSchedule> = {
  shopify: {
    channel: "shopify",
    commissionPercent: 0,
    fixedPerOrder: 0,
    processingPercent: 0.029,
    processingFixed: 0.3,
    appliesToShipping: true,
    lastReviewed: "2026-10-14",
    confidence: "estimate",
    notes: "Shopify Payments on Basic plan; varies by plan.",
  },
  ebay: {
    channel: "ebay",
    commissionPercent: 0.136,
    fixedPerOrder: 0.4,
    processingPercent: 0,
    processingFixed: 0,
    appliesToShipping: true,
    lastReviewed: "2026-10-14",
    confidence: "estimate",
    notes:
      "Most categories incl. clothing. Category exceptions exist (e.g. sneakers and handbags above certain prices). Store subscriptions lower this.",
  },
  poshmark: {
    channel: "poshmark",
    commissionPercent: 0.2,
    fixedPerOrder: 0,
    processingPercent: 0,
    processingFixed: 0,
    appliesToShipping: false,
    flatUnder: { threshold: 15, fee: 2.95 },
    lastReviewed: "2026-10-14",
    confidence: "estimate",
    notes: "Buyer pays the flat shipping label.",
  },
  mercari: {
    channel: "mercari",
    commissionPercent: 0.1,
    fixedPerOrder: 0,
    processingPercent: 0,
    processingFixed: 0,
    appliesToShipping: true,
    lastReviewed: "2026-10-14",
    confidence: "estimate",
    notes:
      "2026 sources disagree on whether a separate ~2.9% + $0.30-0.50 processing fee still applies. Check a real payout breakdown.",
  },
  depop: {
    channel: "depop",
    commissionPercent: 0,
    fixedPerOrder: 0,
    processingPercent: 0.033,
    processingFixed: 0.45,
    appliesToShipping: true,
    lastReviewed: "2026-10-14",
    confidence: "estimate",
    notes: "US: no selling fee since 2024; payment processing only. Boosted listings cost extra.",
  },
  vinted: {
    channel: "vinted",
    commissionPercent: 0,
    fixedPerOrder: 0,
    processingPercent: 0,
    processingFixed: 0,
    appliesToShipping: false,
    lastReviewed: "2026-10-14",
    confidence: "estimate",
    notes: "No seller fee; buyer pays a protection fee.",
  },
  grailed: {
    channel: "grailed",
    commissionPercent: 0.09,
    fixedPerOrder: 0,
    processingPercent: 0.0349,
    processingFixed: 0.49,
    appliesToShipping: true,
    lastReviewed: "2026-10-14",
    confidence: "estimate",
  },
  fb_marketplace: {
    channel: "fb_marketplace",
    commissionPercent: 0.1,
    fixedPerOrder: 0,
    processingPercent: 0,
    processingFixed: 0,
    appliesToShipping: true,
    minFee: 0.8,
    localPickupFree: true,
    lastReviewed: "2026-10-14",
    confidence: "estimate",
    notes: "Shipped orders only; local pickup has no fee.",
  },
  etsy: {
    channel: "etsy",
    commissionPercent: 0.065,
    fixedPerOrder: 0,
    processingPercent: 0.03,
    processingFixed: 0.25,
    appliesToShipping: true,
    listingFee: 0.2,
    lastReviewed: "2026-10-14",
    confidence: "estimate",
    notes: "Offsite ads can add 12-15% on attributed sales.",
  },
};
