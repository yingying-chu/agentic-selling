import { CHANNELS, planItem, type ItemFacts, type ItemPlan, type ListingDraft, type PlanOptions } from "@agentic-selling/core";
import { preparePhotos, type PreparedPhoto } from "./claude.ts";
import { identifyItem } from "./identify.ts";
import { writeListings } from "./listings.ts";

// Photos in, everything needed to list out: item facts, per-channel prices,
// which channels to use, and a listing draft for each. Nothing is posted.

export interface IntakeInput extends PlanOptions {
  /** Local file paths (CLI) or already-fetched photos (web app). */
  photos: string[] | PreparedPhoto[];
  sellerNotes?: string;
}

export interface IntakeResult extends ItemPlan {
  facts: ItemFacts;
  drafts: ListingDraft[];
  createdAt: string;
}

export async function runIntake(input: IntakeInput, log: (msg: string) => void = () => {}): Promise<IntakeResult> {
  const photos =
    typeof input.photos[0] === "string" ? await preparePhotos(input.photos as string[]) : (input.photos as PreparedPhoto[]);

  log(`Identifying item from ${photos.length} photos`);
  const facts = await identifyItem(photos, input.sellerNotes);

  // Until real comps are wired in, planItem uses the midpoint of the model's estimate as the market price.
  const plan = planItem(facts, input);

  log(`Writing listings for Shopify + ${plan.selected.map((c) => CHANNELS[c].name).join(", ") || "no other channels"}`);
  const drafts = await writeListings(facts, plan.prices, ["shopify", ...plan.selected]);

  return { ...plan, facts, drafts, createdAt: new Date().toISOString() };
}
