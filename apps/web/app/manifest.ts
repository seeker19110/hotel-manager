import type { MetadataRoute } from "next";

// S-001: manifest cài đặt (Chrome Android/desktop; iOS dùng apple-touch-icon ở layout).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Hotel Manager — Quản lý phòng",
    short_name: "Quản lý phòng",
    description: "Quản lý phòng trọ, nhà nghỉ, khách sạn nhỏ",
    lang: "vi",
    dir: "ltr",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    theme_color: "#0f4c81",
    background_color: "#ffffff",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
