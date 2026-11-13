import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "replaybr-extended",
  // One version for the package, the manifest and the release tag.
  version: pkg.version,
  description: "Baixa replays do ReplayBR e junta as duas câmeras lado a lado.",
  // The ReplayBR symbol, cropped from the site's logo (public/logo-comfundo.png).
  icons: {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  },
  action: {
    default_title: "replaybr-extended",
    default_icon: { 16: "icons/icon16.png", 32: "icons/icon32.png" },
  },
  background: { service_worker: "src/background.ts", type: "module" },
  // The browser's own session (Cloudflare cookies included) rides along
  // with requests to these hosts; nothing else is needed.
  host_permissions: [
    "https://replays.replaybr.com.br/*",
    "https://www.replaybr.com.br/*",
  ],
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
});
