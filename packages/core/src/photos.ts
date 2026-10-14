import { CHANNELS, type ChannelId } from "./channels.ts";

// Which kinds of photos may appear on which marketplace, and in what order.
// Used goods must be shown as they really are: marketplaces penalize sellers
// for misleading photos, and "not as described" returns cost the sale.

export type PhotoKind =
  /** The seller's photo, untouched. */
  | "original"
  /** Same photo with exposure, white balance and sharpness corrected. No pixels invented. */
  | "enhanced"
  /** The item's real pixels cut out and placed on a clean studio background. */
  | "studio"
  /** AI-generated product shot rebuilt from the seller's photos. Labeled. */
  | "ai_regenerated"
  /** AI-generated photo of the item on a model. Labeled. */
  | "ai_model";

export const AI_GENERATED_KINDS: readonly PhotoKind[] = ["ai_regenerated", "ai_model"];

export interface ChannelPhotoPolicy {
  /** AI-generated images allowed as extra (non-cover) photos. */
  aiGeneratedAsExtra: boolean;
  /**
   * An AI product shot may be the cover when no real-photo studio shot made the
   * quality bar. The seller's real photo always comes right after it.
   */
  aiProductShotCover: boolean;
  /** Studio cut-outs (real pixels, new background) allowed as the cover photo. */
  studioCover: boolean;
  note: string;
}

// Conservative defaults; check each platform's current photo policy before relying on them.
export const PHOTO_POLICY: Record<ChannelId, ChannelPhotoPolicy> = {
  shopify: { aiGeneratedAsExtra: true, aiProductShotCover: true, studioCover: true, note: "Your own store." },
  ebay: {
    aiGeneratedAsExtra: true,
    aiProductShotCover: false,
    studioCover: true,
    note: "Used items need photos of the actual item; stock or AI images can't stand in for them.",
  },
  poshmark: { aiGeneratedAsExtra: true, aiProductShotCover: true, studioCover: true, note: "Cover is shown square; real photos expected." },
  mercari: { aiGeneratedAsExtra: true, aiProductShotCover: true, studioCover: true, note: "Photos must show the actual item." },
  depop: {
    aiGeneratedAsExtra: false,
    aiProductShotCover: false,
    studioCover: true,
    note: "Depop buyers expect the seller's own photos; AI model shots are left off.",
  },
  vinted: { aiGeneratedAsExtra: false, aiProductShotCover: false, studioCover: true, note: "Photos must be of the actual item." },
  grailed: { aiGeneratedAsExtra: false, aiProductShotCover: false, studioCover: true, note: "Enthusiast buyers want real detail shots." },
  fb_marketplace: { aiGeneratedAsExtra: true, aiProductShotCover: true, studioCover: true, note: "" },
  etsy: { aiGeneratedAsExtra: true, aiProductShotCover: false, studioCover: true, note: "Vintage listings must show the actual item." },
};

export interface ListingPhoto {
  url: string;
  kind: PhotoKind;
  /** Short description, used as alt text. */
  alt: string | null;
  /** Which original photo this was made from, if any. */
  sourceUrl?: string;
}

/** Same image regardless of size variant or cache-buster (Shopify CDN: name_1600x1600.jpg?v=...). */
const imageKey = (url: string) => url.split("?")[0]!.replace(/_\d+x\d*(?=\.\w+$)/, "");

const ORDER: Record<PhotoKind, number> = { studio: 0, enhanced: 1, original: 2, ai_regenerated: 3, ai_model: 4 };
/** Where an AI product shot may lead: right after a studio shot, before real photos. */
const ORDER_AI_COVER: Record<PhotoKind, number> = { ...ORDER, ai_regenerated: 0.5 };

/**
 * Photos for one platform, cover first: a studio shot of the real photo leads;
 * where the platform allows, an AI product shot can lead when there's no studio
 * shot, with the real photos right after. A corrected photo replaces its own
 * original, model renders go last, and AI images are dropped where the platform
 * doesn't allow them.
 */
export function photosForChannel(
  photos: ListingPhoto[],
  channel: ChannelId,
): { photos: ListingPhoto[]; disclosure: string | null } {
  const policy = PHOTO_POLICY[channel];
  const replaced = new Set(photos.filter((p) => p.kind === "enhanced" && p.sourceUrl).map((p) => imageKey(p.sourceUrl!)));
  const kept = photos.filter((p) => {
    if (p.kind === "original" && replaced.has(imageKey(p.url))) return false;
    if (AI_GENERATED_KINDS.includes(p.kind) && !policy.aiGeneratedAsExtra) return false;
    if (p.kind === "studio" && !policy.studioCover) return false;
    return true;
  });
  // Never let AI images be the only thing a buyer sees.
  if (!kept.some((p) => !AI_GENERATED_KINDS.includes(p.kind))) return { photos: [], disclosure: null };

  const order = policy.aiProductShotCover ? ORDER_AI_COVER : ORDER;
  const sorted = [...kept].sort((a, b) => order[a.kind] - order[b.kind]);
  const limited = sorted.slice(0, CHANNELS[channel].maxPhotos);
  const hasAi = limited.some((p) => AI_GENERATED_KINDS.includes(p.kind));
  return {
    photos: limited,
    disclosure: hasAi
      ? "Some photos are AI-generated renders of this exact item to show it clearly; the real photos show its actual condition."
      : null,
  };
}
