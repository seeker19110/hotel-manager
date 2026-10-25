// Gắn sự kiện sản phẩm vào pipeline lệnh (PM-METRIC-001/003): bảng lệnh → sự kiện + cách rút thuộc tính từ ĐẦU VÀO ĐÃ VALIDATE của lệnh.
// Chỉ lấy enum/số đếm/bool — không bao giờ sao chép chuỗi của đầu vào. Gọi SAU khi lệnh commit và chỉ với lần chạy đầu (replay cùng
// Idempotency-Key không tính lại). `track()` không ném lỗi I/O; lỗi lập trình bị bắt ở đây và ghi log — không làm hỏng lệnh đã commit.

import { appLogger } from "../logging/index.ts";
import type { EventName, EventProps } from "./events.ts";
import { AnalyticsError, type AnalyticsSink, track } from "./track.ts";

interface Mapping {
  event: EventName;
  props(input: unknown, data: unknown): unknown;
}

const mapping = <E extends EventName>(
  event: E,
  props: (input: Record<string, unknown>, data: Record<string, unknown>) => EventProps<E>,
): Mapping => ({
  event,
  props: (input, data) =>
    props((input ?? {}) as Record<string, unknown>, (data ?? {}) as Record<string, unknown>),
});

const len = (v: unknown, max: number): number => (Array.isArray(v) ? Math.min(v.length, max) : 0);

export const COMMAND_EVENTS: Readonly<Record<string, Mapping>> = {
  "org.create": mapping("organization.registered", () => ({})),
  "lease.createDraft": mapping("lease.created", (i) => ({
    occupant_count: len(i.occupants, 19),
    has_end_date: typeof (i.terms as { effective_to?: unknown } | undefined)?.effective_to === "string",
  })),
  "billing.issuePeriod": mapping("billing_period.issued", () => ({})),
  "payment.record": mapping("payment.recorded", (i) => ({
    method: i.method === "cash" ? "cash" : "bank_transfer",
  })),
  "stay.checkIn": mapping("stay.checked_in", (i) => ({ guest_count: len(i.guests, 50) })),
  "stay.walkIn": mapping("stay.walked_in", (i) => ({ guest_count: len(i.guests, 50) })),
};

/** Lệnh `command` có sự kiện sản phẩm? Ghi nếu có; không có thì không làm gì. `orgId` của lệnh cấp người dùng (org.create) lấy từ kết quả. */
export async function trackCommand(
  sink: AnalyticsSink,
  args: { command: string; orgId: string; userId: string; input: unknown; data: unknown },
): Promise<void> {
  const m = Object.hasOwn(COMMAND_EVENTS, args.command) ? COMMAND_EVENTS[args.command] : undefined;
  if (!m) return;
  try {
    await track(sink, {
      event: m.event,
      orgId: args.orgId,
      userId: args.userId,
      props: m.props(args.input, args.data) as never,
    });
  } catch (err) {
    // Lệnh ĐÃ commit: lỗi lập trình của ánh xạ sự kiện không được biến thành 500 (client sẽ tưởng lệnh hỏng). Ghi log mức error để
    // phát hiện; test ánh xạ (analytics.test.ts) là nơi bắt lỗi này trước khi lên production.
    if (!(err instanceof AnalyticsError)) throw err;
    appLogger().error("analytics.invalid_event", { command: args.command, event: m.event });
  }
}
