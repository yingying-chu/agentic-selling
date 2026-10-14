import {
  CHANNELS,
  priceForChannel,
  routeItem,
  type ChannelId,
  type ChannelPrice,
  type ItemFacts,
  type ListingDraft,
  type RouteDecision,
  type SaleContext,
} from "@agentic-selling/core";
import { preparePhotos } from "./claude.ts";
import { identifyItem } from "./identify.ts";
import { writeListings } from "./listings.ts";

// Photos in, everything needed to list out: item facts, per-channel prices,
// which channels to use, and a listing draft for each. Nothing is posted.

export interface IntakeInput {
  photoPaths: string[];
  /** Take-home floor in USD. */
  floorNet: number;
  sellerNotes?: string;
  /** Estimated shipping label cost for this item. */
  labelCost?: number;
  /** Where the seller can choose, who pays shipping. Poshmark and Vinted always charge the buyer. */
  sellerPaysShipping?: boolean;
  enabledChannels: ChannelId[];
}

export interface IntakeResult {
  facts: ItemFacts;
  prices: Partial<Record<ChannelId, ChannelPrice>>;
  routes: RouteDecision[];
  drafts: ListingDraft[];
  createdAt: string;
}

const BUYER_PAYS_ALWAYS: ChannelId[] = ["poshmark", "vinted"];

function saleContext(channel: ChannelId, input: IntakeInput): SaleContext {
  const sellerPays = input.sellerPaysShipping && !BUYER_PAYS_ALWAYS.includes(channel);
  return { shipping: { paidBy: sellerPays ? "seller" : "buyer", labelCost: input.labelCost ?? 8 } };
}

export async function runIntake(input: IntakeInput, log: (msg: string) => void = () => {}): Promise<IntakeResult> {
  log(`Preparing ${input.photoPaths.length} photos`);
  const photos = await preparePhotos(input.photoPaths);

  log("Identifying item");
  const facts = await identifyItem(photos, input.sellerNotes);

  // Until real comps are wired in, use the midpoint of the model's estimate as the market price.
  const market = (facts.estimatedSoldPriceRange.low + facts.estimatedSoldPriceRange.high) / 2;
  const channels: ChannelId[] = ["shopify", ...input.enabledChannels.filter((c) => c !== "shopify")];
  const prices = Object.fromEntries(
    channels.map((c) => [
      c,
      priceForChannel({ channel: c, floorNet: input.floorNet, ctx: saleContext(c, input), marketSoldPrice: market }),
    ]),
  ) as Partial<Record<ChannelId, ChannelPrice>>;

  const routes = routeItem({ categoryGroups: facts.categoryGroups, prices, enabled: input.enabledChannels });
  const selected = routes.filter((r) => r.selected).map((r) => r.channel);

  log(`Writing listings for Shopify + ${selected.map((c) => CHANNELS[c].name).join(", ") || "no other channels"}`);
  const drafts = await writeListings(facts, prices, ["shopify", ...selected]);

  return { facts, prices, routes, drafts, createdAt: new Date().toISOString() };
}
