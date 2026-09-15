import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 3009, strictPort: true, host: "localhost", open: false },
  preview: { port: 3009, strictPort: true },
});
