import next from "eslint-config-next";
import tseslint from "typescript-eslint";

const config = [
  ...next,
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "src/generated/**",
      "prisma/migrations/**",
      ".trigger/**",
    ],
  },
];

export default config;
