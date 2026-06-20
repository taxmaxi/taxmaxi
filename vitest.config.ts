import { loadEnv } from "vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    watch: false,
    coverage: {
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
    },
    projects: [
      {
        test: {
          include: [
            "packages/**/tests/**/*.test.ts",
            "apps/crawler/tests/**/*.test.ts",
            "apps/server/tests/**/*.test.ts",
            "apps/worker/tests/**/*.test.ts",
          ],
          exclude: [
            "packages/**/tests/**/*.integration.test.ts",
            "apps/worker/tests/**/*.integration.test.ts",
            "packages/*/node_modules",
          ],
          name: { label: "unit", color: "cyan" },
          env: loadEnv("test", "./apps/server", ""),
        },
      },
      {
        test: {
          include: [
            "packages/**/tests/**/*.integration.test.ts",
            "apps/**/tests/**/*.integration.test.ts",
          ],
          exclude: ["packages/*/node_modules"],
          name: { label: "integration", color: "magenta" },
          env: loadEnv("test", "./apps/server", ""),
          globalSetup: ["./packages/persistence/tests/vitest.integration.setup.ts"],
        },
      },
    ],
  },
})
