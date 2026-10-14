// Usage: npm run intake -- --floor 40 [--notes "..."] [--ship 8] [--seller-pays] photo1.jpg photo2.jpg ...
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { CHANNELS, type ChannelId } from "@agentic-selling/core";
import { runIntake } from "../intake.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    floor: { type: "string" },
    notes: { type: "string", default: "" },
    ship: { type: "string", default: "8" },
    "seller-pays": { type: "boolean", default: false },
    channels: { type: "string", default: "ebay,poshmark,mercari,depop,vinted,grailed" },
  },
});

const floorNet = Number(values.floor);
if (!positionals.length || !Number.isFinite(floorNet) || floorNet <= 0) {
  console.error('Usage: npm run intake -- --floor 40 [--notes "..."] [--ship 8] [--seller-pays] photos/*.jpg');
  process.exit(1);
}

const result = await runIntake(
  {
    photos: positionals,
    floorNet,
    sellerNotes: values.notes,
    labelCost: Number(values.ship),
    sellerPaysShipping: values["seller-pays"],
    enabledChannels: values.channels.split(",").map((s) => s.trim()) as ChannelId[],
  },
  (msg) => console.log(`… ${msg}`),
);

const { facts, routes, drafts } = result;
console.log(`\n${facts.title}  (${facts.condition}, confidence: ${facts.confidence})`);
console.log(`Estimated sold price: $${facts.estimatedSoldPriceRange.low}-$${facts.estimatedSoldPriceRange.high}\n`);

console.table(
  routes.map((r) => {
    const p = result.prices[r.channel];
    return {
      channel: CHANNELS[r.channel].name,
      list: p ? `$${p.listPrice}` : "",
      "accept ≥": p ? `$${p.minAcceptPrice}` : "",
      "you keep": p ? `$${p.expectedNet}` : "",
      post: r.selected ? "✓" : "",
      why: r.reason,
    };
  }),
);

for (const d of drafts) console.log(`\n[${CHANNELS[d.channel].name}] ${d.title}`);
if (facts.questionsForSeller.length) {
  console.log("\nPlease confirm:");
  for (const q of facts.questionsForSeller) console.log(`  - ${q}`);
}

await mkdir("out", { recursive: true });
const slug = facts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
const file = `out/${slug}-${Date.now()}.json`;
await writeFile(file, JSON.stringify(result, null, 2));
console.log(`\nFull result: ${file}`);
