import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// NOTE: keeping the build minimal and platform-agnostic for clean GH Pages builds.

// https://vitejs.dev/config/
export default defineConfig({
  // Custom domain (karaokeparty.in) serves from root, so base is just "/".
  // NOTE: deploy.yml sets a VITE_BASE_PATH env var during build, but this
  // config never actually reads it -- both happen to resolve to "/" so
  // there's no live bug, but that env var is vestigial (likely left over
  // from an earlier setup before the custom domain, e.g. a GitHub Pages
  // subpath deployment).
  base: "/",
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Raise the chunk warning limit — this app has large deps (HuggingFace, Gradio)
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        // Split large vendor chunks so the browser can cache them separately
        manualChunks: {
          react: ["react", "react-dom"],
          router: ["react-router-dom"],
          supabase: ["@supabase/supabase-js"],
          ui: ["@radix-ui/react-dialog", "@radix-ui/react-toast", "lucide-react"],
        },
      },
    },
  },
});
