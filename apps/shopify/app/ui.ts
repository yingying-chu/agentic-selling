import type { ItemStage } from "@agentic-selling/core";

export const STAGE_LABEL: Record<ItemStage, { label: string; tone: "info" | "caution" | "success" | "neutral" }> = {
  needs_details: { label: "Needs details", tone: "caution" },
  needs_floor: { label: "Needs floor price", tone: "caution" },
  ready_to_list: { label: "Ready to list", tone: "info" },
  listed: { label: "Listed", tone: "success" },
  sold: { label: "Sold", tone: "neutral" },
};

export const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`);
