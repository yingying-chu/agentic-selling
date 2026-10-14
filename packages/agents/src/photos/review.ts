import { z } from "zod";
import type { ItemFacts, PhotoKind } from "@agentic-selling/core";
import { structuredCall } from "../claude.ts";
import type { ImageData } from "./enhance.ts";

// Claude looks at the photos twice: once to grade them and pick a cover, and
// once per edited image to confirm the item wasn't changed.

const toBlock = (img: ImageData) => ({
  type: "image" as const,
  source: { type: "base64" as const, media_type: img.mediaType, data: img.data.toString("base64") },
});

const AssessmentSchema = z.object({
  photos: z.array(
    z.object({
      index: z.number().int(),
      shows: z.enum(["front", "back", "side", "tag_or_label", "detail", "flaw", "worn", "packaging", "other"]),
      quality: z.enum(["good", "fixable", "retake"]),
      issues: z.array(z.string()),
      retakeTip: z.string().nullable(),
    }),
  ),
  coverIndex: z.number().int().nullable(),
  missingShots: z.array(z.string()),
});
export type PhotoAssessment = z.infer<typeof AssessmentSchema>;

const ASSESS_SYSTEM = `You review a casual seller's photos of one secondhand item before it's listed.

For each photo (0-indexed, in the order given):
- shows: what the photo shows.
- quality: "good" if a buyer can see the item clearly; "fixable" if it's only too dark, color-cast, or slightly soft (software can correct that); "retake" if the item is cut off, badly blurred, mostly hidden, or too dark to recover.
- issues: short, concrete problems.
- retakeTip: for "retake" only, one friendly instruction to fix it (e.g. "Lay it flat by a window in daylight and fit the whole jacket in frame").

coverIndex: the best photo of the whole item from the front to use as the cover, or null if none is usable.
missingShots: up to 3 photos buyers will look for that are missing (e.g. "size tag", "close-up of the cuff wear", "back"). Only list what matters for this item.`;

export async function assessPhotos(photos: ImageData[], facts: ItemFacts | null): Promise<PhotoAssessment> {
  return structuredCall("photo_review", AssessmentSchema, {
    max_tokens: 8000,
    effort: "low",
    system: ASSESS_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          ...photos.map(toBlock),
          { type: "text", text: facts ? `Item: ${facts.title}` : "Grade these photos." },
        ],
      },
    ],
  });
}

const FidelitySchema = z.object({
  colorShift: z.enum(["none", "slight", "major"]),
  detailsChanged: z.boolean(),
  wearHiddenOrAdded: z.boolean(),
  partsCutOff: z.boolean(),
  fitMisleading: z.boolean(),
  issues: z.array(z.string()),
  stockQuality: z.number().int().min(1).max(10),
  qualityIssues: z.array(z.string()),
});

/** Minimum stock-photo score for an image to be used. */
export const MIN_QUALITY = 7;

export interface FidelityResult {
  /** Honest AND good enough to list. */
  pass: boolean;
  honest: boolean;
  quality: number;
  issues: string[];
}

const FIDELITY_SYSTEM = `You check edited listing photos for honesty. A buyer will receive the item in the reference photos; the candidate image must not mislead them about it.

Compare the CANDIDATE (last image) with the REFERENCE photos (all earlier images). Judge only the item, not the background, lighting style, model, or pose.
- colorShift: how much the item's real color differs. Correcting a lamp's yellow cast toward true color is "none" or "slight"; a different wash, shade or hue is "major".
- detailsChanged: logos, prints, hardware, stitching, pockets, shape or proportions differ.
- wearHiddenOrAdded: visible wear, stains, fading or damage was removed, repaired, or invented.
- partsCutOff: part of the item is missing or clipped (sleeve tips, straps, hems).
- fitMisleading: for photos on a model only, the garment looks a different size, length or cut than its measurements imply. Otherwise false.
List each problem in issues.

Then judge the candidate as a marketplace photo, independent of honesty:
- stockQuality 1-10: how close it is to a professional e-commerce stock photo. 9-10: clean seamless background, item centered and fully in frame, even soft light, sharp, natural color, pleasant shadow. 7: clean and appealing with a minor flaw. 5: acceptable phone photo. 3 or below: cluttered, dark, blurry, awkward crop, cut-out halos or jagged edges.
- qualityIssues: concrete fixes that would raise the score.`;

export async function checkFidelity(
  references: ImageData[],
  candidate: ImageData,
  kind: PhotoKind,
  facts: ItemFacts | null,
): Promise<FidelityResult> {
  const r = await structuredCall("fidelity", FidelitySchema, {
    max_tokens: 4000,
    effort: "medium",
    system: FIDELITY_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          ...references.slice(0, 3).map(toBlock),
          toBlock(candidate),
          {
            type: "text",
            text: `Candidate type: ${kind}.${facts?.size ? ` Labeled size: ${facts.size}.` : ""}${
              facts?.measurements.length ? ` Measurements: ${facts.measurements.map((m) => `${m.name} ${m.value}`).join(", ")}.` : ""
            }`,
          },
        ],
      },
    ],
  }).catch(() => null);
  if (!r) return { pass: false, honest: false, quality: 0, issues: ["Couldn't verify this image"] };
  const honest = r.colorShift !== "major" && !r.detailsChanged && !r.wearHiddenOrAdded && !r.partsCutOff && !r.fitMisleading;
  const good = r.stockQuality >= MIN_QUALITY;
  return {
    pass: honest && good,
    honest,
    quality: r.stockQuality,
    issues: honest ? (good ? [] : [`Quality ${r.stockQuality}/10: ${r.qualityIssues.join("; ")}`]) : r.issues,
  };
}
