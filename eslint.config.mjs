import obsidianmd from "eslint-plugin-obsidianmd";
import { fileURLToPath } from "node:url";
import path from "node:path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export default [
  {
    // These are build/config scripts, not plugin source — keep them
    // out of the typed-linting pass entirely so rules that require
    // type information don't crash on files outside tsconfig's scope.
    ignores: [
      "main.js",
      "node_modules/**",
      "eslint.config.mjs",
      "esbuild.config.mjs",
      "version-bump.mjs",
      "*.mjs",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // The actual dashboard review doesn't flag these — turn them
      // off so local CI output matches the real automated review.
      "obsidianmd/ui/sentence-case": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  },
];
