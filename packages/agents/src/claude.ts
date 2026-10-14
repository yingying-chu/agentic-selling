import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { record, route, ROUTES, type Task } from "./models.ts";

const GATEWAY_URL = "https://ai-gateway.vercel.sh";

/**
 * With AI_GATEWAY_API_KEY set, requests go through Vercel AI Gateway (one bill,
 * provider failover). Otherwise they go straight to Anthropic using
 * ANTHROPIC_API_KEY or an `ant auth login` profile.
 */
export const viaGateway = (): boolean => Boolean(process.env.AI_GATEWAY_API_KEY);

let client: Anthropic | undefined;
export function claude(): Anthropic {
  client ??= viaGateway()
    ? new Anthropic({ baseURL: GATEWAY_URL, apiKey: process.env.AI_GATEWAY_API_KEY })
    : new Anthropic();
  return client;
}

/** Gateway slug ("anthropic/claude-opus-5.5") → direct Anthropic API ID ("claude-opus-5-5"). */
const directId = (slug: string) => slug.replace(/^anthropic\//, "").replaceAll(".", "-");

type ParseParams = Omit<Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, "model" | "output_config"> & {
  effort: "low" | "medium" | "high";
};

/**
 * One structured Claude call for a task: routed through the Gateway with the
 * task's backup models, recorded for the trace, and parsed tolerantly so a
 * backup model that wraps its JSON in prose still works.
 */
export async function structuredCall<S extends z.ZodType>(task: Task, schema: S, params: ParseParams): Promise<z.infer<S>> {
  const { effort, ...rest } = params;
  const r = route(task);
  const started = Date.now();
  const gatewayExtras: object = viaGateway() ? { providerOptions: r.providerOptions } : {};
  const res = await claude().beta.messages.parse({
    ...rest,
    ...gatewayExtras,
    model: viaGateway() ? r.model : directId(ROUTES[task].models[0]),
    output_config: { effort, format: zodOutputFormat(schema) },
  });
  record(task, r.model, started, (res as unknown as { provider_metadata?: { gateway?: object } }).provider_metadata?.gateway);

  if (res.stop_reason === "refusal") {
    throw new Error(`The model declined this request: ${res.stop_details?.explanation ?? "no details"}`);
  }
  if (res.parsed_output) return res.parsed_output as z.infer<S>;
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = json ? schema.safeParse(safeJson(json)) : null;
  if (parsed?.success) return parsed.data;
  throw new Error(`${ROUTES[task].label}: no usable answer (stop_reason: ${res.stop_reason})`);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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
