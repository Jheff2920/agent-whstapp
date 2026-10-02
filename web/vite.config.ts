import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// En desarrollo (npm run web:dev) las llamadas a /api van al panel del cerebro en el puerto 3001.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3001" } },
});
