import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Simulation harness artifacts (generated build output + reports):
    ".next-sim/**",
    ".pgdata-sim/**",
    "sim/reports/**",
    // Verify builds (NEXT_DIST_DIR=.next-verify-<name> npx next build), so a
    // lint run while one exists does not read its generated code.
    ".next-verify*/**",
  ]),
]);

export default eslintConfig;
