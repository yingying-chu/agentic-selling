import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ItemFactsSchema } from "@agentic-selling/agents";
import {
  CHANNELS,
  CHANNEL_IDS,
  photosForChannel,
  type InventoryItem,
  type InventoryStore,
  type ItemStage,
} from "@agentic-selling/core";
import { makeListingPhotos } from "../phone.server";
import {
  confirmDelisted,
  getSettings,
  markPosted,
  markSold,
  planFor,
  POST_LINKS,
  saveListingTexts,
  updateSettings,
} from "../selling.server";

// The tools a chat assistant uses to sell on the seller's behalf. The
// assistant does the seeing and writing; these tools hold the parts that must
// be exact: prices, platform rules, saved state, and the sale lock.

export const INSTRUCTIONS = `You help a casual seller sell clothes, shoes, accessories and other things they no longer need. Their items live in their private Shopify store; each item is a product with photos.

Typical flow:
1. list_items to see what needs work. New items are at stage "needs_details".
2. get_item to see the photos. Identify the item yourself: read every tag and label, note every flaw. Ask the seller about anything you can't confirm (size, fabric, authenticity). Then save_item_details.
3. If there's no floor price, ask: "What's the least you'd be happy to walk away with after fees and shipping?" Then set_floor_price.
4. plan_item for each platform's price and the recommended platforms. Explain briefly, in plain words.
5. get_listing_guide for the recommended platforms, write a listing for each following its rules, then save_listings.
6. improve_photos once per item for listing-ready photos (corrected, studio cover, AI model shot; every edit is checked against the originals).
7. To post: get_posting_kit for the platform. If you can control the seller's browser (e.g. Claude in Chrome), open the kit's postUrl in their logged-in session, fill every field from the kit, attach the photos, and stop before the final Post/Publish button so the seller confirms. Never log in for them or type their password. Otherwise hand them the kit to copy. Afterwards mark_posted with the listing link.
8. When something sells: mark_sold right away (this locks the item so it can't sell twice), then walk them through taking down each remaining listing and confirm_delisted for each.

Be honest in listings: never invent brand, material, or measurements, and always disclose flaws. Never tell the seller to accept an offer below the plan's minimum.`;

const itemId = z.string().describe("Product ID from list_items (numeric or gid://shopify/Product/...)");
const channel = z.enum(CHANNEL_IDS).describe("Marketplace");
const STAGES = ["needs_details", "needs_floor", "ready_to_list", "listed", "sold"] as const satisfies readonly ItemStage[];

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (label: string, data: unknown) => text(`${label}\n${JSON.stringify(data, null, 2)}`);

function summary(i: InventoryItem) {
  return {
    id: i.id.split("/").pop(),
    title: i.facts?.title ?? i.title,
    stage: i.stage,
    photos: i.photos.length,
    floor: i.floorNet,
    channels: i.channels.map((c) => `${c.channel}:${c.status}`),
  };
}

export function registerTools(server: McpServer, store: InventoryStore, shop: string) {
  const load = async (id: string) => {
    const item = await store.getItem(id);
    if (!item) throw new Error(`No item with ID ${id}. Use list_items to find IDs.`);
    return item;
  };

  server.registerTool(
    "list_items",
    {
      title: "List items",
      description: "The seller's items, newest first, with the stage each is at. Optionally filter by stage.",
      inputSchema: z.object({ stage: z.enum(STAGES).optional() }),
    },
    async ({ stage }) => {
      const { items } = await store.listItems({ stage });
      if (!items.length) {
        return text(
          stage
            ? `No items at stage ${stage}.`
            : "No items yet. The seller can add one by taking photos in the Shopify app (Products → Add product).",
        );
      }
      return json(`${items.length} items:`, items.map(summary));
    },
  );

  server.registerTool(
    "get_item",
    {
      title: "Get item",
      description: "Full details for one item, including its photos so you can see it.",
      inputSchema: z.object({ item_id: itemId, include_photos: z.boolean().default(true) }),
    },
    async ({ item_id, include_photos }) => {
      const item = await load(item_id);
      const images = include_photos
        ? await Promise.all(
            item.photos.slice(0, 6).map(async (p) => {
              const res = await fetch(p.url);
              const mimeType = res.headers.get("content-type") ?? "image/jpeg";
              return { type: "image" as const, data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType };
            }),
          )
        : [];
      const { photos, ...rest } = item;
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...rest, photoCount: photos.length }, null, 2) }, ...images] };
    },
  );

  server.registerTool(
    "save_item_details",
    {
      title: "Save item details",
      description:
        "Save what you identified from the photos and the seller's answers. estimatedSoldPriceRange is what it realistically sells for used in the US.",
      inputSchema: z.object({ item_id: itemId, details: ItemFactsSchema }),
    },
    async ({ item_id, details }) => {
      const item = await load(item_id);
      await store.saveFacts(item.id, details);
      return text(item.floorNet === null ? "Saved. Next: ask the seller for their take-home floor." : "Saved. Next: plan_item.");
    },
  );

  server.registerTool(
    "set_floor_price",
    {
      title: "Set floor price",
      description: "The least the seller wants to keep after fees and shipping, in USD.",
      inputSchema: z.object({ item_id: itemId, take_home_floor: z.number().positive() }),
    },
    async ({ item_id, take_home_floor }) => {
      const item = await load(item_id);
      await store.saveFloor(item.id, take_home_floor);
      return text(`Floor set to $${take_home_floor}.`);
    },
  );

  server.registerTool(
    "plan_item",
    {
      title: "Plan pricing and platforms",
      description:
        "Price on every platform the seller uses (list price, lowest offer to accept, what they keep) and which platforms to post on.",
      inputSchema: z.object({ item_id: itemId }),
    },
    async ({ item_id }) => {
      const item = await load(item_id);
      const plan = planFor(item, await getSettings(shop));
      if ("missing" in plan) return text(`Can't plan yet: missing ${plan.missing}.`);
      return json(
        `Estimated sold price used: $${plan.marketSoldPrice}. Fees are estimates.`,
        plan.routes.map((r) => {
          const p = plan.prices[r.channel];
          return {
            platform: CHANNELS[r.channel].name,
            channel: r.channel,
            recommended: r.selected,
            why: r.reason,
            listPrice: p?.listPrice,
            acceptOffersFrom: p?.minAcceptPrice,
            youKeep: p?.expectedNet,
          };
        }),
      );
    },
  );

  server.registerTool(
    "get_listing_guide",
    {
      title: "Get listing guide",
      description: "Each platform's title/description limits and what its buyers search for. Read before writing listings.",
      inputSchema: z.object({ channels: z.array(channel).min(1) }),
    },
    async ({ channels }) =>
      json(
        "Write one listing per platform. Use only confirmed facts; disclose every flaw; no prices or off-platform contact in the text.",
        channels.map((c) => ({
          channel: c,
          platform: CHANNELS[c].name,
          titleMaxLength: CHANNELS[c].titleMaxLength || "no separate title; first line of the description acts as one",
          descriptionMaxLength: CHANNELS[c].descriptionMaxLength,
          maxPhotos: CHANNELS[c].maxPhotos,
          style: CHANNELS[c].listingStyle,
        })),
      ),
  );

  server.registerTool(
    "save_listings",
    {
      title: "Save listings",
      description:
        "Save the listing you wrote for each platform. Prices are added from the plan; text is trimmed to each platform's limits.",
      inputSchema: z.object({
        item_id: itemId,
        listings: z
          .array(
            z.object({
              channel,
              title: z.string(),
              description: z.string(),
              tags: z.array(z.string()).default([]),
              category_hint: z.string().default(""),
            }),
          )
          .min(1),
      }),
    },
    async ({ item_id, listings }) => {
      const item = await load(item_id);
      const drafts = await saveListingTexts(
        store,
        item,
        await getSettings(shop),
        listings.map((l) => ({ ...l, categoryHint: l.category_hint })),
      );
      return json(
        "Saved. Give the seller each listing to copy, the price, and the link to post it:",
        drafts.map((d) => ({
          platform: CHANNELS[d.channel].name,
          postAt: POST_LINKS[d.channel],
          title: d.title,
          description: d.description,
          tags: d.tags,
          listPrice: d.price.listPrice,
          acceptOffersFrom: d.price.minAcceptPrice,
        })),
      );
    },
  );

  server.registerTool(
    "improve_photos",
    {
      title: "Make listing-ready photos",
      description:
        "Fixes light and color on the seller's photos, makes a clean studio cover from the real photo, and optionally an AI model photo. Every AI-touched image is checked against the originals; anything that changes the item is dropped. Takes 1-2 minutes.",
      inputSchema: z.object({ item_id: itemId, model_photo: z.boolean().default(true) }),
    },
    async ({ item_id, model_photo }) => {
      const item = await load(item_id);
      const r = await makeListingPhotos(store, item, model_photo);
      return json(`Added ${r.added} photos.`, { retakeTips: r.retakeTips, worthAdding: r.missingShots, droppedForAccuracy: r.rejected });
    },
  );

  server.registerTool(
    "get_posting_kit",
    {
      title: "Get posting kit",
      description:
        "Everything needed to post the item on one platform: where to post, every form field value, photo URLs in order (cover first), and offer limits. Use it to fill the platform's listing form.",
      inputSchema: z.object({ item_id: itemId, channel }),
    },
    async ({ item_id, channel }) => {
      const item = await load(item_id);
      const listing = item.listings.find((l) => l.channel === channel);
      if (!listing) return text(`No ${CHANNELS[channel].name} listing yet. Run plan_item, write one, and save_listings first.`);
      const { photos, disclosure } = photosForChannel(item.photos, channel);
      const f = item.facts;
      return json(`Posting kit for ${CHANNELS[channel].name}. Fill the form with these values; let the seller press the final Post button.`, {
        postUrl: POST_LINKS[channel],
        fields: {
          title: listing.title,
          description: [listing.description, disclosure].filter(Boolean).join("\n\n"),
          price: listing.price.listPrice,
          brand: f?.brand,
          category: listing.categoryHint,
          size: f?.size,
          condition: f?.condition.replaceAll("_", " "),
          colors: f?.colors,
          materials: f?.materials,
          tags: listing.tags,
        },
        photos: photos.map((p) => ({ url: p.url, kind: p.kind })),
        offers: { acceptFrom: listing.price.minAcceptPrice, neverBelow: listing.price.minAcceptPrice },
        afterPosting: "Call mark_posted with the listing URL.",
      });
    },
  );

  server.registerTool(
    "mark_posted",
    {
      title: "Mark posted",
      description: "Record that the seller posted the item on a platform. Include the listing link if they have it.",
      inputSchema: z.object({ item_id: itemId, channel, listing_url: z.string().url().optional() }),
    },
    async ({ item_id, channel, listing_url }) => {
      const item = await load(item_id);
      await markPosted(store, item, channel, listing_url);
      return text(`Marked live on ${CHANNELS[channel].name}.`);
    },
  );

  server.registerTool(
    "mark_sold",
    {
      title: "Mark sold",
      description:
        "Call as soon as the item sells anywhere. Locks it (quantity 0) and returns every other listing the seller must take down.",
      inputSchema: z.object({ item_id: itemId, channel: channel.describe("Where it sold") }),
    },
    async ({ item_id, channel }) => {
      const item = await load(item_id);
      const { toDelist } = await markSold(store, item, channel);
      if (!toDelist.length) return text(`Marked sold on ${CHANNELS[channel].name}. No other listings to take down.`);
      return json(
        `Marked sold on ${CHANNELS[channel].name} and locked. The seller must take these down now, or someone else may buy it:`,
        toDelist.map((d) => ({ platform: d.name, channel: d.channel, link: d.url ?? "(no link saved; find it in their listings)" })),
      );
    },
  );

  server.registerTool(
    "confirm_delisted",
    {
      title: "Confirm taken down",
      description: "Record that the seller took a listing down after a sale.",
      inputSchema: z.object({ item_id: itemId, channel }),
    },
    async ({ item_id, channel }) => {
      const item = await load(item_id);
      const remaining = await confirmDelisted(store, item, channel);
      return text(
        remaining.length
          ? `Done. Still to take down: ${remaining.map((c) => CHANNELS[c].name).join(", ")}.`
          : "Done. All other listings are down.",
      );
    },
  );

  server.registerTool(
    "get_settings",
    {
      title: "Get settings",
      description: "Which platforms the seller uses and their default shipping assumptions.",
      inputSchema: z.object({}),
    },
    async () => json("Settings:", await getSettings(shop)),
  );

  server.registerTool(
    "update_settings",
    {
      title: "Update settings",
      description: "Change which platforms the seller has accounts on, or their shipping assumptions.",
      inputSchema: z.object({
        enabled_channels: z.array(channel).optional(),
        label_cost: z.number().nonnegative().optional().describe("Typical shipping label cost in USD"),
        seller_pays_shipping: z.boolean().optional(),
      }),
    },
    async ({ enabled_channels, label_cost, seller_pays_shipping }) =>
      json(
        "Updated:",
        await updateSettings(shop, {
          ...(enabled_channels ? { enabledChannels: enabled_channels.filter((c) => c !== "shopify") } : {}),
          ...(label_cost !== undefined ? { labelCost: label_cost } : {}),
          ...(seller_pays_shipping !== undefined ? { sellerPaysShipping: seller_pays_shipping } : {}),
        }),
      ),
  );
}
