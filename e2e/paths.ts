// One absolute path for the saved session, imported by both the config and
// global setup. Relative paths resolve against different bases in those two
// places (config dir vs process cwd), and a mismatch reads as "the app logged
// me out" in every spec rather than as a missing file.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const STORAGE_STATE = resolve(here, ".auth", "user.json");
