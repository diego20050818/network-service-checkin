import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  workers: 1,
  reporter: "list",
  use: {
    trace: "retain-on-failure",
  },
});

