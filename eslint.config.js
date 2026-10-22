import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
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
);
