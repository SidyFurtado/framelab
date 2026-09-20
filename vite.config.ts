import { defineConfig } from "vite";

// UXP loads a classic script from index.html, so the bundle is emitted as a
// single self-contained IIFE. Static shell files (manifest.json, index.html)
// live in `static/` and are copied verbatim into `dist/`.
/**
 * O carimbo do build.
 *
 * Duas builds da mesma versão são indistinguíveis dentro do Premiere, e
 * foi exatamente isso que fez uma tarde inteira ser gasta consertando um
 * bug que já estava consertado — só que num arquivo que o host não
 * estava carregando. O carimbo sai no console assim que o painel abre e
 * fica no título da versão, ao lado do ponteiro.
 */
const BUILD_STAMP = new Date()
  .toISOString()
  .replace("T", " ")
  .slice(0, 19);

export default defineConfig({
  publicDir: "static",
  define: {
    __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
  },
  build: {
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    minify: false,
    lib: {
      entry: "src/main.ts",
      formats: ["iife"],
      name: "Framelab",
      fileName: () => "index.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: "index.[ext]",
      },
    },
  },
});
