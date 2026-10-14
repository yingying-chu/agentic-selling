import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { CHANNELS, type ChannelId, type ChannelPrice, type ItemFacts, type ListingDraft } from "@agentic-selling/core";
import { claude, MODEL } from "./claude.ts";

const DraftSchema = z.object({
  drafts: z.array(
    z.object({
      channel: z.string(),
      title: z.string(),
      description: z.string(),
      tags: z.array(z.string()),
      categoryHint: z.string(),
    }),
  ),
});

const SYSTEM = `You write resale listings tailored to each marketplace's search and audience.

Rules for every channel:
- Use only the facts given. Never invent brand, material, measurements, or provenance.
- Disclose every flaw listed. Honest listings avoid returns and protect seller ratings.
- Respect each channel's title and description length limits exactly.
- Write search terms buyers actually type on that platform (brand, item type, style name, size, color, material). This is the SEO; also write descriptions in clear, complete sentences so AI shopping assistants can quote them accurately.
- Do not mention price, other marketplaces, or off-platform contact.
- tags: platform keywords/hashtags where the platform uses them, otherwise an empty list.
- categoryHint: the platform's category path as best you know it, e.g. "Women > Dresses > Midi".`;

/** Trims to the limit at a word boundary; the model usually respects limits but adapters reject overlong titles. */
function fit(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

export async function writeListings(
  facts: ItemFacts,
  prices: Partial<Record<ChannelId, ChannelPrice>>,
  channels: ChannelId[],
): Promise<ListingDraft[]> {
  const specs = channels.map((id) => {
    const c = CHANNELS[id];
    return {
      channel: id,
      name: c.name,
      titleMaxLength: c.titleMaxLength || "no separate title; put a title-like first line in the description",
      descriptionMaxLength: c.descriptionMaxLength,
      style: c.listingStyle,
    };
  });

  const response = await claude().beta.messages.parse({
    model: MODEL,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: zodOutputFormat(DraftSchema) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Item facts:\n${JSON.stringify(facts, null, 2)}\n\nWrite one draft per channel:\n${JSON.stringify(specs, null, 2)}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Model declined to write listings: ${response.stop_details?.explanation ?? "no details"}`);
  }
  const out = response.parsed_output;
  if (!out) throw new Error(`No structured output (stop_reason: ${response.stop_reason})`);

  return channels.flatMap((id): ListingDraft[] => {
    const d = out.drafts.find((x) => x.channel === id);
    const price = prices[id];
    if (!d || !price) return [];
    const c = CHANNELS[id];
    return [
      {
        channel: id,
        title: fit(d.title, c.titleMaxLength),
        description: fit(d.description, c.descriptionMaxLength),
        tags: d.tags,
        categoryHint: d.categoryHint,
        price,
      },
    ];
  });
}
