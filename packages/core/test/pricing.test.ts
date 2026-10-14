import { test } from "node:test";
import assert from "node:assert/strict";
import { FEE_SCHEDULES, feesFor, minSalePriceForFloor, netProceeds, priceForChannel, routeItem } from "../src/index.ts";

const buyerShips = { shipping: { paidBy: "buyer" as const, labelCost: 0 } };

test("poshmark: 20% over $15, flat $2.95 under", () => {
  assert.equal(feesFor(100, FEE_SCHEDULES.poshmark, buyerShips).total, 20);
  assert.equal(feesFor(10, FEE_SCHEDULES.poshmark, buyerShips).total, 2.95);
});

test("poshmark floor near the $15 threshold handles the non-monotonic fee", () => {
  // $14.99 nets 12.04, $15.00 nets 12.00. A $12.02 floor is reachable just under $15.
  const p = minSalePriceForFloor(12.02, FEE_SCHEDULES.poshmark, buyerShips);
  assert.equal(p, 14.97);
  assert.ok(netProceeds(p, FEE_SCHEDULES.poshmark, buyerShips) >= 12.02);
});

test("min sale price clears the floor and one cent less does not", () => {
  for (const ch of ["ebay", "poshmark", "mercari", "depop", "grailed", "etsy"] as const) {
    const ctx = { shipping: { paidBy: "seller" as const, labelCost: 8 } };
    const p = minSalePriceForFloor(40, FEE_SCHEDULES[ch], ctx);
    assert.ok(netProceeds(p, FEE_SCHEDULES[ch], ctx) >= 40, ch);
    assert.ok(netProceeds(p - 0.01, FEE_SCHEDULES[ch], ctx) < 40, ch);
  }
});

test("ebay charges commission on buyer-paid shipping", () => {
  const withShip = feesFor(50, FEE_SCHEDULES.ebay, { shipping: { paidBy: "buyer", labelCost: 10 } });
  const noShip = feesFor(50, FEE_SCHEDULES.ebay, buyerShips);
  assert.ok(withShip.total > noShip.total);
});

test("fb local pickup is free; shipped has a minimum fee", () => {
  assert.equal(feesFor(5, FEE_SCHEDULES.fb_marketplace, { ...buyerShips, localPickup: true }).total, 0);
  assert.equal(feesFor(5, FEE_SCHEDULES.fb_marketplace, buyerShips).total, 0.8);
});

test("list price leaves room for offers but expected sale still clears floor", () => {
  const p = priceForChannel({ channel: "poshmark", floorNet: 40, ctx: buyerShips });
  assert.ok(p.listPrice > p.minAcceptPrice);
  assert.ok(p.expectedNet >= 40);
  assert.equal(p.viable, true);
});

test("market price below floor marks channel not viable", () => {
  const p = priceForChannel({ channel: "mercari", floorNet: 100, ctx: buyerShips, marketSoldPrice: 60 });
  assert.equal(p.viable, false);
  assert.match(p.reason ?? "", /floor/);
});

test("routing: womens dress favors poshmark, skips etsy and fb", () => {
  const prices = Object.fromEntries(
    (["ebay", "poshmark", "mercari", "depop", "vinted"] as const).map((c) => [
      c,
      priceForChannel({ channel: c, floorNet: 30, ctx: buyerShips }),
    ]),
  );
  const routes = routeItem({
    categoryGroups: ["womens_clothing"],
    prices,
    enabled: ["ebay", "poshmark", "mercari", "depop", "vinted", "etsy", "fb_marketplace"],
  });
  const selected = routes.filter((r) => r.selected).map((r) => r.channel);
  assert.equal(selected[0], "poshmark");
  assert.ok(!selected.includes("etsy"));
  assert.ok(!selected.includes("fb_marketplace"));
});

test("routing never selects a channel the item can't clear the floor on", () => {
  const prices = { ebay: priceForChannel({ channel: "ebay", floorNet: 100, ctx: buyerShips, marketSoldPrice: 40 }) };
  const routes = routeItem({ categoryGroups: ["mens_clothing"], prices, enabled: ["ebay", "grailed"] });
  assert.equal(routes.find((r) => r.channel === "ebay")?.selected, false);
  assert.equal(routes.find((r) => r.channel === "grailed")?.selected, true);
});
