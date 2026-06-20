import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy API + asset routes to the Flask backend so there's no CORS
// dance and the frontend can call relative paths (/api/..., /resume).
const API_TARGET = process.env.VITE_PROXY_TARGET || "http://localhost:5000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT) || 5173,
    host: true,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/resume": { target: API_TARGET, changeOrigin: true },
      "/healthz": { target: API_TARGET, changeOrigin: true },
      "/readyz": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split heavy/stable vendors into their own cached chunks.
        manualChunks: {
          three: ["three"],
          react: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
});
