import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Keep unit tests independent of the Cloudflare/Vinext application plugins.
 * Those plugins configure Worker environments that are intentionally
 * incompatible with Vitest's Node environment.
 */
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
