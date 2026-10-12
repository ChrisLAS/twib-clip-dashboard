import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "apps/worker/src/inventory/validator.generated.js",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "error" } },
  {
    files: ["security-review/browser-regression.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        // Used only inside Playwright page.evaluate browser callbacks.
        document: "readonly",
        getComputedStyle: "readonly",
      },
    },
  },
);
