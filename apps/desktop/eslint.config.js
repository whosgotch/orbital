import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src-tauri", "scripts"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      // The worker's NDJSON payloads arrive untyped; casts happen at the loader
      // boundary, so blanket bans on assertions would fight the architecture.
      "@typescript-eslint/no-non-null-assertion": "off",
      // `const { gone, ...rest } = obj` is the idiomatic way to drop a key.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
);
