// Job tồn chạy trong worker (role app_worker): `inventory.detectOverdue` (SPEC-inventory S-017, INV-I4) — lượt ở `in_house` quá
// giờ trả dự kiến (+ ngưỡng Q-03) chưa check-out. KHÔNG tự kết thúc allocation: mở ngoại lệ `STAY_OVERSTAY` cho quản lý và
// `RELOCATION_REQUIRED` cho booking đã xác nhận kế tiếp trên phòng. Hợp đồng quá hạn do `lease.detectOverstay` (SPEC-lease).
// Đọc xuyên tổ chức qua hàm SECURITY DEFINER phạm vi hẹp; ghi trong ngữ cảnh từng tổ chức; chạy lại một hiệu lực.
import { withTenantRetry } from "@hm/db";
import { type Kysely, sql } from "kysely";
import { openException, openRelocationForNextBooking, recordWorkerExceptionOpened } from "./exceptions.ts";

/** Trả số ngoại lệ `STAY_OVERSTAY` mới mở (chạy lại không đếm lại cái đã có). */
export async function detectOverdue(workerDb: Kysely<unknown>, now: Date): Promise<number> {
  const rows = await sql<{
    organization_id: string;
    property_id: string;
    stay_id: string;
    allocation_id: string;
    related_allocation_id: string | null;
  }>`select * from app.stays_overdue(${now})`.execute(workerDb);
  let opened = 0;
  for (const r of rows.rows) {
    const correlationId = `job:inventory.detectOverdue:${now.toISOString()}`;
    const wasOpened = await withTenantRetry(workerDb, { orgId: r.organization_id }, async (trx) => {
      const e = await openException(trx, {
        orgId: r.organization_id,
        propertyId: r.property_id,
        type: "STAY_OVERSTAY",
        allocationId: r.allocation_id,
        relatedAllocationId: r.related_allocation_id,
      });
      if (e.created)
        await recordWorkerExceptionOpened(trx, {
          orgId: r.organization_id,
          propertyId: r.property_id,
          exceptionId: e.id,
          type: "STAY_OVERSTAY",
          details: { stay_id: r.stay_id, related_allocation_id: r.related_allocation_id },
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
