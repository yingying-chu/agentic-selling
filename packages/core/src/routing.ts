import { CHANNELS, CHANNEL_IDS, type CategoryGroup, type ChannelId } from "./channels.ts";
import type { ChannelPrice } from "./pricing.ts";

// Decides which marketplaces an item goes to. Deterministic on purpose: the
// model describes the item, this code makes the routing call, so the choice
// is explainable and easy to override.

export interface RouteDecision {
  channel: ChannelId;
  score: number;
  selected: boolean;
  reason: string;
}

export interface RouteInput {
  categoryGroups: CategoryGroup[];
  /** Too big or heavy to ship affordably: only local-pickup channels qualify. */
  bulky?: boolean;
  prices: Partial<Record<ChannelId, ChannelPrice>>;
  /** Channels the seller has connected; others are never selected. */
  enabled: ChannelId[];
  maxChannels?: number;
  minScore?: number;
}

export function routeItem(input: RouteInput): RouteDecision[] {
  const maxChannels = input.maxChannels ?? 5;
  const minScore = input.minScore ?? 0.5;
  const isVintage = input.categoryGroups.includes("vintage");

  const scored = CHANNEL_IDS.filter((id) => id !== "shopify").map((id): RouteDecision => {
    const profile = CHANNELS[id];
    const affinity = Math.max(0, ...input.categoryGroups.map((g) => profile.affinity[g] ?? 0));
    const price = input.prices[id];

    if (!input.enabled.includes(id)) return { channel: id, score: 0, selected: false, reason: "Not connected" };
    if (input.bulky && id !== "fb_marketplace") {
      return { channel: id, score: 0, selected: false, reason: "Too bulky to ship affordably; sell it locally" };
    }
    if (id === "etsy" && !isVintage) {
      return { channel: id, score: 0, selected: false, reason: "Etsy only allows vintage, handmade, or craft supplies" };
    }
    if (price && !price.viable) return { channel: id, score: 0, selected: false, reason: price.reason ?? "Below floor" };
    if (affinity === 0) return { channel: id, score: 0, selected: false, reason: "Category doesn't sell here" };

    // Small bonus for higher take-home so ties go to the better-paying channel.
    const netBonus = price ? Math.min(0.1, price.expectedNet / 1000) : 0;
    return { channel: id, score: Math.round((affinity + netBonus) * 100) / 100, selected: false, reason: "" };
  });

  scored.sort((a, b) => b.score - a.score);
  let picked = 0;
  for (const d of scored) {
    if (d.score >= minScore && picked < maxChannels) {
      d.selected = true;
      picked++;
      d.reason = `Strong fit (score ${d.score})`;
    } else if (!d.reason) {
      d.reason = d.score < minScore ? `Weak fit (score ${d.score})` : "Over the channel limit";
    }
  }
  return scored;
}
