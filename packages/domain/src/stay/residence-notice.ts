// Thông báo lưu trú — quy tắc thuần (SPEC-reservation-stay S-028…S-030, Q-13; không I/O, không DB).
// - Mẫu file xuất là CẤU HÌNH theo cơ sở (`notification_settings.residence_notice_template`); nguồn pháp lý của hạn và mẫu của cơ quan
//   mới là nguồn thứ cấp (chưa xác minh với bản gốc — Q-13) nên KHÔNG có mẫu mặc định cứng: chưa cấu hình → NOTICE_TEMPLATE_MISSING.
// - Chỉ những trường trong danh mục `NOTICE_FIELDS` mới xuất được: không có SĐT, ảnh giấy tờ, số tiền, ghi chú nội bộ (S-028).
// - CSV dùng `toCsv` (chống formula injection: ô bắt đầu bằng = + - @ tab CR được thêm tiền tố `'`).
import { toCsv } from "../import/values.ts";

/** Danh mục trường xuất được (khoá → tiêu đề cột). Thêm trường = thêm ở đây VÀ ở nơi nạp dữ liệu (`residence.ts`). */
export const NOTICE_FIELDS = {
  stt: "STT",
  full_name: "Họ và tên",
  nationality: "Quốc tịch",
  doc_type: "Loại giấy tờ",
  doc_number: "Số giấy tờ",
  passport_number: "Số hộ chiếu",
  unit_code: "Số phòng",
  checked_in_at: "Giờ đến",
  departure_date: "Ngày đi dự kiến",
} as const;
export type NoticeField = keyof typeof NOTICE_FIELDS;

const FIELD_KEYS = Object.keys(NOTICE_FIELDS) as NoticeField[];
export const MAX_NOTICE_COLUMNS = 12;

/** Mẫu đã kiểm: `columns` luôn có; `foreignColumns` chỉ thêm khi thông báo có khách nước ngoài (S-030). */
export interface NoticeTemplate {
  columns: NoticeField[];
  foreignColumns: NoticeField[];
  /** Trường bắt buộc có giá trị (⊆ cột hiệu lực). Trường thuộc `foreignColumns` chỉ bắt buộc với khách nước ngoài. */
  required: NoticeField[];
}

function fieldList(raw: unknown): NoticeField[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_NOTICE_COLUMNS) return null;
  const out: NoticeField[] = [];
  for (const k of raw) {
    if (typeof k !== "string" || !(FIELD_KEYS as string[]).includes(k)) return null;
    if (out.includes(k as NoticeField)) return null;
    out.push(k as NoticeField);
  }
  return out;
}

/**
 * Kiểm cấu hình mẫu (`{ columns, foreign_columns?, required? }`). Không hợp lệ (không phải object, thiếu cột, khoá lạ, trùng, quá dài,
 * `required` ngoài cột) → `null` (người gọi coi như chưa cấu hình mẫu). Khoá lạ bị từ chối chứ không bỏ qua: một khoá gõ nhầm
 * không được âm thầm cho ra file thiếu cột.
 */
export function parseNoticeTemplate(raw: unknown): NoticeTemplate | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const columns = fieldList(o.columns);
  if (!columns || columns.length === 0) return null;
  const foreignColumns = o.foreign_columns === undefined ? [] : fieldList(o.foreign_columns);
  if (!foreignColumns) return null;
  if (columns.length + foreignColumns.length > MAX_NOTICE_COLUMNS) return null;
  if (foreignColumns.some((f) => columns.includes(f))) return null;
  const required = o.required === undefined ? [] : fieldList(o.required);
  if (!required) return null;
  const effective = [...columns, ...foreignColumns];
  if (required.some((r) => !effective.includes(r))) return null;
  for (const k of Object.keys(o)) if (!["columns", "foreign_columns", "required"].includes(k)) return null;
  return { columns, foreignColumns, required };
}

export interface NoticeGuest {
  fullName: string;
  /** ISO 3166-1 alpha-2 hoặc null (khách trong nước chưa ghi quốc tịch). */
  nationality: string | null;
  docType: "cccd" | "passport" | "other" | null;
  docNumber: string | null;
}

export interface NoticeStay {
  unitCode: string;
  /** Giờ đến theo giờ cơ sở, `YYYY-MM-DD HH:mm`. */
  checkedInLocal: string;
  /** Ngày đi dự kiến `YYYY-MM-DD` hoặc null. */
  departureDate: string | null;
  isForeign: boolean;
}

export interface MissingField {
  /** `guests[i].<trường>` (cùng dạng lỗi theo trường của API). */
  path: string;
  field: NoticeField;
}

export const isForeignNationality = (n: string | null): boolean =>
  n !== null && n.trim() !== "" && n !== "VN";

/**
 * Dựng CSV theo mẫu: một dòng mỗi người lưu trú, theo thứ tự đầu vào (người đại diện đầu tiên). Trả danh sách trường thiếu của các
 * trường bắt buộc (rỗng → hợp lệ); khi có thiếu thì `csv` vẫn dựng nhưng người gọi KHÔNG được lưu/trả file.
 */
export function buildNoticeCsv(
  template: NoticeTemplate,
  stay: NoticeStay,
  guests: readonly NoticeGuest[],
): { csv: string; columns: NoticeField[]; missing: MissingField[] } {
  const columns = stay.isForeign ? [...template.columns, ...template.foreignColumns] : [...template.columns];
  const missing: MissingField[] = [];
  const header = columns.map((c) => NOTICE_FIELDS[c]);
  const rows: (string | number | null)[][] = [header];
  for (const [i, g] of guests.entries()) {
    const foreignGuest = isForeignNationality(g.nationality);
    const value = (f: NoticeField): string | number => {
      switch (f) {
        case "stt":
          return i + 1;
        case "full_name":
          return g.fullName;
        case "nationality":
          return g.nationality?.trim() ?? "";
        case "doc_type":
          return g.docType ?? "";
        case "doc_number":
          return g.docNumber ?? "";
        case "passport_number":
          return g.docType === "passport" ? (g.docNumber ?? "") : "";
        case "unit_code":
          return stay.unitCode;
        case "checked_in_at":
          return stay.checkedInLocal;
        case "departure_date":
          return stay.departureDate ?? "";
      }
    };
    const row: (string | number)[] = [];
    for (const f of columns) {
      const v = value(f);
      row.push(v);
      const appliesToGuest = !template.foreignColumns.includes(f) || foreignGuest;
      if (template.required.includes(f) && appliesToGuest && String(v).trim() === "") {
        missing.push({ path: `guests[${i}].${f}`, field: f });
      }
    }
    rows.push(row);
  }
  return { csv: toCsv(rows), columns, missing };
}
