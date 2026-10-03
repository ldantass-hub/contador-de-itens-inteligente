import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["artifacts/barcode-processor/src/**/*.test.ts"],
  },
});
