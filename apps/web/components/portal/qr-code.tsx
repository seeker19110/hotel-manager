import { qrMatrix } from "@hm/app";

/** Mã QR dạng SVG (module vuông, vùng yên tĩnh 4 ô). `label` là văn bản thay thế đủ để chép tay (SPEC-portal §5). */
export function QrCode({ payload, label }: { payload: string; label: string }) {
  const m = qrMatrix(payload);
  const n = m.length;
  const q = 4;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y]?.[x]) d += `M${x + q} ${y + q}h1v1h-1z`;
  return (
    <svg
      className="qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${n + q * 2} ${n + q * 2}`}
      shapeRendering="crispEdges"
      data-testid="qr"
    >
      <rect width="100%" height="100%" fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
