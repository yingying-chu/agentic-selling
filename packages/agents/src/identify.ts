import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { CategoryGroup, ItemFacts } from "@agentic-selling/core";
import { claude, imageBlocks, MODEL, type PreparedPhoto } from "./claude.ts";

const CATEGORY_GROUPS = [
  "womens_clothing",
  "mens_clothing",
  "shoes",
  "bags",
  "accessories",
  "jewelry",
  "vintage",
  "streetwear",
  "luxury",
  "kids",
  "electronics",
  "home",
  "furniture",
  "collectibles",
  "other",
] as const satisfies readonly CategoryGroup[];

const ItemFactsSchema = z.object({
  title: z.string(),
  brand: z.string().nullable(),
  itemType: z.string(),
  categoryGroups: z.array(z.enum(CATEGORY_GROUPS)),
  department: z.enum(["women", "men", "unisex", "kids", "none"]),
  size: z.string().nullable(),
  colors: z.array(z.string()),
  materials: z.array(z.string()),
  condition: z.enum(["new_with_tags", "new_without_tags", "excellent", "good", "fair", "poor"]),
  flaws: z.array(z.string()),
  measurements: z.array(z.object({ name: z.string(), value: z.string() })),
  styleKeywords: z.array(z.string()),
  era: z.string().nullable(),
  estimatedSoldPriceRange: z.object({ low: z.number(), high: z.number(), currency: z.literal("USD") }),
  confidence: z.enum(["high", "medium", "low"]),
  questionsForSeller: z.array(z.string()),
});

const SYSTEM = `You catalog secondhand items for resale from the seller's photos.

Read every label and tag you can see (brand, size, fiber content, RN/CA numbers, style codes, country of origin) and use them over visual guesses. Only state facts the photos or the seller's notes support; when something matters for the listing but you can't confirm it, leave the field null and add a question for the seller.

categoryGroups: every group that applies (a 90s Levi's jacket is mens_clothing + vintage + streetwear). Include "luxury" only for recognised luxury houses. Include "vintage" only when tags or construction indicate 20+ years old.

condition: be conservative. Name every visible flaw (pilling, stains, holes, missing buttons, scuffs, odor if noted by the seller).

estimatedSoldPriceRange: what this realistically SELLS for used in the US secondhand market right now, from your knowledge of comparable sales. This is a rough first pass; real comps get pulled later.

If the item could be counterfeit (luxury brand, mismatched tags), say so in questionsForSeller.`;

export async function identifyItem(photos: PreparedPhoto[], sellerNotes = ""): Promise<ItemFacts> {
  const response = await claude().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: zodOutputFormat(ItemFactsSchema) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          ...imageBlocks(photos),
          {
            type: "text",
            text: sellerNotes ? `Seller notes: ${sellerNotes}` : "No seller notes. Catalog this item.",
          },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Model declined to catalog this item: ${response.stop_details?.explanation ?? "no details"}`);
  }
  if (!response.parsed_output) throw new Error(`No structured output (stop_reason: ${response.stop_reason})`);
  return response.parsed_output;
}
