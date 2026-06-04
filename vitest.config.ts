import { loadEnv } from "vite"
import { defineConfig } from "vitest/config"

const testEnv = {
  ...loadEnv("test", "./apps/server", ""),
  ANON_SESSION_SECRET: "test-anon-session-secret-32-bytes-long",
  CLAIM_TOKEN_PEPPER: "test-claim-token-pepper",
}

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
          env: testEnv,
        },
      },
      {
        test: {
          include: [
            "packages/**/tests/**/*.integration.test.ts",
            "apps/worker/tests/**/*.integration.test.ts",
            "apps/server/tests/**/*.integration.test.ts",
            "apps/crawler/tests/**/*.integration.test.ts",
          ],
          exclude: ["packages/*/node_modules"],
          name: { label: "integration", color: "magenta" },
          env: testEnv,
          globalSetup: ["./packages/persistence/tests/vitest.integration.setup.ts"],
        },
      },
    ],
  },
})
