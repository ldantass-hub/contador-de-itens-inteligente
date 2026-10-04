import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["artifacts/**/*.test.ts", "artifacts/**/*.test.tsx"],
  },
});
