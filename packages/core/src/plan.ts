import type { ChannelId } from "./channels.ts";
import { priceForChannel, type ChannelPrice, type SaleContext } from "./pricing.ts";
import { routeItem, type RouteDecision } from "./routing.ts";
import type { ItemFacts } from "./types.ts";

// Facts + floor → a price for every channel and which channels to post on.

export interface PlanOptions {
  floorNet: number;
  enabledChannels: ChannelId[];
  /** Estimated shipping label cost. */
  labelCost?: number;
  /** Where the seller can choose who pays shipping. Poshmark and Vinted always charge the buyer. */
  sellerPaysShipping?: boolean;
  /** Known sold price for comparable items; defaults to the midpoint of the facts' estimate. */
  marketSoldPrice?: number;
  maxChannels?: number;
}

export interface ItemPlan {
  prices: Partial<Record<ChannelId, ChannelPrice>>;
  routes: RouteDecision[];
  selected: ChannelId[];
  marketSoldPrice: number;
}

const BUYER_PAYS_ALWAYS: ChannelId[] = ["poshmark", "vinted"];
/** Sold for local pickup only: no platform fee, no shipping. */
export const LOCAL_ONLY: ChannelId[] = ["fb_marketplace"];

export function saleContextFor(channel: ChannelId, opts: Pick<PlanOptions, "labelCost" | "sellerPaysShipping">): SaleContext {
  const sellerPays = opts.sellerPaysShipping && !BUYER_PAYS_ALWAYS.includes(channel);
  return {
    shipping: { paidBy: sellerPays ? "seller" : "buyer", labelCost: opts.labelCost ?? 8 },
    localPickup: LOCAL_ONLY.includes(channel),
  };
}

export function planItem(
  facts: Pick<ItemFacts, "categoryGroups" | "estimatedSoldPriceRange"> & { bulky?: boolean },
  opts: PlanOptions,
): ItemPlan {
  const { low, high } = facts.estimatedSoldPriceRange;
  const market = opts.marketSoldPrice ?? (low + high) / 2;
  const channels: ChannelId[] = ["shopify", ...opts.enabledChannels.filter((c) => c !== "shopify")];
  const prices: Partial<Record<ChannelId, ChannelPrice>> = {};
  for (const c of channels) {
    prices[c] = priceForChannel({ channel: c, floorNet: opts.floorNet, ctx: saleContextFor(c, opts), marketSoldPrice: market });
  }
  const routes = routeItem({
    categoryGroups: facts.categoryGroups,
    bulky: facts.bulky,
    prices,
    enabled: opts.enabledChannels,
    maxChannels: opts.maxChannels,
  });
  return { prices, routes, selected: routes.filter((r) => r.selected).map((r) => r.channel), marketSoldPrice: market };
}
