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
  /** Studio cut-outs (real pixels, new background) allowed as the cover photo. */
  studioCover: boolean;
  note: string;
}

// Conservative defaults; check each platform's current photo policy before relying on them.
export const PHOTO_POLICY: Record<ChannelId, ChannelPhotoPolicy> = {
  shopify: { aiGeneratedAsExtra: true, studioCover: true, note: "Your own store." },
  ebay: {
    aiGeneratedAsExtra: true,
    studioCover: true,
    note: "Used items need photos of the actual item; stock or AI images can't stand in for them.",
  },
  poshmark: { aiGeneratedAsExtra: true, studioCover: true, note: "Cover is shown square; real photos expected." },
  mercari: { aiGeneratedAsExtra: true, studioCover: true, note: "Photos must show the actual item." },
  depop: {
    aiGeneratedAsExtra: false,
    studioCover: true,
    note: "Depop buyers expect the seller's own photos; AI model shots are left off.",
  },
  vinted: { aiGeneratedAsExtra: false, studioCover: true, note: "Photos must be of the actual item." },
  grailed: { aiGeneratedAsExtra: false, studioCover: true, note: "Enthusiast buyers want real detail shots." },
  fb_marketplace: { aiGeneratedAsExtra: true, studioCover: true, note: "" },
  etsy: { aiGeneratedAsExtra: true, studioCover: true, note: "Vintage listings must show the actual item." },
};

export interface ListingPhoto {
  url: string;
  kind: PhotoKind;
  /** Short description, used as alt text. */
  alt: string | null;
  /** Which original photo this was made from, if any. */
  sourceUrl?: string;
}

const ORDER: Record<PhotoKind, number> = { studio: 0, enhanced: 1, original: 2, ai_regenerated: 3, ai_model: 4 };

/**
 * Photos for one platform, cover first: real-item photos always lead, an
 * enhanced/studio version replaces its own original, and AI-generated images
 * go last (or are dropped where the platform doesn't allow them).
 */
export function photosForChannel(
  photos: ListingPhoto[],
  channel: ChannelId,
): { photos: ListingPhoto[]; disclosure: string | null } {
  const policy = PHOTO_POLICY[channel];
  const replaced = new Set(photos.filter((p) => p.kind === "enhanced" && p.sourceUrl).map((p) => p.sourceUrl));
  const kept = photos.filter((p) => {
    if (p.kind === "original" && replaced.has(p.url)) return false;
    if (AI_GENERATED_KINDS.includes(p.kind) && !policy.aiGeneratedAsExtra) return false;
    if (p.kind === "studio" && !policy.studioCover) return false;
    return true;
  });
  // Never let AI images be the only thing a buyer sees.
  if (!kept.some((p) => !AI_GENERATED_KINDS.includes(p.kind))) return { photos: [], disclosure: null };

  const sorted = [...kept].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  const limited = sorted.slice(0, CHANNELS[channel].maxPhotos);
  const hasAi = limited.some((p) => AI_GENERATED_KINDS.includes(p.kind));
  return {
    photos: limited,
    disclosure: hasAi ? "Model/product renders marked AI are generated to show fit and shape; see the real photos for condition." : null,
  };
}
