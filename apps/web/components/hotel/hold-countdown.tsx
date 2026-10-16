"use client";
// Đếm ngược đến hạn giữ phòng (SPEC-inventory-allocation §5). Hạn tuyệt đối luôn hiện bằng chữ (server render); phần đếm
// ngược chỉ cập nhật sau khi gắn (không lệch HTML server/client) và không bị đọc lặp mỗi giây (aria-hidden).
import { useEffect, useState } from "react";

export function HoldCountdown({ until, untilText }: { until: string; untilText: string }) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const end = new Date(until).getTime();
    const tick = () => setLeft(Math.max(0, Math.floor((end - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [until]);
  return (
    <span data-testid="hold-until">
      Giữ phòng đến {untilText}
      {left === null ? null : left > 0 ? (
        <span className="countdown" aria-hidden="true">
          {" "}
          (còn {Math.floor(left / 60)} phút {String(left % 60).padStart(2, "0")} giây)
        </span>
      ) : (
        <strong> — đã hết hạn giữ phòng</strong>
      )}
    </span>
  );
}
