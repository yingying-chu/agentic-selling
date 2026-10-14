import { CHANNELS, type ChannelId } from "./channels.ts";
import { FEE_SCHEDULES, type FeeSchedule } from "./fees.ts";

// Prices are worked out backward from the seller's take-home floor: find the
// lowest sale price that still nets the floor after fees and shipping, then
// pad for the offers buyers on that platform expect.

export interface SaleContext {
  shipping: { paidBy: "buyer" | "seller"; labelCost: number };
  localPickup?: boolean;
}

export interface FeeBreakdown {
  commission: number;
  processing: number;
  fixed: number;
  total: number;
}

export interface ChannelPrice {
  channel: ChannelId;
  /** Price to list at. */
  listPrice: number;
  /** Lowest sale price (after offers) that still clears the floor. Never accept below this. */
  minAcceptPrice: number;
  /** Take-home if it sells at the expected price (list minus typical offer discount). */
  expectedNet: number;
  expectedSalePrice: number;
  fees: FeeBreakdown;
  /** False when comparable sales on this channel sit below what the floor requires. */
  viable: boolean;
  reason?: string;
}

const cents = (n: number) => Math.round(n * 100) / 100;

export function feesFor(price: number, schedule: FeeSchedule, ctx: SaleContext): FeeBreakdown {
  if (ctx.localPickup && schedule.localPickupFree) {
    return { commission: 0, processing: 0, fixed: 0, total: 0 };
  }
  const buyerShipping = ctx.shipping.paidBy === "buyer" ? ctx.shipping.labelCost : 0;
  const base = price + (schedule.appliesToShipping ? buyerShipping : 0);

  let commission =
    schedule.flatUnder && price < schedule.flatUnder.threshold
      ? schedule.flatUnder.fee
      : base * schedule.commissionPercent;
  const processing = base * schedule.processingPercent + schedule.processingFixed;
  const fixed = schedule.fixedPerOrder + (schedule.listingFee ?? 0);

  if (schedule.minFee !== undefined && commission + processing + fixed < schedule.minFee) {
    commission = schedule.minFee - processing - fixed;
  }
  const total = cents(commission + processing + fixed);
  return { commission: cents(commission), processing: cents(processing), fixed: cents(fixed), total };
}

/** What the seller keeps from a sale at `price`. Buyer-paid shipping passes straight through to the label. */
export function netProceeds(price: number, schedule: FeeSchedule, ctx: SaleContext): number {
  const sellerShipping = ctx.shipping.paidBy === "seller" && !ctx.localPickup ? ctx.shipping.labelCost : 0;
  return cents(price - feesFor(price, schedule, ctx).total - sellerShipping);
}

/**
 * Lowest sale price that nets at least `floor`. Scans in cents rather than
 * inverting the formula because tiered fees (Poshmark's flat fee under $15)
 * make net proceeds non-monotonic around the threshold.
 */
export function minSalePriceForFloor(floor: number, schedule: FeeSchedule, ctx: SaleContext): number {
  const start = Math.max(0, Math.floor(floor * 100));
  const limit = start + Math.max(100_000, start * 3);
  for (let c = start; c <= limit; c++) {
    if (netProceeds(c / 100, schedule, ctx) >= floor) return c / 100;
  }
  throw new Error(`No price clears floor $${floor} on ${schedule.channel}`);
}

export interface PriceInput {
  channel: ChannelId;
  /** Seller's take-home floor for this item. */
  floorNet: number;
  ctx: SaleContext;
  /** Typical sold price for comparable items on this channel, if known. */
  marketSoldPrice?: number;
  schedule?: FeeSchedule;
}

export function priceForChannel(input: PriceInput): ChannelPrice {
  const schedule = input.schedule ?? FEE_SCHEDULES[input.channel];
  const cushion = CHANNELS[input.channel].offerCushion;
  const minAcceptPrice = minSalePriceForFloor(input.floorNet, schedule, input.ctx);

  const market = input.marketSoldPrice;
  const viable = market === undefined || market >= minAcceptPrice;
  const targetSale = Math.max(minAcceptPrice, market ?? 0);
  // Whole-dollar list prices; offers land near targetSale.
  const listPrice = Math.ceil(targetSale / (1 - cushion));
  const expectedSalePrice = cents(Math.max(minAcceptPrice, listPrice * (1 - cushion)));

  return {
    channel: input.channel,
    listPrice,
    minAcceptPrice,
    expectedSalePrice,
    expectedNet: netProceeds(expectedSalePrice, schedule, input.ctx),
    fees: feesFor(expectedSalePrice, schedule, input.ctx),
    viable,
    reason: viable
      ? undefined
      : `Comparable items sell for ~$${market} here, but clearing your $${input.floorNet} floor needs at least $${minAcceptPrice}.`,
  };
}
