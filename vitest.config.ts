import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
    fileParallelism: false,
    // Ensure .env is loaded in test workers
    setupFiles: ["dotenv/config"],
  },
});
