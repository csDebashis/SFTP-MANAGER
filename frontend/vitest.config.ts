import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Full Material UI modal workflows can exceed Vitest's five-second
    // default when every suite competes for CPU inside the Podman test image.
    testTimeout: 15_000,
  },
});
