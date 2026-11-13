import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "replaybr-extended",
  version: "1.0.0",
  description: "Baixa replays do ReplayBR e junta as duas câmeras lado a lado.",
  action: { default_title: "replaybr-extended" },
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
