import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const serverPort = process.env.SERVER_PORT?.trim() || process.env.PORT?.trim() || "80";

export default defineConfig({
  base: "/uno/",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    proxy: {
      "/uno/socket.io": {
        target: `http://localhost:${serverPort}`,
        ws: true,
      },
      "/api": `http://localhost:${serverPort}`,
    },
  },
  test: {
    environment: "node",
  },
});
