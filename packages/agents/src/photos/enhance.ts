import type { Sharp } from "sharp";

// Deterministic photo fixes. Nothing here invents pixels: exposure, white
// balance and sharpness are corrected, and the studio version reuses the
// item's real pixels on a new background.

const loadSharp = async () => (await import("sharp")).default;

export interface ImageData {
  data: Buffer;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}

const STUDIO_BG = { r: 245, g: 245, b: 244 };
const OUTPUT_SIZE = 1600;

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

interface Raw {
  rgb: Buffer;
  width: number;
  height: number;
}

async function raw(img: Sharp): Promise<Raw> {
  const { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, width: info.width, height: info.height };
}

/**
 * Per-channel gains that neutralize the light's color cast ("gray world"):
 * the average of the well-lit surroundings (walls, sheets, floor; the item is
 * excluded when a mask is given) is assumed to be neutral. This is roughly what
 * a camera's auto white balance does. Gains are capped so a strongly colored
 * backdrop can't swing the item's color far; the honesty check catches the rest.
 */
function whiteBalanceGains({ rgb, width, height }: Raw, isItem?: (i: number) => boolean): [number, number, number] {
  const refs: number[] = [];
  for (let i = 0; i < width * height; i += 3) {
    if (isItem?.(i)) continue;
    const mx = Math.max(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!);
    if (mx > 40 && mx < 250) refs.push(i);
  }
  if (refs.length < 500) return [1, 1, 1];
  refs.sort((a, b) => lum(rgb[a * 3]!, rgb[a * 3 + 1]!, rgb[a * 3 + 2]!) - lum(rgb[b * 3]!, rgb[b * 3 + 1]!, rgb[b * 3 + 2]!));
  const lit = refs.slice(Math.floor(refs.length * 0.5));
  let sr = 0, sg = 0, sb = 0;
  for (const i of lit) {
    sr += rgb[i * 3]!;
    sg += rgb[i * 3 + 1]!;
    sb += rgb[i * 3 + 2]!;
  }
  const mean = (sr + sg + sb) / 3;
  const gain = (s: number) => Math.min(2, Math.max(0.6, mean / s));
  return [gain(sr), gain(sg), gain(sb)];
}

/** True when the surroundings are clearly colored rather than near-neutral. */
function backgroundIsColored({ rgb, width, height }: Raw, isItem: (i: number) => boolean): boolean {
  const sats: number[] = [];
  for (let i = 0; i < width * height; i += 7) {
    if (isItem(i)) continue;
    const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 40) sats.push((mx - mn) / mx);
  }
  if (sats.length < 200) return false;
  sats.sort((a, b) => a - b);
  return sats[Math.floor(sats.length / 2)]! > 0.3;
}

/** Gain that lifts the median brightness of the chosen pixels toward a target, capped so noise isn't amplified. */
function exposureGain(
  { rgb, width, height }: Raw,
  target: number,
  include?: (i: number) => boolean,
  cap = 1.8,
): number {
  const values: number[] = [];
  for (let i = 0; i < width * height; i += 5) {
    if (include && !include(i)) continue;
    values.push(lum(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!));
  }
  if (!values.length) return 1;
  values.sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)]!;
  return Math.min(cap, Math.max(1, target / Math.max(median, 1)));
}

/** Corrected version of the whole photo: exposure, white balance, light sharpening. */
export async function enhancePhoto(input: Buffer): Promise<ImageData> {
  const sharp = await loadSharp();
  const base = sharp(input).rotate().resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "inside", withoutEnlargement: true });
  const pixels = await raw(base.clone());
  const wb = whiteBalanceGains(pixels);
  const exp = exposureGain(pixels, 115);
  const data = await base
    .removeAlpha()
    .linear(
      wb.map((g) => g * exp),
      [0, 0, 0],
    )
    .gamma(exp > 1.3 ? 1.1 : 1)
    .sharpen({ sigma: 0.6 })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  return { data, mediaType: "image/jpeg" };
}

/**
 * Square studio shot: the item's own pixels (selected by `mask`, white = item)
 * corrected and centered on a light seamless background.
 */
export async function studioComposite(input: Buffer, mask: Buffer): Promise<ImageData> {
  const sharp = await loadSharp();
  const src = sharp(input).rotate();
  const pixels = await raw(src.clone());
  const { width: W, height: H } = pixels;
  const alpha = await cleanMask(mask, W, H);

  const isItem = (i: number) => alpha[i]! > 128;
  // A colored surface (wood table, colored wall) isn't a neutral reference;
  // correcting against it shifts the item's real color, so only fix exposure.
  const wb = backgroundIsColored(pixels, isItem) ? ([1, 1, 1] as [number, number, number]) : whiteBalanceGains(pixels, isItem);
  // Exposure from the whole scene, like the corrected photo: judging the item alone
  // would lift a black item toward grey.
  const exp = Math.min(1.5, exposureGain(pixels, 115));

  // Tone curve applied by hand: gain up to the cap, then a gamma lift for whatever brightness is still missing.
  const want = Math.min(2, exposureGain(pixels, 115, undefined, Infinity));
  // Brightness after the capped gain, and the gamma that maps it to the target: (reached/255)^(1/gamma) = 105/255.
  const reached = 115 / (want / exp);
  const gamma = want > exp ? Math.min(1.3, Math.log(255 / reached) / Math.log(255 / 115)) : 1;
  const lut = (gain: number) =>
    Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 * Math.min(1, (v * gain * exp) / 255) ** (1 / gamma)));
  const curves = wb.map(lut);
  const corrected = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) corrected[i] = curves[i % 3]![pixels.rgb[i]!]!;

  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      rgba[i * 4] = corrected[i * 3]!;
      rgba[i * 4 + 1] = corrected[i * 3 + 1]!;
      rgba[i * 4 + 2] = corrected[i * 3 + 2]!;
      rgba[i * 4 + 3] = alpha[i]!;
      if (alpha[i]! > 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("Couldn't find the item in this photo.");

  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const item = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .extract({ left: x0, top: y0, width: bw, height: bh })
    .png()
    .toBuffer();
  const side = Math.round(Math.max(bw, bh) * 1.2);
  const left = Math.round((side - bw) / 2);
  const top = Math.round((side - bh) / 2 - side * 0.02);

  // Soft contact shadow from the item's own silhouette, nudged down, so it sits on the surface.
  const blurPx = Math.max(4, Math.round(Math.max(bw, bh) * 0.025));
  const silhouette = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .extract({ left: x0, top: y0, width: bw, height: bh })
    .extractChannel(3)
    .raw()
    .toBuffer();
  const shadowRgba = Buffer.alloc(bw * bh * 4);
  for (let i = 0; i < bw * bh; i++) shadowRgba[i * 4 + 3] = Math.round(silhouette[i]! * 0.3);
  const pad = blurPx * 3;
  const shadow = await sharp(shadowRgba, { raw: { width: bw, height: bh, channels: 4 } })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .blur(blurPx)
    .png()
    .toBuffer();

  // Composite first, then resize in a separate pass: sharp applies resize before composite within one pipeline.
  const square = await sharp({ create: { width: side, height: side, channels: 3, background: STUDIO_BG } })
    .composite([
      { input: shadow, left: Math.max(0, left - pad), top: Math.max(0, top - pad + Math.round(bh * 0.03)) },
      { input: item, left, top: Math.max(0, top) },
    ])
    .png()
    .toBuffer();
  const data = await sharp(square)
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { withoutEnlargement: true })
    .sharpen({ sigma: 0.6 })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  return { data, mediaType: "image/jpeg" };
}

/**
 * Resizes the model's mask to the photo and fills what outline models tend to
 * punch out of garments: an open jacket's lining, a collar label, the inside of
 * a bag. Gaps up to ~6% of the width are bridged (dilate, then erode), and any
 * background region that can't reach the image border is filled as item.
 */
async function cleanMask(mask: Buffer, W: number, H: number): Promise<Buffer> {
  const sharp = await loadSharp();
  const radius = Math.max(2, Math.round(W * 0.03));
  // extractChannel(0) after each step: sharp can hand back 3-channel sRGB from a 1-channel input.
  const binary = await sharp(mask).resize(W, H, { fit: "fill" }).greyscale().threshold(128).extractChannel(0).raw().toBuffer();
  const asImage = (buf: Buffer) => sharp(buf, { raw: { width: W, height: H, channels: 1 } });
  const dilated = await asImage(binary).blur(radius).threshold(25).extractChannel(0).raw().toBuffer();
  const closed = await asImage(dilated).blur(radius).threshold(230).extractChannel(0).raw().toBuffer();

  // Flood the background in from the border; whatever it can't reach is enclosed by the item.
  const outside = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  const seed = (i: number) => {
    if (!outside[i] && closed[i]! <= 128) {
      outside[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < W; x++) {
    seed(x);
    seed((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    seed(y * W);
    seed(y * W + W - 1);
  }
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % W;
    if (x > 0) seed(i - 1);
    if (x < W - 1) seed(i + 1);
    if (i >= W) seed(i - W);
    if (i < W * (H - 1)) seed(i + W);
  }

  const out = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) out[i] = binary[i]! > 128 || !outside[i] ? 255 : 0;
  const soft = await asImage(out).blur(1).extractChannel(0).raw().toBuffer();
  if (soft.length !== W * H) throw new Error(`Mask size mismatch: ${soft.length} != ${W * H}`);
  return soft;
}

/** Share of the frame the mask marks as item; used to reject broken masks. */
export async function maskCoverage(mask: Buffer): Promise<number> {
  const sharp = await loadSharp();
  const { data } = await sharp(mask).greyscale().raw().toBuffer({ resolveWithObject: true });
  let on = 0;
  for (const v of data) if (v > 128) on++;
  return on / data.length;
}

/**
 * Re-encodes any image as a JPEG of at most 1600px. Image models can return
 * multi-megabyte PNGs, which are too big to send for review and slow to upload.
 */
export async function toListingJpeg(img: ImageData): Promise<ImageData> {
  const sharp = await loadSharp();
  const data = await sharp(img.data)
    .rotate()
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: STUDIO_BG })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  return { data, mediaType: "image/jpeg" };
}
