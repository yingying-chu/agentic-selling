import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelCall } from "@agentic-selling/core";

// Which model does what, and what happens when one fails.
//
// Every task has a primary model chosen for the job's cost/latency/quality
// trade-off, plus backups. Requests go through Vercel AI Gateway, which tries
// each model across its providers (e.g. Claude on Anthropic, then Vertex,
// then Bedrock) before moving to the next model. Every call is recorded so the
// app can show which model actually answered, on which provider, how long it
// took, and what it cost.

export type Task = "identify" | "photo_review" | "listings" | "fidelity" | "mask" | "render";

export interface Route {
  label: string;
  modality: string;
  models: [string, ...string[]];
  providers: string[];
  why: string;
}

export const ROUTES: Record<Task, Route> = {
  identify: {
    label: "Identify item",
    modality: "photos → details",
    models: ["anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5"],
    providers: ["anthropic", "vertex", "bedrock"],
    why: "Reading tags right sets the price, and it runs once per item, so it gets the strongest vision model.",
  },
  photo_review: {
    label: "Grade photos",
    modality: "photos → scores",
    models: ["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"],
    providers: ["anthropic", "vertex", "bedrock"],
    why: "A simple good/fixable/retake call; Haiku is ~40× cheaper than Opus and the fastest.",
  },
  listings: {
    label: "Write listings",
    modality: "text → text",
    models: ["anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5", "anthropic/claude-opus-5.5"],
    providers: ["anthropic", "vertex", "bedrock"],
    why: "Good marketplace copy at half Opus's price and faster; nothing here needs top-tier reasoning.",
  },
  fidelity: {
    label: "Honesty check",
    modality: "photos → verdict",
    models: ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"],
    providers: ["anthropic", "vertex", "bedrock"],
    why: "Runs on every edited image and must catch changed items reliably; Sonnet balances both.",
  },
  mask: {
    label: "Item outline",
    modality: "photo → mask",
    models: ["google/gemini-nano-banana-2.1", "google/gemini-3.1-flash-image", "google/gemini-2.5-flash-image"],
    providers: ["google", "vertex"],
    why: "Output is just black and white, so the fastest, cheapest image model wins (~$0.03).",
  },
  render: {
    label: "AI model photo",
    modality: "photos → photo",
    models: ["google/gemini-3-pro-image", "google/gemini-nano-banana-2.1", "google/gemini-3.1-flash-image"],
    providers: ["google", "vertex"],
    why: "Buyers see it, so it gets the most faithful image model (~$0.13); cheaper backups are still gated by the honesty check.",
  },
};

/** One recorded call; `failed` lists models that failed before one answered. */
export interface CallTrace extends ModelCall {
  task: Task;
}

interface TraceContext {
  simulateOutage: boolean;
  calls: CallTrace[];
}

const context = new AsyncLocalStorage<TraceContext>();

/** Runs `fn`, recording every model call made inside it. */
export async function withTrace<T>(
  opts: { simulateOutage?: boolean },
  fn: () => Promise<T>,
): Promise<{ result: T; trace: CallTrace[] }> {
  const ctx: TraceContext = { simulateOutage: Boolean(opts.simulateOutage), calls: [] };
  const result = await context.run(ctx, fn);
  return { result, trace: ctx.calls };
}

/**
 * Model and Gateway options for a task. With "simulate outage" on, the
 * primary is swapped for a model ID that doesn't exist, so the Gateway really
 * fails it and really falls back; nothing is faked in the app.
 */
export function route(task: Task): { model: string; providerOptions: { gateway: { models: string[]; order: string[] } } } {
  const r = ROUTES[task];
  const [primary, ...backups] = r.models;
  const simulate = context.getStore()?.simulateOutage;
  return {
    model: simulate ? `${primary}-simulated-outage` : primary,
    providerOptions: { gateway: { models: backups, order: r.providers } },
  };
}

interface GatewayMeta {
  routing?: {
    canonicalSlug?: string;
    finalProvider?: string;
    modelAttempts?: Array<{ canonicalSlug?: string; success?: boolean }>;
  };
  cost?: string | number;
}

/** Records one finished call from the Gateway's routing metadata. */
export function record(task: Task, requested: string, startedAt: number, gateway: GatewayMeta | undefined) {
  const ctx = context.getStore();
  if (!ctx) return;
  const attempts = gateway?.routing?.modelAttempts ?? [];
  const servedBy = gateway?.routing?.canonicalSlug ?? attempts.find((a) => a.success)?.canonicalSlug ?? requested;
  const cost = gateway?.cost !== undefined ? Number(gateway.cost) : null;
  ctx.calls.push({
    task,
    requested: ROUTES[task].models[0],
    servedBy,
    provider: gateway?.routing?.finalProvider ?? null,
    fellBack: servedBy !== ROUTES[task].models[0],
    failed: attempts.filter((a) => a.success === false).map((a) => a.canonicalSlug ?? "?"),
    ms: Date.now() - startedAt,
    costUsd: Number.isFinite(cost) ? cost : null,
  });
}
