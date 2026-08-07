import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * Next.js 16 flat config — `next lint` was removed; run `eslint .` instead.
 *
 * React Compiler rules from eslint-config-next are useful signal but currently
 * fire on established client patterns (effect sync, Date.now in helpers). Keep
 * them as warnings so CI stays a gate without a full UI rewrite in this pass.
 */
export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
      "react/no-unescaped-entities": "warn",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/**",
  ]),
]);
