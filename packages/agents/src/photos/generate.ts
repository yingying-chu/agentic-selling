import { generateText } from "ai";
import type { ItemFacts } from "@agentic-selling/core";
import { record, route, type Task } from "../models.ts";
import type { ImageData } from "./enhance.ts";

// Image-model calls through Vercel AI Gateway (AI_GATEWAY_API_KEY). The model
// is used for two things only: drawing an outline of the item (so real pixels
// can be reused) and, on request, clearly labeled AI renders.

/** Image call for a task, with the task's backup models via the Gateway. See ROUTES in models.ts. */
async function imageCall(task: Task, images: ImageData[], prompt: string): Promise<Buffer> {
  const r = route(task);
  const started = Date.now();
  const result = await generateText({
    model: r.model,
    providerOptions: r.providerOptions,
    messages: [
      {
        role: "user",
        content: [
          ...images.map((img) => ({ type: "file" as const, data: img.data, mediaType: img.mediaType })),
          { type: "text" as const, text: prompt },
        ],
      },
    ],
  });
  record(task, r.model, started, result.providerMetadata?.gateway as object | undefined);
  const file = result.files.find((f) => f.mediaType?.startsWith("image/"));
  if (!file) throw new Error(`Image model returned no image${result.text ? `: ${result.text.slice(0, 200)}` : ""}`);
  return Buffer.from(file.uint8Array);
}

function describe(facts: ItemFacts | null): string {
  if (!facts) return "the item for sale";
  const base = [facts.brand, facts.colors.join("/"), facts.itemType].filter(Boolean).join(" ");
  return facts.styleKeywords.length ? `${base} (${facts.styleKeywords.slice(0, 8).join(", ")})` : base;
}

/** Black-and-white mask of the item, same framing as the photo. */
export function segmentItem(photo: ImageData, facts: ItemFacts | null): Promise<Buffer> {
  return imageCall(
    "mask",
    [photo],
    `Create a segmentation mask of this photo with exactly the same framing and size. The ${describe(facts)} — including sleeves, straps, collar, cuffs, and any lining or inside visible through openings — is solid pure white #FFFFFF. Everything else (surfaces, hangers, hands, other objects, walls) is solid pure black #000000. No gray, no shading, no other content.`,
  );
}

function sizeNotes(facts: ItemFacts | null): string {
  if (!facts) return "";
  const parts = [
    facts.size && `Labeled size: ${facts.size}.`,
    facts.measurements.length && `Measurements: ${facts.measurements.map((m) => `${m.name} ${m.value}`).join(", ")}.`,
    facts.flaws.length && `Visible wear that must stay visible: ${facts.flaws.join("; ")}.`,
  ];
  return parts.filter(Boolean).join(" ");
}

/** AI render of the item worn by a model, for showing fit. Always labeled and never the cover. */
export function generateModelPhoto(photos: ImageData[], facts: ItemFacts | null): Promise<Buffer> {
  const who = facts?.department === "men" ? "a man" : facts?.department === "kids" ? "a child" : "a woman";
  return imageCall(
    "render",
    photos.slice(0, 3),
    `Photograph ${who} of average build wearing exactly this ${describe(facts)}, as a clean e-commerce photo: plain light grey studio background, soft even light, full garment visible, neutral pose. ${sizeNotes(facts)}
The garment must be identical to the reference photos: same color and wash, fabric texture, stitching, hardware, logos and labels, and the same wear. Make the fit match the labeled size and measurements: do not make it look more fitted, longer, newer, or better than it is. No text or watermark.`,
  );
}

/** How the item is best presented in a stock photo. */
function presentation(facts: ItemFacts | null): string {
  const t = `${facts?.itemType ?? ""} ${facts?.categoryGroups.join(" ") ?? ""}`.toLowerCase();
  if (/hat|cap|shoe|sneaker|boot|bag|purse|backpack/.test(t)) return "a three-quarter front angle, standing upright";
  if (/furniture|chair|table|lamp|electronics|power bank|speaker|headphone/.test(t)) return "a three-quarter front angle";
  return "laid flat and neatly arranged (flat lay), seen from directly above";
}

/** AI stock-style product shot rebuilt from the seller's photos. Labeled as AI wherever it's shown. */
export function regenerateProductShot(photos: ImageData[], facts: ItemFacts | null): Promise<Buffer> {
  return imageCall(
    "render",
    photos.slice(0, 4),
    `Create a professional e-commerce stock photo of this exact ${describe(facts)}: ${presentation(facts)}, centered and fully in frame on a seamless light grey (#F5F5F4) studio background, soft diffused even light, a gentle natural contact shadow, crisp focus, square 1:1 framing. ${sizeNotes(facts)}
It must be the same physical item as the reference photos, copied exactly: same shape and silhouette (e.g. a flat brim stays flat), same color and shade, proportions, materials, logos, stickers, labels and their text, hardware and any wear. Do not add, remove, repair, restyle or improve anything. No props, no hands, no text, no watermark.`,
  );
}
