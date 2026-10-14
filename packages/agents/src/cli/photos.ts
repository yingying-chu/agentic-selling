// Usage: npm run photos -- [--model] [--regenerate] photo1.jpg photo2.jpg ...
// Writes listing-ready photos to out/photos-<timestamp>/.
import { mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { preparePhotos } from "../claude.ts";
import { identifyItem } from "../identify.ts";
import { improvePhotos } from "../photos/pipeline.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { model: { type: "boolean", default: false }, regenerate: { type: "boolean", default: false } },
});
if (!positionals.length) {
  console.error("Usage: npm run photos -- [--model] [--regenerate] photos/*.jpg");
  process.exit(1);
}

const prepared = await preparePhotos(positionals);
console.log("… Identifying item");
const facts = await identifyItem(prepared);
console.log(`  ${facts.title} (size ${facts.size ?? "?"})`);

const inputs = await Promise.all(
  positionals.map(async (p, i) => ({ source: p, data: Buffer.from(prepared[i]!.data, "base64"), mediaType: "image/jpeg" as const })),
);
const result = await improvePhotos(inputs, facts, {
  modelPhoto: values.model,
  regenerateIfNoCover: values.regenerate,
  log: (m) => console.log(`… ${m}`),
});

const dir = `out/photos-${Date.now()}`;
await mkdir(dir, { recursive: true });
for (const [i, o] of result.outputs.entries()) {
  const ext = o.mediaType.split("/")[1];
  const from = o.source ? `-from-${basename(o.source).replace(/\.\w+$/, "")}` : "";
  await writeFile(`${dir}/${String(i + 1).padStart(2, "0")}-${o.kind}${from}.${ext}`, o.data);
}
await writeFile(`${dir}/review.json`, JSON.stringify({ assessment: result.assessment, rejected: result.rejected, retakeTips: result.retakeTips }, null, 2));

console.table(result.assessment.photos.map((p) => ({ photo: p.index + 1, shows: p.shows, quality: p.quality, issues: p.issues.join("; ") })));
for (const r of result.rejected) console.log(`✗ Dropped ${r.kind}: ${r.issues.join("; ")}`);
for (const t of result.retakeTips) console.log(`↻ ${t}`);
if (result.assessment.missingShots.length) console.log(`+ Worth adding: ${result.assessment.missingShots.join(", ")}`);
console.log(`\n${result.outputs.length} photos written to ${dir}/`);

