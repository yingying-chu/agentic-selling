import type { ItemFacts, PhotoKind } from "@agentic-selling/core";
import { enhancePhoto, maskCoverage, studioComposite, toListingJpeg, type ImageData } from "./enhance.ts";
import { generateModelPhoto, regenerateProductShot, segmentItem } from "./generate.ts";
import { assessPhotos, checkFidelity, type PhotoAssessment } from "./review.ts";

// Photos in, listing-ready photos out:
//   1. Claude grades every photo and picks the cover.
//   2. Usable photos get exposure / white-balance / sharpness fixes (no invented pixels).
//   3. The cover becomes a square studio shot from the item's real pixels.
//   4. Optionally, labeled AI renders: a model photo, or a rebuilt product shot when nothing is usable.
//   5. Every image that involved a model is checked against the originals; failures are dropped.

export interface PhotoInput extends ImageData {
  /** Where the original lives (e.g. Shopify CDN URL), so outputs can point back to it. */
  source: string;
}

export interface ProcessedPhoto extends ImageData {
  kind: PhotoKind;
  source?: string;
  alt: string;
}

export interface PhotoResult {
  assessment: PhotoAssessment;
  outputs: ProcessedPhoto[];
  /** Images that were generated but failed the honesty check, with reasons. */
  rejected: Array<{ kind: PhotoKind; issues: string[] }>;
  /** Friendly reshoot advice for photos that can't be saved. */
  retakeTips: string[];
}

export interface PhotoOptions {
  /** Skip the per-photo corrections (when redoing only the AI photos). */
  skipEnhance?: boolean;
  studio?: boolean;
  modelPhoto?: boolean;
  /**
   * Make an AI product shot when the real-photo studio cutout doesn't reach
   * stock-photo quality (default on). Still checked for honesty and quality.
   */
  productShot?: boolean;
  log?: (msg: string) => void;
}

async function verified(
  kind: PhotoKind,
  references: ImageData[],
  facts: ItemFacts | null,
  make: () => Promise<ImageData>,
  attempts = 2,
): Promise<{ image?: ImageData; issues: string[] }> {
  let issues: string[] = [];
  for (let i = 0; i < attempts; i++) {
    const image = await toListingJpeg(await make());
    const check = await checkFidelity(references, image, kind, facts);
    if (check.pass) return { image, issues: [] };
    issues = check.issues;
  }
  return { issues };
}

export async function improvePhotos(
  inputs: PhotoInput[],
  facts: ItemFacts | null,
  opts: PhotoOptions = {},
): Promise<PhotoResult> {
  const log = opts.log ?? (() => {});
  const studio = opts.studio ?? true;
  if (!inputs.length) throw new Error("No photos to work with.");

  log(`Reviewing ${inputs.length} photos`);
  const assessment = await assessPhotos(inputs, facts);
  const outputs: ProcessedPhoto[] = [];
  const rejected: PhotoResult["rejected"] = [];
  const name = facts?.title ?? "Item";

  const usable = assessment.photos.filter((p) => p.quality !== "retake" && inputs[p.index]);
  log(`Correcting ${usable.length} usable photos`);
  const enhanced = new Map<number, ImageData>();
  for (const p of usable) {
    const img = await enhancePhoto(inputs[p.index]!.data);
    enhanced.set(p.index, img);
    if (!opts.skipEnhance) {
      outputs.push({ ...img, kind: "enhanced", source: inputs[p.index]!.source, alt: `${name}: ${p.shows.replaceAll("_", " ")}` });
    }
  }

  const references = usable.map((p) => enhanced.get(p.index)!).slice(0, 3);
  const cover = assessment.coverIndex !== null ? inputs[assessment.coverIndex] : undefined;

  if (studio && cover && assessment.coverIndex !== null) {
    log("Making a studio cover from the real photo");
    const { image, issues } = await verified("studio", references.length ? references : [cover], facts, async () => {
      const mask = await segmentItem(cover, facts);
      const coverage = await maskCoverage(mask);
      if (coverage < 0.03 || coverage > 0.95) throw new Error("Item outline didn't come out right.");
      return studioComposite(cover.data, mask);
    }).catch((err: Error) => ({ image: undefined, issues: [err.message] }));
    if (image) outputs.unshift({ ...image, kind: "studio", source: cover.source, alt: `${name}, front` });
    else rejected.push({ kind: "studio", issues });
  }
  const studioOk = outputs.some((o) => o.kind === "studio");

  const refsForAi = references.length ? references : inputs;
  if (!studioOk && (opts.productShot ?? true)) {
    log("Real-photo cutout isn't stock quality; making an AI product shot");
    const { image, issues } = await verified("ai_regenerated", refsForAi, facts, async () => ({
      data: await regenerateProductShot(refsForAi, facts),
      mediaType: "image/png" as const,
    }));
    if (image) outputs.push({ ...image, kind: "ai_regenerated", alt: `${name} (AI-generated product image)` });
    else rejected.push({ kind: "ai_regenerated", issues });
  }

  if (opts.modelPhoto) {
    log("Generating an AI model photo");
    const { image, issues } = await verified("ai_model", refsForAi, facts, async () => ({
      data: await generateModelPhoto(refsForAi, facts),
      mediaType: "image/png" as const,
    }));
    if (image) outputs.push({ ...image, kind: "ai_model", alt: `${name} shown on a model (AI-generated)` });
    else rejected.push({ kind: "ai_model", issues });
  }

  const retakeTips = assessment.photos.flatMap((p) => (p.quality === "retake" && p.retakeTip ? [`Photo ${p.index + 1}: ${p.retakeTip}`] : []));
  return { assessment, outputs, rejected, retakeTips };
}
