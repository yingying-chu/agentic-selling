import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

export const MODEL = "claude-opus-5-5";

let client: Anthropic | undefined;
/** Credentials come from ANTHROPIC_API_KEY or an `ant auth login` profile. */
export function claude(): Anthropic {
  client ??= new Anthropic();
  return client;
}

export interface PreparedPhoto {
  path: string;
  data: string;
  mediaType: "image/jpeg";
}

/**
 * Phone photos are often 5-12MB and sometimes HEIC. Normalize to JPEG with a
 * 1568px long edge, which is all the model uses and keeps requests small.
 */
export async function preparePhotos(paths: string[], max = 10): Promise<PreparedPhoto[]> {
  return Promise.all(
    paths.slice(0, max).map(async (path) => {
      try {
        const buf = await sharp(path)
          .rotate()
          .resize(1568, 1568, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        return { path, data: buf.toString("base64"), mediaType: "image/jpeg" as const };
      } catch (err) {
        throw new Error(
          `Couldn't read ${path}. If it's HEIC, export it as JPEG first (on a Mac: sips -s format jpeg in.heic --out out.jpg).`,
          { cause: err },
        );
      }
    }),
  );
}

export function imageBlocks(photos: PreparedPhoto[]): Anthropic.ImageBlockParam[] {
  return photos.map((p) => ({
    type: "image",
    source: { type: "base64", media_type: p.mediaType, data: p.data },
  }));
}
