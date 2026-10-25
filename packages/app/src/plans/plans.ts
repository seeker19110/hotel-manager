// Gói và hạn mức theo tổ chức (IND-SAAS-008, D-123). Gói khai báo trong repo — đổi hạn mức qua PR; chưa có thanh toán nên
// chưa có bảng gói trong CSDL. File này THUẦN dữ liệu (không import pipeline/CSDL) để pipeline, command và worker cùng đọc.
// Hạn mức đủ rộng cho một tổ chức vận hành bình thường; `free` là gói thu hẹp để kiểm chứng đường từ chối.

export type PlanId = "free" | "standard";

export interface PlanLimits {
  id: PlanId;
  /** Số cơ sở (properties) chưa lưu trữ. */
  properties: number;
  /** Số phòng (units) chưa lưu trữ, cộng mọi cơ sở của tổ chức. */
  rooms: number;
  /** Số thành viên còn hiệu lực/chờ chấp nhận + lời mời đang chờ. */
  members: number;
  /** Lệnh ghi/phút/tổ chức (pipeline lệnh). */
  commandsPerMinute: number;
  /** Số job nền chạy đồng thời của một tổ chức (fair-share worker). */
  jobConcurrency: number;
}

export const PLANS: Readonly<Record<PlanId, PlanLimits>> = {
  free: { id: "free", properties: 1, rooms: 20, members: 5, commandsPerMinute: 120, jobConcurrency: 1 },
  standard: {
    id: "standard",
    properties: 50,
    rooms: 5000,
    members: 500,
    commandsPerMinute: 600,
    jobConcurrency: 2,
  },
};

export const DEFAULT_PLAN_ID: PlanId = "standard";

/**
 * Gói của một tổ chức — MỘT điểm tra cứu. Hiện `organizations` chưa có cột gói nên mọi tổ chức dùng `standard`.
 * Khi có thanh toán/gói thật: đọc gói từ CSDL ở đây (và đổi chữ ký thành async hoặc nạp cùng ngữ cảnh lệnh); mọi nơi gọi
 * không đổi vì chỉ đi qua hàm này.
 */
export function planFor(_orgId: string): PlanLimits {
  return PLANS[DEFAULT_PLAN_ID];
}

/** Cấu hình `groupConcurrency` của pg-boss: bậc (tier) = id gói, giá trị = số job đồng thời mỗi tổ chức. */
export function jobGroupConcurrency(): { default: number; tiers: Record<string, number> } {
  return {
    default: PLANS[DEFAULT_PLAN_ID].jobConcurrency,
    tiers: Object.fromEntries(Object.values(PLANS).map((p) => [p.id, p.jobConcurrency])),
  };
}
