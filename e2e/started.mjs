// Run by playwright.config.ts just before it starts the app server: a mark that this run started it (v1.10). A
// spec that must not meet a reused server checks for its run's mark (e2e/task-notes.spec.ts).
import { mkdirSync, writeFileSync } from "node:fs";

const id = process.env.E2E_RUN_ID;
if (!id) throw new Error("E2E_RUN_ID is not set: run the browser tests through playwright.config.ts");
mkdirSync("e2e/.runs", { recursive: true });
writeFileSync(`e2e/.runs/${id}`, `${new Date().toISOString()}\n`);
