// One absolute path for the saved session, imported by both the config and
// global setup. A bare relative path resolves against the config directory in
// one and process.cwd() in the other, and a mismatch is silent: every spec just
// looks logged out.
//
// Resolved from cwd rather than from this file's own location because
// Playwright transpiles config and setup to CommonJS, where `import.meta` is a
// syntax error (CI run 7). Both processes are launched from the repo root, so
// cwd is the stable anchor here.
import { resolve } from "node:path";

export const STORAGE_STATE = resolve(process.cwd(), "e2e", ".auth", "user.json");
