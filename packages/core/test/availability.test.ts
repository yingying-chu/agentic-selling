import { test } from "node:test";
import assert from "node:assert/strict";
import { availabilityFromHtml } from "../src/index.ts";

const ld = (availability: string) =>
  `<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","availability":"${availability}"}}</script>`;

test("schema.org InStock means still for sale", () => {
  assert.equal(availabilityFromHtml(ld("https://schema.org/InStock")), "for_sale");
  assert.equal(availabilityFromHtml(ld("InStock")), "for_sale");
});

test("schema.org SoldOut / OutOfStock means sold", () => {
  assert.equal(availabilityFromHtml(ld("https://schema.org/SoldOut")), "sold");
  assert.equal(availabilityFromHtml(ld("http://schema.org/OutOfStock")), "sold");
});

test("other items on the page can't make ours look sold", () => {
  const page = `${ld("https://schema.org/InStock")}<div>{"availability":"SoldOut","is_closed":true}</div>`;
  assert.equal(availabilityFromHtml(page), "for_sale");
});

test("pages without a signal are unknown, never assumed sold", () => {
  assert.equal(availabilityFromHtml("<html><body>Please verify you are human</body></html>"), "unknown");
});

test("syncSales locks the item and flags the other listing when one sells", async () => {
  const { syncSales } = await import("../src/index.ts");
  const t = "2026-10-14T00:00:00Z";
  const item = {
    id: "1", title: "Cap", photos: [], quantity: 1, floorNet: 10, notes: null, facts: null, listings: [], aiTrace: [],
    channels: [
      { channel: "poshmark", status: "active", url: "https://posh/1", updatedAt: t },
      { channel: "vinted", status: "active", url: "https://vinted/1", updatedAt: t },
    ],
    stage: "listed", createdAt: t, updatedAt: t,
  } as any;
  let saved: any[] = [];
  const store = {
    listItems: async () => ({ items: [item] }),
    getItem: async () => item,
    zeroQuantity: async () => void (item.quantity = 0),
    saveChannelStates: async (_: string, s: any[]) => void (saved = s),
  } as any;
  const pages: Record<string, string> = { "https://posh/1": ld("https://schema.org/InStock"), "https://vinted/1": ld("https://schema.org/SoldOut") };
  const { sold, checked } = await syncSales(store, async (u) => pages[u] ?? null);
  assert.equal(checked.length, 2);
  assert.equal(sold[0]?.soldOn, "vinted");
  assert.equal(item.quantity, 0);
  assert.equal(saved.find((s) => s.channel === "poshmark").status, "needs_delist");
});

test("syncSales does nothing when pages can't be read", async () => {
  const { syncSales } = await import("../src/index.ts");
  const item = { id: "1", title: "Cap", quantity: 1, channels: [{ channel: "poshmark", status: "active", url: "u", updatedAt: "" }] } as any;
  let touched = false;
  const store = { listItems: async () => ({ items: [item] }), zeroQuantity: async () => void (touched = true) } as any;
  const { sold } = await syncSales(store, async () => null);
  assert.equal(sold.length, 0);
  assert.equal(touched, false);
});
