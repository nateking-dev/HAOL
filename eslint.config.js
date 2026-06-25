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
      // Allow the `cond ? ok() : warn()` reporting pattern, but keep the rule
      // on so bare `cond && fn()` statement bugs are still caught.
      "@typescript-eslint/no-unused-expressions": ["error", { allowTernary: true }],
    },
  },
  {
    // Static browser assets — vanilla JS with browser globals, plus the small,
    // stable set of cross-file globals shared via <script> tags.
    files: ["public/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        API: "readonly", // public/js/api.js
        CascadeViz: "readonly", // public/js/cascade-viz.js
        DEMO_PROMPTS: "readonly", // public/js/prompts.js
      },
    },
    rules: {
      // Top-level consts/classes are consumed by sibling scripts, so
      // unused-in-file is expected; no-undef stays on (only the known
      // cross-file globals above are whitelisted).
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
