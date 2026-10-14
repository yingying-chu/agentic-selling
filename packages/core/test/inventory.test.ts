import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySale,
  recordSale,
  stageOf,
  upsertChannelState,
  type ChannelListingState,
  type InventoryItem,
  type InventoryStore,
} from "../src/index.ts";

const t = "2026-10-14T00:00:00.000Z";

test("applySale marks the sale channel sold and live listings needs_delist", () => {
  const states: ChannelListingState[] = [
    { channel: "poshmark", status: "active", updatedAt: t, url: "https://poshmark.com/listing/1" },
    { channel: "mercari", status: "active", updatedAt: t },
    { channel: "depop", status: "draft", updatedAt: t },
  ];
  const next = applySale(states, "poshmark", "now");
  assert.equal(next.find((s) => s.channel === "poshmark")?.status, "sold");
  assert.equal(next.find((s) => s.channel === "mercari")?.status, "needs_delist");
  assert.equal(next.find((s) => s.channel === "depop")?.status, "draft");
});

test("applySale adds the sale channel if it wasn't tracked", () => {
  const next = applySale([{ channel: "ebay", status: "active", updatedAt: t }], "fb_marketplace", "now");
  assert.equal(next.find((s) => s.channel === "fb_marketplace")?.status, "sold");
  assert.equal(next.find((s) => s.channel === "ebay")?.status, "needs_delist");
});

test("upsertChannelState keeps earlier fields like url", () => {
  const next = upsertChannelState(
    [{ channel: "mercari", status: "active", url: "https://mercari.com/x", updatedAt: t }],
    { channel: "mercari", status: "delisted" },
    "now",
  );
  assert.deepEqual(next, [{ channel: "mercari", status: "delisted", url: "https://mercari.com/x", updatedAt: "now" }]);
});

test("stageOf follows the item through its life", () => {
  const base = { facts: null, floorNet: null, channels: [], quantity: 1 };
  assert.equal(stageOf(base), "needs_details");
  const facts = {} as InventoryItem["facts"];
  assert.equal(stageOf({ ...base, facts }), "needs_floor");
  assert.equal(stageOf({ ...base, facts, floorNet: 20 }), "ready_to_list");
  assert.equal(stageOf({ ...base, facts, floorNet: 20, channels: [{ channel: "ebay", status: "active", updatedAt: t }] }), "listed");
  assert.equal(stageOf({ ...base, facts, floorNet: 20, quantity: 0 }), "sold");
});

test("recordSale zeroes quantity before touching channel states", async () => {
  const calls: string[] = [];
  const item: InventoryItem = {
    id: "1", title: "Dress", photos: [], quantity: 1, floorNet: 20, notes: null, facts: null, listings: [],
    channels: [
      { channel: "poshmark", status: "active", updatedAt: t },
      { channel: "mercari", status: "active", url: "https://mercari.com/x", updatedAt: t },
    ],
    stage: "listed", createdAt: t, updatedAt: t,
  };
  const store = {
    getItem: async () => item,
    zeroQuantity: async () => void calls.push("zero"),
    saveChannelStates: async () => void calls.push("states"),
  } as unknown as InventoryStore;
  const res = await recordSale(store, "1", "poshmark");
  assert.deepEqual(calls, ["zero", "states"]);
  assert.deepEqual(res.toDelist.map((d) => [d.channel, d.url]), [["mercari", "https://mercari.com/x"]]);
});
