import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The build uses relative asset URLs: the server injects the deployment's
 * base path as the document's <base>, so one build serves any prefix.
 */
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: false,
  },
});
