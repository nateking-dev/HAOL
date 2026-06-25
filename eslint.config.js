import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    // Build output, deps, and version-control dirs are never linted.
    ignores: ["dist/**", "node_modules/**", ".dolt/**", ".doltcfg/**", "haol/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Allow intentionally-unused args/vars when prefixed with `_`.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests lean on vitest mocking, which legitimately needs `any` and
    // empty stub functions; relax the strictest rules there.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  {
    // Operational scripts (demo setup, load test) — not shipped code; allow
    // `any` in catch clauses and ternary-as-statement health-check reporting.
    files: ["scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
  {
    // Static browser assets — vanilla JS with browser globals, where
    // top-level classes/consts are consumed by inline <script> tags / other files.
    files: ["public/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // Top-level consts/classes are shared across files via <script> tags,
      // so unused-in-file and undefined-in-file are expected here.
      "no-unused-vars": "off",
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
