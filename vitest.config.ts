import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Test file patterns
    include: ["tests/**/*.{test,spec}.{js,ts}"],

    // Coverage configuration
    coverage: {
      provider: "v8",
      reporter: ["lcov", "html", "text"],
      reportsDirectory: "./coverage",
      exclude: [
        "node_modules/**",
        "dist/**",
        "coverage/**",
        "**/*.config.{js,ts}",
        "**/*.d.ts",
        "**/example.ts",
      ],
      // Coverage thresholds
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },

    // Test environment
    environment: "node",

    // Global setup/teardown
    globals: true,

    // Clear mocks between tests
    clearMocks: true,

    // Fail fast on first test failure (useful for CI)
    bail: 1,
  },
});
