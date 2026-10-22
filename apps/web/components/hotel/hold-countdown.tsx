"use client";
// Đếm ngược đến hạn giữ phòng (SPEC-inventory-allocation §5). Hạn tuyệt đối luôn hiện bằng chữ (server render); phần đếm
// ngược chỉ cập nhật sau khi gắn (không lệch HTML server/client) và không bị đọc lặp mỗi giây (aria-hidden).

import { MS_PER_SECOND, msToSeconds, SECONDS_PER_MINUTE } from "@hm/app/units";
import { useEffect, useState } from "react";
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";

export function HoldCountdown({
  until,
  untilText,
  m,
}: {
  until: string;
  untilText: string;
  m: Messages<"booking.hold.">;
}) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const end = new Date(until).getTime();
    const tick = () => setLeft(Math.max(0, msToSeconds(end - Date.now())));
    tick();
    const timer = setInterval(tick, MS_PER_SECOND);
    return () => clearInterval(timer);
  }, [until]);
  return (
    <span data-testid="hold-until">
      {tm(m, "booking.hold.until", { until: untilText })}
      {left === null ? null : left > 0 ? (
        <span className="countdown" aria-hidden="true">
          {" "}
          {tm(m, "booking.hold.countdown", {
            minutes: Math.floor(left / SECONDS_PER_MINUTE),
            seconds: String(left % SECONDS_PER_MINUTE).padStart(2, "0"),
          })}
        </span>
      ) : (
        <strong> {tm(m, "booking.hold.expired")}</strong>
      )}
    </span>
  );
}
