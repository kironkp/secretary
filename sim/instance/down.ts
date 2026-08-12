// Stop the sim stack. `--wipe` also removes its data + build dirs.
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { cfg } from "../config";

const STATE_FILE = "sim/.instance.json";

function tryKill(pid: number) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

if (existsSync(STATE_FILE)) {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  tryKill(state.nextPid);
  tryKill(state.pgPid);
  unlinkSync(STATE_FILE);
  console.log("sim instance: stopped");
} else {
  console.log("sim instance: no state file — nothing tracked to stop");
}

if (process.argv.includes("--wipe")) {
  rmSync(cfg.pgDataDir, { recursive: true, force: true });
  rmSync(cfg.distDir, { recursive: true, force: true });
  console.log("sim instance: wiped data + build dirs");
}
