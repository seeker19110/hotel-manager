import type { MetadataRoute } from "next";
import { BRAND_BG, BRAND_COLOR } from "../lib/brand.ts";
import { t } from "../lib/i18n.ts";

// S-001: manifest cài đặt (Chrome Android/desktop; iOS dùng apple-touch-icon ở layout).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: t("app.manifest.name"),
    short_name: t("app.short_name"),
    description: t("app.description"),
    lang: "vi",
    dir: "ltr",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    theme_color: BRAND_COLOR,
    background_color: BRAND_BG,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
