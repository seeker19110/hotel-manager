// Cầu nối gọn cho lớp command (PLAN T-2309): lấy tổ chức/người thao tác từ ngữ cảnh lệnh rồi gọi `track()` trong CHÍNH transaction
// của lệnh (sự kiện rollback cùng lệnh). Kiểu cấu trúc (không import `pipeline`) để module analytics không phụ thuộc ngược.
import type { Transaction } from "kysely";
import type { EventName } from "./events.ts";
import { type TrackOptions, type TrackResult, track } from "./track.ts";

export interface CommandTrackSource {
  trx: Transaction<unknown>;
  actor: { orgId: string; authUserId: string };
}

export function trackCommand(
  ctx: CommandTrackSource,
  name: EventName,
  props: Record<string, unknown>,
  extra: { propertyId?: string | null; occurredAt?: Date } = {},
  opts?: TrackOptions,
): Promise<TrackResult> {
  return track(
    name,
    props,
    {
      db: ctx.trx,
      organizationId: ctx.actor.orgId,
      propertyId: extra.propertyId ?? null,
      actorUserId: ctx.actor.authUserId,
      ...(extra.occurredAt ? { occurredAt: extra.occurredAt } : {}),
    },
    opts,
  );
}
