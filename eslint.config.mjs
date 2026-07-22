import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import { defineConfig, globalIgnores } from "eslint/config";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
  recommendedConfig: js.configs.recommended
});

const nonWebTypeScriptFiles = [
  "apps/api/**/*.ts",
  "apps/intelligence-worker/**/*.ts",
  "packages/**/*.ts"
];
const webRootDirectory = fileURLToPath(new URL("./apps/web/", import.meta.url));
const webTypeScriptFiles = ["apps/web/**/*.{ts,tsx}", "app/**/*.{ts,tsx}"];

const nextConfig = compat
  .config({
    extends: ["next/core-web-vitals", "next/typescript"],
    settings: {
      next: {
        rootDir: webRootDirectory
      }
    }
  })
  .map((config) => ({
    ...config,
    files: webTypeScriptFiles
  }));

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/.next*/**",
    "**/coverage/**",
    "**/*.d.ts"
  ]),
  // Next.js 15 inspects the root config itself during `next build`.
  {
    plugins: {
      "@next/next": nextPlugin
    },
    rules: {
      "@next/next/no-html-link-for-pages": "off"
    }
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: nonWebTypeScriptFiles
  })),
  {
    files: nonWebTypeScriptFiles,
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  },
  ...nextConfig
]);
