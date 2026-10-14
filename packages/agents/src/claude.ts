import Anthropic from "@anthropic-ai/sdk";

const GATEWAY_URL = "https://ai-gateway.vercel.sh";

/**
 * With AI_GATEWAY_API_KEY set, requests go through Vercel AI Gateway (one bill,
 * provider failover). Otherwise they go straight to Anthropic using
 * ANTHROPIC_API_KEY or an `ant auth login` profile.
 */
export const viaGateway = (): boolean => Boolean(process.env.AI_GATEWAY_API_KEY);

export const model = (): string => (viaGateway() ? "anthropic/claude-opus-5-5" : "claude-opus-5-5");

/**
 * Server-side refusal fallback is an Anthropic API feature; it isn't assumed to
 * pass through the gateway, so it's only sent on direct calls.
 */
export function fallbackParams(): { betas?: string[]; fallbacks?: "default" } {
  return viaGateway() ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}

let client: Anthropic | undefined;
export function claude(): Anthropic {
  client ??= viaGateway()
    ? new Anthropic({ baseURL: GATEWAY_URL, apiKey: process.env.AI_GATEWAY_API_KEY })
    : new Anthropic();
  return client;
}

export interface PreparedPhoto {
  source: string;
  data: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}

/**
 * Local phone photos are often 5-12MB and sometimes HEIC. Normalize to JPEG
 * with a 1568px long edge, which is all the model uses. sharp is loaded lazily
 * so the web app, which only uses URLs, doesn't bundle it.
 */
export async function preparePhotos(paths: string[], max = 10): Promise<PreparedPhoto[]> {
  const { default: sharp } = await import("sharp");
  return Promise.all(
    paths.slice(0, max).map(async (path) => {
      try {
        const buf = await sharp(path)
          .rotate()
          .resize(1568, 1568, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        return { source: path, data: buf.toString("base64"), mediaType: "image/jpeg" as const };
      } catch (err) {
        throw new Error(
          `Couldn't read ${path}. If it's HEIC, export it as JPEG first (on a Mac: sips -s format jpeg in.heic --out out.jpg).`,
          { cause: err },
        );
      }
    }),
  );
}

/**
 * Fetches photos already hosted somewhere (e.g. Shopify's CDN). Callers should
 * pass URLs that are already resized; Shopify CDN URLs accept ?width=.
 */
export async function photosFromUrls(urls: string[], max = 10): Promise<PreparedPhoto[]> {
  return Promise.all(
    urls.slice(0, max).map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't fetch photo ${url}: ${res.status}`);
      const type = res.headers.get("content-type") ?? "image/jpeg";
      const mediaType = type.includes("png") ? "image/png" : type.includes("webp") ? "image/webp" : "image/jpeg";
      return { source: url, data: Buffer.from(await res.arrayBuffer()).toString("base64"), mediaType };
    }),
  );
}

export function imageBlocks(photos: PreparedPhoto[]): Anthropic.ImageBlockParam[] {
  return photos.map((p) => ({
    type: "image",
    source: { type: "base64", media_type: p.mediaType, data: p.data },
  }));
}
