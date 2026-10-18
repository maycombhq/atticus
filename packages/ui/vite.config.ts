import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app is static files the local server hands out; relative paths so it works from any root.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
});
