// Slow-loop generation job (SPEC §7): assemble the brief for a wish and run
// headless Claude Code (`claude -p`) to author a declarative template
// component. Output only ever lands in components/proposed/<name>/ — the app
// runtime never sees it until a human approves.
//
//   npx tsx scripts/slow-loop.ts --wish <id>     one wish (on-demand trigger)
//   npx tsx scripts/slow-loop.ts --nightly       all candidates (>=3 or priority)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { wishlist } from "@/lib/db/schema";
import {
  assembleBrief,
  nightlyCandidates,
  parseProposal,
  slugify,
  writeProposal,
} from "@/lib/layout/slow-loop";

const exec = promisify(execFile);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

async function buildWish(wishId: string): Promise<void> {
  const [wish] = await db.select().from(wishlist).where(eq(wishlist.id, wishId));
  if (!wish || wish.tombstoned) {
    console.error(`wish ${wishId}: missing or tombstoned — skipping`);
    return;
  }
  const brief = assembleBrief(wish);
  console.log(`building "${wish.need}" via ${CLAUDE_BIN} -p …`);
  const { stdout } = await exec(
    CLAUDE_BIN,
    ["-p", brief, "--output-format", "text", "--allowedTools", ""],
    { timeout: GENERATION_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
  );
  const proposal = parseProposal(stdout);
  if (!proposal) {
    console.error(`wish ${wishId}: generation output didn't match the contract; leaving open`);
    await db
      .update(wishlist)
      .set({ status: "open", updatedAt: new Date() })
      .where(eq(wishlist.id, wishId));
    return;
  }
  // The proposal name must not collide with an approved/base component.
  proposal.meta.name = proposal.meta.name || slugify(wish.need);
  const dir = writeProposal(proposal, brief);
  await db
    .update(wishlist)
    .set({ status: "proposed", proposalName: proposal.meta.name, updatedAt: new Date() })
    .where(eq(wishlist.id, wishId));
  console.log(`proposal ready: ${dir} — approve it in chat or Settings`);
}

async function main() {
  const args = process.argv.slice(2);
  const wishFlag = args.indexOf("--wish");
  if (wishFlag !== -1) {
    await buildWish(args[wishFlag + 1]);
  } else if (args.includes("--nightly")) {
    const users = await db.selectDistinct({ userId: wishlist.userId }).from(wishlist);
    for (const { userId } of users) {
      for (const wish of await nightlyCandidates(userId)) {
        try {
          await buildWish(wish.id);
        } catch (e) {
          console.error(`wish ${wish.id} failed:`, e instanceof Error ? e.message : e);
        }
      }
    }
  } else {
    console.error("usage: npx tsx scripts/slow-loop.ts --wish <id> | --nightly");
    process.exit(1);
  }
  process.exit(0);
}

void main();
