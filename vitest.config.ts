import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // jsdom gives us a real-enough `document`/`window` so tests can assert
    // on the DOM tree produced by render/reconciliation.
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
