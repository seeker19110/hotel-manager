// Sinh icon PWA (PNG) không cần thư viện ảnh: nền màu thương hiệu + hình ngôi nhà trắng. Chạy lại khi đổi màu/kích thước:
//   node apps/web/scripts/gen-icons.mjs
// Icon maskable giữ hình trong vùng an toàn (hình tròn 80% ở giữa) theo đặc tả Web App Manifest.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [0x0f, 0x4c, 0x81];
const FG = [0xff, 0xff, 0xff];
const OUT = new URL("../public/icons/", import.meta.url);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Ngôi nhà trong hình vuông đơn vị [0,1]²: mái tam giác, thân chữ nhật, cửa (lỗ) ở giữa. */
function isHouse(x, y) {
  const roof = y >= 0.1 && y <= 0.45 && Math.abs(x - 0.5) <= (y - 0.1) * (0.5 / 0.35);
  const body = y > 0.45 && y <= 0.9 && x >= 0.18 && x <= 0.82;
  const door = y > 0.62 && y <= 0.9 && x >= 0.42 && x <= 0.58;
  return (roof || body) && !door;
}

function png(size, scale) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const pad = (1 - scale) / 2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size - pad) / scale;
      const v = ((y + 0.5) / size - pad) / scale;
      const c = u >= 0 && u <= 1 && v >= 0 && v <= 1 && isHouse(u, v) ? FG : BG;
      raw.set(c, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const ICONS = [
  ["icon-192.png", 192, 0.7],
  ["icon-512.png", 512, 0.7],
  ["maskable-512.png", 512, 0.5],
  ["apple-touch-icon.png", 180, 0.62],
];
for (const [name, size, scale] of ICONS) writeFileSync(new URL(name, OUT), png(size, scale));
console.log(`đã sinh ${ICONS.length} icon vào apps/web/public/icons/`);
