// Job hợp đồng chạy trong worker (role app_worker): nhắc hết hạn không gửi lặp (SPEC-lease S-014) và phát hiện ở quá hạn
// chưa bàn giao trả (S-015, INV-I4 — không tự kết thúc allocation, mở ngoại lệ cho quản lý). Đọc xuyên tổ chức qua hàm
// SECURITY DEFINER phạm vi hẹp; ghi trong ngữ cảnh từng tổ chức; chạy lại bao nhiêu lần cũng một hiệu lực.
import { randomUUID } from "node:crypto";
import { withTenantRetry } from "@hm/db";
import { type Kysely, sql } from "kysely";
import {
  openException,
  openRelocationForNextBooking,
  recordWorkerExceptionOpened,
} from "../inventory/index.ts";
import { currentTraceparent } from "../logging/index.ts";

export const DEFAULT_REMINDER_DAYS = [30, 7, 0] as const;

/** Nhắc hết hạn: một outbox `lease.expiring` mỗi (hợp đồng, phiên bản, mốc ngày) nhờ `dedupe_key`. Trả số bản ghi mới. */
export async function remindExpiring(
  workerDb: Kysely<unknown>,
  now: Date,
  days: readonly number[] = DEFAULT_REMINDER_DAYS,
): Promise<number> {
  const due = await sql<{
    organization_id: string;
    property_id: string;
    lease_id: string;
    version_no: number;
    effective_to: string;
    days_left: number;
  }>`select organization_id, property_id, lease_id, version_no, effective_to::text, days_left
     from app.leases_expiring(${now}, ${[...days]}::int[])`.execute(workerDb);
  let created = 0;
  for (const r of due.rows) {
    const key = `lease.expiring:${r.lease_id}:${r.version_no}:${r.days_left}`;
    const ins = await withTenantRetry(workerDb, { orgId: r.organization_id }, (trx) =>
      sql<{ id: string }>`
        insert into outbox (id, organization_id, property_id, event_type, aggregate_type, aggregate_id, payload, correlation_id,
                            dedupe_key, traceparent)
        values (${randomUUID()}, ${r.organization_id}, ${r.property_id}, 'lease.expiring', 'lease', ${r.lease_id},
                ${JSON.stringify({ lease_id: r.lease_id, version_no: r.version_no, days_left: r.days_left, effective_to: r.effective_to })}::jsonb,
                ${`job:lease.remindExpiring:${now.toISOString()}`}, ${key}, ${currentTraceparent()})
        on conflict do nothing`.execute(trx),
    );
    created += Number(ins.numAffectedRows ?? 0);
  }
  return created;
}

/**
 * Quá hạn chưa bàn giao trả: ngoại lệ `LEASE_OVERSTAY` (một cái đang mở mỗi allocation), ghi rõ allocation bị đụng; booking đã
 * xác nhận kế tiếp trên phòng nhận thêm `RELOCATION_REQUIRED` (SPEC-inventory S-020, Q-09). Trả số `LEASE_OVERSTAY` mới mở.
 */
export async function detectOverstay(workerDb: Kysely<unknown>, now: Date): Promise<number> {
  const rows = await sql<{
    organization_id: string;
    property_id: string;
    lease_id: string;
    allocation_id: string;
    related_allocation_id: string | null;
  }>`select * from app.leases_overstaying(${now})`.execute(workerDb);
  let opened = 0;
  for (const r of rows.rows) {
    const correlationId = `job:lease.detectOverstay:${now.toISOString()}`;
    const wasOpened = await withTenantRetry(workerDb, { orgId: r.organization_id }, async (trx) => {
      const e = await openException(trx, {
        orgId: r.organization_id,
        propertyId: r.property_id,
        type: "LEASE_OVERSTAY",
        allocationId: r.allocation_id,
        relatedAllocationId: r.related_allocation_id,
      });
      if (e.created)
        await recordWorkerExceptionOpened(trx, {
          orgId: r.organization_id,
          propertyId: r.property_id,
          exceptionId: e.id,
          type: "LEASE_OVERSTAY",
          details: { lease_id: r.lease_id, related_allocation_id: r.related_allocation_id },
          correlationId,
        });
      // Booking kế tiếp có thể được xác nhận SAU lần quét đầu: luôn thử (ON CONFLICT DO NOTHING giữ một hiệu lực).
      for (const rel of await openRelocationForNextBooking(trx, {
        orgId: r.organization_id,
        propertyId: r.property_id,
        overstayAllocationId: r.allocation_id,
      }))
        await recordWorkerExceptionOpened(trx, {
          orgId: r.organization_id,
          propertyId: r.property_id,
          exceptionId: rel.id,
          type: "RELOCATION_REQUIRED",
          details: { allocation_id: rel.allocationId, related_allocation_id: r.allocation_id },
          correlationId,
        });
      return e.created;
    });
    // Đếm NGOÀI transaction: transaction có thể chạy lại (40001/40P01) nên không đổi biến ngoài bên trong.
    if (wasOpened) opened++;
  }
  return opened;
}
