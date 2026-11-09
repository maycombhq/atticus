import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      // The SDK as npm publishes it, bundled by its build (ADR 0124 addendum D-npm2).
      "packages/sdk/npm/**",
      // Pinned downloads (ADR 0116 addendum).
      ".cache/**",
      "**/dist-test/**",
      // Gradle's output for the IntelliJ plugin (ADR 0099).
      "packages/intellij/build/**",
      "packages/intellij/.gradle/**",
      // The app's build, copied into the VS Code extension when it is packaged (ADR 0097).
      "packages/vscode/media/app/**",
      "**/coverage/**",
      "**/node_modules/**",
      "packages/core/schema/**",
      "fixtures/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Review round 47: an order that feeds records, ids, hashes or a merge is the same in every
    // locale, so these packages sort with `cmpText` / `cmpNatural` from @maycombhq/core, never
    // `localeCompare` (ICU orders `_` and `-`, and `aa` in Danish, differently by locale).
    files: [
      "packages/core/src/**/*.ts",
      "packages/scanner/src/**/*.ts",
      "packages/verify/src/**/*.ts",
      "packages/extractors/src/**/*.ts",
      "packages/release/src/**/*.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='localeCompare']",
          message:
            "localeCompare depends on the locale: use cmpText (or cmpNatural) from @maycombhq/core.",
        },
      ],
    },
  },
);
