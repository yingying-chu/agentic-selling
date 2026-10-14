import { test } from "node:test";
import assert from "node:assert/strict";
import { photosForChannel, type ListingPhoto } from "../src/index.ts";

const photos: ListingPhoto[] = [
  { url: "o1", kind: "original", alt: null },
  { url: "o2", kind: "original", alt: null },
  { url: "e1", kind: "enhanced", alt: null, sourceUrl: "o1" },
  { url: "s1", kind: "studio", alt: null, sourceUrl: "o1" },
  { url: "m1", kind: "ai_model", alt: null },
];

test("studio cover first, enhanced replaces its original, AI last with disclosure", () => {
  const { photos: out, disclosure } = photosForChannel(photos, "poshmark");
  assert.deepEqual(out.map((p) => p.url), ["s1", "e1", "o2", "m1"]);
  assert.ok(disclosure);
});

test("platforms that disallow AI images drop them and need no disclosure", () => {
  const { photos: out, disclosure } = photosForChannel(photos, "depop");
  assert.ok(!out.some((p) => p.kind === "ai_model"));
  assert.equal(disclosure, null);
});

test("AI images alone are never enough", () => {
  const { photos: out } = photosForChannel([{ url: "m1", kind: "ai_model", alt: null }], "ebay");
  assert.equal(out.length, 0);
});
