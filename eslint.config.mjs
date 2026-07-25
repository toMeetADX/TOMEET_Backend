import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const backendTypeScriptFiles = [
  "apps/api/**/*.ts",
  "apps/intelligence-worker/**/*.ts",
  "apps/wechat-ilink-worker/**/*.ts",
  "packages/**/*.ts"
];

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/coverage/**",
    "**/*.d.ts"
  ]),
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: backendTypeScriptFiles
  })),
  {
    files: backendTypeScriptFiles,
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
]);
