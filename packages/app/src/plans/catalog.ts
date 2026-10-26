// Danh mục gói dịch vụ — MỘT nguồn (IND-SAAS-008, D-130, T-2314). Hạn mức tài nguyên (cơ sở, phòng, thành viên, dung lượng file)
// và hạn mức tần suất (lệnh, tải file, nhập liệu) theo gói của tổ chức (`organizations.plan`, migration 0073).
// - Hạn mức TÀI NGUYÊN cưỡng chế ở CSDL (trigger `app.enforce_plan_quota`, 0073) — mọi đường ghi (lệnh, nhập liệu hàng loạt, hàm
//   SQL) đều qua; vượt ⇒ 409 QUOTA_EXCEEDED. CSDL giữ bản sao số liệu trong `app.plan_limits(plan)` + CHECK `ck_organizations_plan`;
//   test `plans.db.test.ts` đỏ nếu bản sao lệch danh mục này. Thêm/đổi gói = sửa danh mục này + migration mới cập nhật hai chỗ đó.
// - Hạn mức TẦN SUẤT đọc trực tiếp từ đây ở pipeline lệnh (`command.ts`) và route tải file/nhập liệu (`http/rate-limit.ts`).
// Bảng giá/nhiều gói do chủ dự án quyết sau (D-130): hiện chỉ có `pilot`.
import { BYTES_PER_KIB, BYTES_PER_MIB } from "@hm/domain";

export const PLAN_IDS = ["pilot"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export const DEFAULT_PLAN: PlanId = "pilot";

export interface PlanLimits {
  /** Cơ sở chưa lưu trữ (`properties.archived_at IS NULL`). */
  maxProperties: number;
  /** Phòng chưa lưu trữ trên mọi cơ sở (`units.archived_at IS NULL`). */
  maxUnits: number;
  /**
   * Thành viên NHÂN VIÊN đang hoạt động (`memberships.status = 'active'`, trừ `tenant` — người thuê dùng cổng, số lượng theo phòng —
   * và `platform_support` — truy cập hỗ trợ tạm thời do owner cấp) + lời mời nhân viên còn chờ chưa hết hạn (khi mời).
   */
  maxActiveMembers: number;
  /**
   * Tổng byte file đang giữ (`files.status IN ('pending_scan','ready')`), trừ bản xuất dữ liệu (`owner_type = 'export_job'` — do hệ
   * thống sinh, có hạn, là quyền của chủ dữ liệu kể cả khi chờ xoá tổ chức: không được chặn bởi hạn mức).
   */
  maxStorageBytes: number;
  /** Lệnh ghi MỚI mỗi 60 giây trượt (pipeline): theo tổ chức (chỉ lệnh committed/in_progress) và theo thành viên (mọi lệnh). */
  commandsPerMinute: { org: number; member: number };
  /** Tải ảnh/PDF (`files/upload`) mỗi 60 giây. */
  fileUploadsPerMinute: { org: number; member: number };
  /** Tải tệp nhập liệu CSV/XLSX (`import/upload`) mỗi 60 giây. */
  importUploadsPerMinute: { org: number; member: number };
}

const BYTES_PER_GIB = BYTES_PER_MIB * BYTES_PER_KIB;

/**
 * `pilot`: số liệu RỘNG hơn nhu cầu pilot thật để không chặn người dùng hợp lệ — PROJECT.md: người dùng mục tiêu 10–100 phòng ở 1–5
 * cơ sở; pilot ≥ 6 cơ sở (nhiều chủ); bộ tải k6 100 tổ chức / 5.000 phòng. Hạn mức chỉ chặn một tenant chiếm hết tài nguyên (script
 * lỗi, lạm dụng): 50 cơ sở (10× chủ lớn nhất), 20.000 phòng (4× TOÀN BỘ bộ tải trong một tổ chức), 200 nhân viên, 50 GiB file (ảnh ≤
 * 10 MB: ~5.000 ảnh/cơ sở). Hạn mức tần suất giữ NGUYÊN giá trị trước T-2314 (không đổi hành vi): lệnh 600/200, tải file 120/30,
 * nhập liệu 30/10 mỗi phút (tổ chức/thành viên).
 */
export const PLANS: Readonly<Record<PlanId, Readonly<PlanLimits>>> = {
  pilot: {
    maxProperties: 50,
    maxUnits: 20_000,
    maxActiveMembers: 200,
    maxStorageBytes: 50 * BYTES_PER_GIB,
    commandsPerMinute: { org: 600, member: 200 },
    fileUploadsPerMinute: { org: 120, member: 30 },
    importUploadsPerMinute: { org: 30, member: 10 },
  },
};

export function isPlanId(v: unknown): v is PlanId {
  return typeof v === "string" && (PLAN_IDS as readonly string[]).includes(v);
}

/**
 * Hạn mức của gói. Giá trị lạ/thiếu (actor dựng tay trong test, hàng cũ) ⇒ gói mặc định — CSDL đã chặn giá trị ngoài danh mục
 * (CHECK) nên ở đường thật không xảy ra.
 */
export function planLimits(plan?: string | null): Readonly<PlanLimits> {
  return PLANS[isPlanId(plan) ? plan : DEFAULT_PLAN];
}

/** Loại hạn mức tài nguyên — trùng `TG_ARGV[0]` của trigger CSDL và `quota` trong log. */
export const QUOTA_KINDS = ["properties", "units", "members", "storage"] as const;
export type QuotaKind = (typeof QUOTA_KINDS)[number];
