import { defineConfig } from "vite";

// UXP loads a classic script from index.html, so the bundle is emitted as a
// single self-contained IIFE. Static shell files (manifest.json, index.html)
// live in `static/` and are copied verbatim into `dist/`.
export default defineConfig({
  publicDir: "static",
  build: {
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    minify: false,
    lib: {
      entry: "src/main.ts",
      formats: ["iife"],
      name: "EditToolbox",
      fileName: () => "index.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: "index.[ext]",
      },
    },
  },
});
