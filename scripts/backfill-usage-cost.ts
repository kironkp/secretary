// Price the usage rows that were written before costs were recorded.
//
// Idempotent: only touches rows whose cost is still null, so it is safe to
// re-run after adding a rate for a model that was previously unknown.
//
//   npx tsx --env-file=.env.local scripts/backfill-usage-cost.ts [--dry]
import { isNull } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { usage } from "@/lib/db/schema";
import { priceUsage, formatUsd } from "@/lib/pricing";

async function main() {
  const dry = process.argv.includes("--dry");
  const rows = await db.select().from(usage).where(isNull(usage.costUsd));
  console.log(`${rows.length} unpriced rows`);

  let total = 0;
  let estimated = 0;
  const byKind = new Map<string, { n: number; usd: number }>();

  for (const row of rows) {
    const priced = priceUsage({
      model: row.model,
      kind: row.kind,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      seconds: row.seconds,
      audioInputTokens: row.audioInputTokens,
      audioOutputTokens: row.audioOutputTokens,
      cachedInputTokens: row.cachedInputTokens,
      // Price historical rows with the card that was in force at the time.
      at: row.createdAt,
    });
    total += priced.usd;
    if (priced.estimated || !priced.known) estimated++;
    const bucket = byKind.get(row.kind) ?? { n: 0, usd: 0 };
    byKind.set(row.kind, { n: bucket.n + 1, usd: bucket.usd + priced.usd });

    if (!dry) {
      await db
        .update(usage)
        .set({
          costUsd: priced.usd.toFixed(6),
          costEstimated: priced.estimated || !priced.known,
        })
        .where(eq(usage.id, row.id));
    }
  }

  console.log(`\n${dry ? "would price" : "priced"} ${rows.length} rows — ${formatUsd(total)} total`);
  console.log(`${estimated} of them estimated (unknown model, or audio split not recorded)\n`);
  for (const [kind, b] of [...byKind.entries()].sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`  ${kind.padEnd(12)} ${String(b.n).padStart(4)} rows  ${formatUsd(b.usd).padStart(9)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
