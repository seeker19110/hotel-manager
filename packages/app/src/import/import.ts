// Import dữ liệu chuyển đổi (PLAN đợt 2 T-115; SPEC-import S-001…S-020 trừ S-009; SPEC-lease S-026; ERD import_*).
// Luồng: tải lên (file riêng tư + dòng thô) → kiểm (lỗi từng dòng, xem trước, chống nhập lặp theo `external_id`) → đối chiếu
// tổng (số dư) → owner xác nhận → commit NGUYÊN KHỐI: mỗi dòng ghi qua đúng hàm của module sở hữu (tạo phòng, lập/ký/bàn
// giao/kích hoạt hợp đồng, chỉ số, số dư đầu kỳ) nên mọi ràng buộc (EXCLUDE phòng, khoá kỳ…) áp nguyên vẹn; lỗi ràng buộc ở
// dòng nào ⇒ rollback toàn bộ, lô về `validated` kèm `CONFLICT_AT_COMMIT` (ghi ở transaction lưu lỗi).
// File là DỮ LIỆU: không tính công thức (chỉ đọc giá trị đã lưu), không chạy macro/liên kết; báo cáo lỗi chống formula injection.
// `reservations` (S-009) chờ module đặt phòng ở đợt 3.
import { createHash, randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import {
  authorize,
  type Cell,
  mibToBytes,
  type Parsed,
  parseCsv,
  parseImportDate,
  parseImportDecimal,
  parseImportInt,
  parseImportText,
  parseImportVnd,
  toCsv,
} from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/index.ts";
import {
  commitTabularFile,
  type FileDeps,
  type PreparedTabular,
  prepareTabularFile,
  storeTabularFile,
} from "../files/index.ts";
import { createUnit } from "../inventory/index.ts";
import {
  activateLease,
  clearImportReadingsPending,
  createDraft,
  createPerson,
  recordImportHandover,
  signLease,
  submitForSignature,
} from "../lease/index.ts";
import { recordOpeningDebt, recordOpeningDeposit } from "../ledger/index.ts";
import { importReading } from "../metering/index.ts";
import {
  type CommandContext,
  CommandError,
  canonicalJson,
  fieldError,
  toProblem,
} from "../pipeline/index.ts";
import { readXlsx, writeXlsx, XlsxError } from "./xlsx.ts";

/** Đề xuất SPEC-import mục 10 (chờ PO): 5 MB / 5.000 dòng; ô ≤ 500 ký tự. */
export const IMPORT_LIMITS = {
  bytes: mibToBytes(5),
  rows: 5000,
  cell: 500,
  previewRows: 200,
  errors: 1000,
} as const;
export const IMPORT_KINDS = ["units", "leases", "meter_readings", "opening_balances"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface ColumnSpec {
  name: string;
  required: boolean;
  help: string;
  example: string | number;
}

/** Cột của mẫu theo loại (S-001). Tên cột ASCII để không lệch do bộ gõ; hướng dẫn tiếng Việt ở sheet "Hướng dẫn". */
export const IMPORT_COLUMNS: Readonly<Record<ImportKind, readonly ColumnSpec[]>> = {
  units: [
    {
      name: "external_id",
      required: true,
      help: "Mã phòng ở hệ thống/sổ cũ (chống nhập lặp)",
      example: "U-001",
    },
    {
      name: "unit_code",
      required: true,
      help: "Mã phòng, 1–20 ký tự, không trùng trong cơ sở",
      example: "101",
    },
    { name: "floor", required: true, help: "Tên tầng/khu (tạo mới nếu chưa có)", example: "Tầng 1" },
    { name: "capacity", required: true, help: "Sức chứa, số nguyên 1–50", example: 2 },
  ],
  leases: [
    { name: "external_id", required: true, help: "Mã hợp đồng ở sổ cũ", example: "HD-01" },
    { name: "unit_code", required: true, help: "Mã phòng đã có trong hệ thống", example: "101" },
    { name: "tenant_name", required: true, help: "Họ tên người đứng hợp đồng", example: "Nguyễn Văn A" },
    {
      name: "tenant_phone",
      required: true,
      help: "Số điện thoại người đứng hợp đồng",
      example: "0900000001",
    },
    {
      name: "rent_amount",
      required: true,
      help: "Giá thuê tháng, số nguyên đồng (3000000 hoặc 3.000.000)",
      example: 3000000,
    },
    {
      name: "deposit_amount",
      required: false,
      help: "Tiền cọc theo hợp đồng (số đang giữ nhập ở lô số dư)",
      example: 3000000,
    },
    {
      name: "billing_start_on",
      required: true,
      help: "Ngày bắt đầu tính tiền YYYY-MM-DD, không sau ngày mốc",
      example: "2026-03-01",
    },
    {
      name: "end_on",
      required: false,
      help: "Ngày hết hạn YYYY-MM-DD; trống = không thời hạn",
      example: "2027-02-28",
    },
    {
      name: "signed_on",
      required: false,
      help: "Ngày ký YYYY-MM-DD; trống = ngày bắt đầu tính tiền",
      example: "2026-02-25",
    },
    {
      name: "services",
      required: false,
      help: "Mã dịch vụ của cơ sở, cách nhau dấu ; (vd DIEN;NUOC)",
      example: "DIEN;NUOC",
    },
    {
      name: "occupants",
      required: false,
      help: "Họ tên người ở cùng, cách nhau dấu ;",
      example: "Trần Thị B",
    },
  ],
  meter_readings: [
    { name: "external_id", required: true, help: "Mã dòng chỉ số ở sổ cũ", example: "CS-101-DIEN" },
    { name: "unit_code", required: true, help: "Mã phòng", example: "101" },
    { name: "meter_kind", required: true, help: "electric (điện) hoặc water (nước)", example: "electric" },
    {
      name: "value",
      required: true,
      help: "Chỉ số, ≥ 0, tối đa 3 chữ số thập phân, dấu chấm thập phân",
      example: 1250,
    },
    {
      name: "read_on",
      required: false,
      help: "Ngày đọc YYYY-MM-DD; trống = ngày mốc chuyển đổi",
      example: "2026-11-01",
    },
  ],
  opening_balances: [
    { name: "external_id", required: true, help: "Mã dòng số dư ở sổ cũ", example: "SD-01" },
    { name: "lease_external_id", required: true, help: "external_id của hợp đồng đã nhập", example: "HD-01" },
    {
      name: "type",
      required: true,
      help: "debt (khách còn nợ) hoặc deposit (cọc đang giữ)",
      example: "debt",
    },
    { name: "amount", required: true, help: "Số nguyên đồng ≥ 0 (1580000 hoặc 1.580.000)", example: 1580000 },
    { name: "note", required: false, help: "Ghi chú", example: "Tiền điện tháng 10 chưa trả" },
  ],
};

export interface RowError {
  column: string;
  code: string;
  message: string;
  ref?: string;
}

type RawRow = Record<string, Cell>;

// ---------- Mẫu ----------

/** `import.getTemplate` (S-001): XLSX (sheet dữ liệu + "Hướng dẫn") và CSV UTF-8 có tiêu đề + một dòng ví dụ giả. */
export function getTemplate(
  actor: Actor,
  kind: string,
): { filename: string; xlsx_base64: string; csv: string } {
  authorize(actor, "import.prepare");
  if (!(IMPORT_KINDS as readonly string[]).includes(kind))
    throw fieldError("kind", "INVALID", "Loại nhập không hỗ trợ");
  const cols = IMPORT_COLUMNS[kind as ImportKind];
  const header = cols.map((c) => c.name);
  const example = cols.map((c) => c.example);
  const guide: (string | number)[][] = [
    ["Cột", "Bắt buộc", "Mô tả"],
    ...cols.map((c) => [c.name, c.required ? "Có" : "Không", c.help]),
    [],
    [
      "Quy ước",
      "",
      "Ngày dạng YYYY-MM-DD; tiền là số nguyên đồng; dấu . chỉ là phân cách nghìn đúng nhóm 3 chữ số.",
    ],
    ["Quy ước", "", "Dòng ví dụ là dữ liệu giả — xoá trước khi nhập. Công thức trong ô không được tính lại."],
  ];
  const xlsx = writeXlsx([
    { name: kind, rows: [header, example] },
    { name: "Hướng dẫn", rows: guide },
  ]);
  return {
    filename: `mau-nhap-${kind}`,
    xlsx_base64: Buffer.from(xlsx).toString("base64"),
    csv: toCsv([header, example.map((v) => String(v))]),
  };
}

// ---------- Tải lên ----------

function detectTable(bytes: Uint8Array): {
  format: "csv" | "xlsx";
  rows: { rowNo: number; cells: Cell[] }[];
} {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    try {
      return { format: "xlsx", rows: nfcRows(readXlsx(bytes)) };
    } catch (e) {
      if (e instanceof XlsxError)
        throw new CommandError("FILE_TYPE_NOT_ALLOWED", 415, "File XLSX hỏng hoặc không đọc được");
      throw e;
    }
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CommandError("FILE_TYPE_NOT_ALLOWED", 415, "Chỉ nhận file .xlsx hoặc .csv (UTF-8).");
  }
  if (text.includes("\u0000"))
    throw new CommandError("FILE_TYPE_NOT_ALLOWED", 415, "Chỉ nhận file .xlsx hoặc .csv (UTF-8).");
  return {
    format: "csv",
    rows: nfcRows(
      parseCsv(text).map((r, i) => ({ rowNo: i + 1, cells: r.map((v) => ({ v, numeric: false })) })),
    ),
  };
}

/** Chuẩn hoá NFC mọi ô (kể cả dòng tiêu đề) ngay sau khi đọc file — Excel/CSV tiếng Việt hay ở dạng tổ hợp (BASE-DATA-002). */
function nfcRows(rows: { rowNo: number; cells: Cell[] }[]): { rowNo: number; cells: Cell[] }[] {
  return rows.map((r) => ({
    rowNo: r.rowNo,
    cells: r.cells.map((c) => ({ v: c.v.normalize("NFC"), numeric: c.numeric })),
  }));
}

type UploadBatchInput = {
  propertyId: string;
  kind: string;
  cutoffOn?: string;
  bytes: Uint8Array;
  /** Tên file người dùng đã qua `normalizeUploadName` (NFC, bỏ đường dẫn) — chỉ ghi vết audit. */
  fileName?: string;
};

/** Kiểm quyền, kích thước, định dạng, tiêu đề — thuần CPU/không I/O; dùng ở bước prepare VÀ trong lệnh. */
function inspectBatchUpload(actor: Actor, input: UploadBatchInput) {
  if (!UUID.test(input.propertyId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy cơ sở");
  authorize(actor, "import.prepare", { propertyId: input.propertyId });
  if (input.kind === "reservations")
    throw fieldError("kind", "NOT_SUPPORTED_YET", "Nhập đặt phòng mở ở đợt 3");
  if (!(IMPORT_KINDS as readonly string[]).includes(input.kind))
    throw fieldError("kind", "INVALID", "Loại nhập không hỗ trợ");
  const kind = input.kind as ImportKind;
  if (input.cutoffOn !== undefined && !parseImportDate({ v: input.cutoffOn, numeric: false }).ok)
    throw fieldError("cutoff_on", "INVALID_DATE", "Ngày mốc dạng YYYY-MM-DD");
  if (kind !== "units" && !input.cutoffOn)
    throw fieldError("cutoff_on", "REQUIRED", "Cần ngày mốc chuyển đổi");
  if (input.bytes.byteLength === 0) throw new CommandError("VALIDATION_FAILED", 422, "File rỗng");
  if (input.bytes.byteLength > IMPORT_LIMITS.bytes)
    throw new CommandError("FILE_TOO_LARGE", 413, "File quá lớn. Tách thành nhiều file.");
  const table = detectTable(input.bytes);
  const [head, ...data] = table.rows.filter((r) => r.cells.some((c) => c.v.trim() !== ""));
  if (!head) throw new CommandError("VALIDATION_FAILED", 422, "File không có dữ liệu");
  if (data.length === 0) throw new CommandError("VALIDATION_FAILED", 422, "File chỉ có dòng tiêu đề");
  if (data.length > IMPORT_LIMITS.rows)
    throw new CommandError("FILE_TOO_LARGE", 413, "File quá lớn. Tách thành nhiều file.");
  const header = head.cells.map((c) => c.v.trim().toLowerCase());
  const cols = IMPORT_COLUMNS[kind];
  const missing = cols.filter((c) => c.required && !header.includes(c.name));
  if (missing.length > 0) {
    throw new CommandError("VALIDATION_FAILED", 422, `Thiếu cột: ${missing.map((c) => c.name).join(", ")}`, {
      extensions: {
        errors: missing.map((c) => ({ path: `header.${c.name}`, field: c.name, code: "REQUIRED" })),
      },
    });
  }
  return { kind, table, header, data, cols };
}

const xlsxOrCsv = (format: "csv" | "xlsx") => (format === "csv" ? "text/csv" : XLSX_MIME);

/**
 * Bước chuẩn bị NGOÀI transaction lệnh (T-303): kiểm đầu vào → dòng staging → quét → ghi object nguồn (xem files/staging.ts).
 * Gọi trước `executeCommand`; truyền kết quả vào `uploadBatch`.
 */
export async function prepareBatchUpload(
  db: Kysely<unknown>,
  deps: FileDeps,
  actor: Actor,
  input: UploadBatchInput,
  idempotencyKey: string,
): Promise<PreparedTabular> {
  const { table } = inspectBatchUpload(actor, input);
  return prepareTabularFile(
    db,
    deps,
    actor,
    { propertyId: input.propertyId, bytes: input.bytes, mime: xlsxOrCsv(table.format) },
    idempotencyKey,
  );
}

/** `import.upload`: kiểm quyền, kích thước, định dạng, tiêu đề; lưu file nguồn riêng tư + dòng thô; chưa ghi dữ liệu nghiệp vụ. */
export async function uploadBatch(
  ctx: CommandContext,
  deps: FileDeps,
  input: UploadBatchInput & {
    /** Từ `prepareBatchUpload` (đường sản phẩm). Không có ⇒ đường cũ quét + ghi object NGAY TRONG transaction. */
    prepared?: PreparedTabular;
  },
): Promise<{ batchId: string; rows: number }> {
  const { kind, table, header, data, cols } = inspectBatchUpload(ctx.actor, input);
  const prepared = input.prepared;
  if (prepared && prepared.mime !== xlsxOrCsv(table.format))
    throw new Error("Bản chuẩn bị tải lên không khớp định dạng file");
  const batchId = prepared?.batchId ?? randomUUID();
  const file = prepared
    ? await commitTabularFile(ctx, prepared)
    : await storeTabularFile(ctx, deps, {
        ownerId: batchId,
        propertyId: input.propertyId,
        bytes: input.bytes,
        mime: xlsxOrCsv(table.format),
      });
  await sql`
    insert into import_batches (id, organization_id, property_id, kind, file_id, file_sha256, file_format, header, cutoff_on,
                                uploaded_by)
    values (${batchId}, ${ctx.actor.orgId}, ${input.propertyId}, ${kind}, ${file.fileId}, ${file.sha256}, ${table.format},
            ${JSON.stringify(header)}::jsonb, ${input.cutoffOn ?? null}::date, ${ctx.actor.membershipId})`.execute(
    ctx.trx,
  );
  // Chỉ giữ các cột của mẫu; ô quá dài bị cắt ở mức an toàn lưu trữ (kiểm TOO_LONG theo giá trị gốc ở bước kiểm).
  for (let i = 0; i < data.length; i += 500) {
    const chunk = data.slice(i, i + 500).map((r) => {
      const raw: RawRow = {};
      for (const c of cols) {
        const idx = header.indexOf(c.name);
        const cell = idx >= 0 ? r.cells[idx] : undefined;
        if (cell && cell.v !== "")
          raw[c.name] = { v: cell.v.replaceAll("\u0000", "").slice(0, 4000), numeric: cell.numeric };
      }
      return sql`(${randomUUID()}, ${ctx.actor.orgId}, ${input.propertyId}, ${batchId}, ${r.rowNo}, ${JSON.stringify(raw)}::jsonb)`;
    });
    await sql`insert into import_rows (id, organization_id, property_id, batch_id, row_no, raw) values ${sql.join(chunk)}`.execute(
      ctx.trx,
    );
  }
  await ctx.audit({
    action: "import_batch.uploaded",
    entityType: "import_batch",
    entityId: batchId,
    propertyId: input.propertyId,
    after: {
      kind,
      rows: data.length,
      format: table.format,
      file_sha256: file.sha256,
      ...(input.fileName === undefined ? {} : { file_name: input.fileName.normalize("NFC") }),
    },
  });
  // Upload (SEC-LOG-001): chỉ id lô, không tên file (có thể chứa tên người).
  ctx.security({ event: "file.uploaded", target: { type: "import_batch", id: batchId } });
  return { batchId, rows: data.length };
}

// ---------- Kiểm từng dòng ----------

interface Checked {
  rowNo: number;
  externalId: string | null;
  data: Record<string, unknown> | null;
  errors: RowError[];
  action: "create" | "skip_unchanged" | "skip_empty" | "error";
  note?: string;
  hash: string;
}

const MESSAGES: Record<string, string> = {
  REQUIRED: "Bắt buộc nhập",
  NOT_INTEGER_VND:
    "Không phải số nguyên đồng (dấu . chỉ phân cách nghìn đúng nhóm 3 chữ số, dấu , không dùng)",
  OUT_OF_RANGE: "Ngoài khoảng cho phép",
  INVALID_FORMAT: "Sai định dạng",
  TOO_LONG: `Quá ${IMPORT_LIMITS.cell} ký tự`,
};

class RowCtx {
  errors: RowError[] = [];
  readonly raw: RawRow;
  constructor(raw: RawRow) {
    this.raw = raw;
  }
  take<T>(column: string, p: Parsed<T>): T | undefined {
    if (p.ok) return p.value;
    this.errors.push({ column, code: p.code, message: MESSAGES[p.code] ?? p.code });
    return undefined;
  }
  err(column: string, code: string, message: string, ref?: string) {
    this.errors.push({ column, code, message, ...(ref ? { ref } : {}) });
  }
  text(column: string, max: number = IMPORT_LIMITS.cell, required = true) {
    const p = parseImportText(this.raw[column], max, required);
    if (!p.ok && p.code === "TOO_LONG") {
      this.err(column, "TOO_LONG", `Quá ${max} ký tự`);
      return undefined;
    }
    return this.take(column, p);
  }
}

/** NFC cho dòng thô đã lưu (lô tải lên trước khi có chuẩn hoá lúc tải vẫn kiểm/ghi đúng dạng NFC). */
function nfcRaw(raw: RawRow): RawRow {
  return Object.fromEntries(Object.entries(raw).map(([k, c]) => [k, { ...c, v: c.v.normalize("NFC") }]));
}

function parseRow(
  kind: ImportKind,
  rawStored: RawRow,
  cutoffOn: string | null,
): { r: RowCtx; data: Record<string, unknown> } {
  const raw = nfcRaw(rawStored);
  const r = new RowCtx(raw);
  const data: Record<string, unknown> = { external_id: r.text("external_id", 200) };
  switch (kind) {
    case "units":
      data.unit_code = r.text("unit_code", 20);
      data.floor = r.text("floor", 100);
      data.capacity = r.take("capacity", parseImportInt(raw.capacity, 1, 50));
      break;
    case "leases": {
      data.unit_code = r.text("unit_code", 20);
      data.tenant_name = r.text("tenant_name", 200);
      const phone = r.text("tenant_phone", 20);
      if (phone !== undefined && !/^\+?[0-9 .()-]{6,20}$/.test(phone))
        r.err("tenant_phone", "INVALID_FORMAT", "Số điện thoại không hợp lệ");
      data.tenant_phone = phone;
      data.rent_amount = r.take("rent_amount", parseImportVnd(raw.rent_amount, { allowZero: false }));
      data.deposit_amount = raw.deposit_amount
        ? r.take("deposit_amount", parseImportVnd(raw.deposit_amount))
        : 0;
      const start = r.take("billing_start_on", parseImportDate(raw.billing_start_on));
      const end = raw.end_on ? r.take("end_on", parseImportDate(raw.end_on)) : null;
      const signed = raw.signed_on ? r.take("signed_on", parseImportDate(raw.signed_on)) : null;
      if (start && cutoffOn && start > cutoffOn)
        r.err(
          "billing_start_on",
          "OUT_OF_RANGE",
          `Hợp đồng đang chạy phải bắt đầu tính tiền trước ngày mốc ${cutoffOn}`,
        );
      if (start && end && end < start) r.err("end_on", "OUT_OF_RANGE", "Ngày hết hạn trước ngày bắt đầu");
      if (end && cutoffOn && end < cutoffOn)
        r.err("end_on", "OUT_OF_RANGE", "Hợp đồng đã hết hạn trước ngày mốc");
      if (start && signed && signed > start)
        r.err("signed_on", "OUT_OF_RANGE", "Ngày ký sau ngày bắt đầu tính tiền");
      data.billing_start_on = start;
      data.end_on = end;
      data.signed_on = signed ?? start;
      const svc = r.text("services", IMPORT_LIMITS.cell, false) ?? "";
      data.services = [
        ...new Set(
          svc
            .split(";")
            .map((x) => x.trim().toUpperCase())
            .filter(Boolean),
        ),
      ].sort();
      const occ = (r.text("occupants", IMPORT_LIMITS.cell, false) ?? "")
        .split(";")
        .map((x) => x.trim())
        .filter(Boolean);
      if (occ.length > 19) r.err("occupants", "OUT_OF_RANGE", "Tối đa 19 người ở cùng");
      if (occ.some((x) => x.length > 200)) r.err("occupants", "TOO_LONG", "Họ tên tối đa 200 ký tự");
      data.occupants = occ;
      break;
    }
    case "meter_readings": {
      data.unit_code = r.text("unit_code", 20);
      const k = (r.text("meter_kind", 20) ?? "").toLowerCase();
      const kindMap: Record<string, string> = {
        electric: "electric",
        water: "water",
        điện: "electric",
        nước: "water",
      };
      if (raw.meter_kind && !kindMap[k]) r.err("meter_kind", "INVALID_FORMAT", "electric hoặc water");
      data.meter_kind = kindMap[k];
      data.value = r.take("value", parseImportDecimal(raw.value, 3));
      data.read_on = raw.read_on ? r.take("read_on", parseImportDate(raw.read_on)) : cutoffOn;
      break;
    }
    case "opening_balances": {
      data.lease_external_id = r.text("lease_external_id", 200);
      const t = (r.text("type", 20) ?? "").toLowerCase();
      const typeMap: Record<string, string> = {
        debt: "debt",
        deposit: "deposit",
        nợ: "debt",
        cọc: "deposit",
      };
      if (raw.type && !typeMap[t]) r.err("type", "INVALID_FORMAT", "debt (nợ) hoặc deposit (cọc)");
      data.type = typeMap[t];
      data.amount = r.take("amount", parseImportVnd(raw.amount));
      data.note = r.text("note", IMPORT_LIMITS.cell, false) ?? "";
      break;
    }
  }
  return { r, data };
}

const hashOf = (kind: ImportKind, data: Record<string, unknown>) =>
  createHash("sha256").update(canonicalJson({ kind, data })).digest("hex");

interface BatchRow {
  id: string;
  property_id: string;
  kind: ImportKind;
  status: string;
  cutoff_on: string | null;
  expected_totals: Totals | null;
  actual_totals: Totals | null;
}

type Totals = Record<string, number>;

async function lockBatch(
  ctx: CommandContext,
  batchId: string,
  action: "import.prepare" | "import.commit",
): Promise<BatchRow> {
  if (!UUID.test(batchId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lô nhập");
  const r = await sql<BatchRow>`
    select id, property_id, kind, status, cutoff_on::text, expected_totals, actual_totals from import_batches
    where organization_id = ${ctx.actor.orgId} and id = ${batchId} for update`.execute(ctx.trx);
  const b = r.rows[0];
  if (!b) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lô nhập");
  authorize(ctx.actor, action, { propertyId: b.property_id });
  return b;
}

function transitionError(from: string, to: string): CommandError {
  return new CommandError(
    "INVALID_TRANSITION",
    409,
    "Không thể thực hiện với trạng thái hiện tại của lô nhập.",
    {
      extensions: { from, to },
    },
  );
}

/** Kiểm từng dòng + chéo dòng + với dữ liệu hiện có (chỉ đọc). */
async function checkRows(trx: Transaction<unknown>, orgId: string, b: BatchRow): Promise<Checked[]> {
  const rows = await sql<{ row_no: number; raw: RawRow }>`
    select row_no, raw from import_rows where organization_id = ${orgId} and batch_id = ${b.id} order by row_no`.execute(
    trx,
  );
  const out: Checked[] = rows.rows.map((row) => {
    const { r, data } = parseRow(b.kind, row.raw, b.cutoff_on);
    const externalId = (data.external_id as string | undefined) ?? null;
    return {
      rowNo: row.row_no,
      externalId,
      data,
      errors: r.errors,
      action: "create",
      hash: hashOf(b.kind, data),
    };
  });
  const dup = (key: (c: Checked) => string | null, column: string) => {
    const first = new Map<string, Checked>();
    for (const c of out) {
      const k = key(c);
      if (k === null) continue;
      const f = first.get(k);
      if (f)
        c.errors.push({
          column,
          code: "DUPLICATE_IN_FILE",
          message: `Trùng với dòng ${f.rowNo}`,
          ...(f.externalId ? { ref: f.externalId } : {}),
        });
      else first.set(k, c);
    }
  };
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  dup((c) => c.externalId, "external_id");
  if (b.kind === "units") dup((c) => str(c.data?.unit_code)?.toLowerCase() ?? null, "unit_code");
  if (b.kind === "meter_readings")
    dup(
      (c) =>
        str(c.data?.unit_code) && str(c.data?.meter_kind)
          ? `${String(c.data?.unit_code).toLowerCase()}|${c.data?.meter_kind}`
          : null,
      "unit_code",
    );
  if (b.kind === "opening_balances")
    dup((c) => (c.data?.type === "deposit" ? str(c.data?.lease_external_id) : null), "lease_external_id");

  // Đã nhập trước: cùng nội dung ⇒ bỏ qua; khác ⇒ lỗi (V1 không cập nhật qua import — S-005, S-006).
  const ids = out.map((c) => c.externalId).filter((x): x is string => x !== null);
  const refs =
    ids.length === 0
      ? []
      : (
          await sql<{ external_id: string; row_hash: string }>`
            select external_id, row_hash from import_external_refs
            where organization_id = ${orgId} and property_id = ${b.property_id} and kind = ${b.kind}
              and external_id = any(${ids}::text[])`.execute(trx)
        ).rows;
  const refHash = new Map(refs.map((x) => [x.external_id, x.row_hash]));
  for (const c of out) {
    const h = c.externalId ? refHash.get(c.externalId) : undefined;
    if (h === undefined) continue;
    if (h === c.hash) c.action = "skip_unchanged";
    else
      c.errors.push({
        column: "external_id",
        code: "IMPORT_EXTERNAL_ID_CONFLICT",
        message: "Mã ngoài đã nhập trước đó với nội dung khác.",
      });
  }

  const units = new Map(
    (
      await sql<{ code: string; id: string }>`
        select lower(btrim(code)) as code, id from units where organization_id = ${orgId} and property_id = ${b.property_id}
          and archived_at is null`.execute(trx)
    ).rows.map((u) => [u.code, u.id]),
  );
  const pending = out.filter((c) => c.action === "create" && c.errors.length === 0 && c.data);
  for (const c of pending) {
    const d = c.data as Record<string, unknown>;
    const unitId = typeof d.unit_code === "string" ? units.get(d.unit_code.toLowerCase()) : undefined;
    if (b.kind === "units" && unitId)
      c.errors.push({ column: "unit_code", code: "ALREADY_EXISTS", message: "Mã phòng đã có trong cơ sở" });
    if ((b.kind === "leases" || b.kind === "meter_readings") && !unitId)
      c.errors.push({
        column: "unit_code",
        code: "REFERENCE_NOT_FOUND",
        message: "Không có phòng này trong cơ sở",
      });
    if (unitId) d.unit_id = unitId;
  }
  if (b.kind === "leases") await checkLeases(trx, orgId, b, pending);
  if (b.kind === "meter_readings") await checkReadings(trx, orgId, b, pending);
  if (b.kind === "opening_balances") await checkBalances(trx, orgId, b, pending);
  for (const c of out) {
    if (c.errors.length > 0) c.action = "error";
  }
  return out;
}

async function checkLeases(trx: Transaction<unknown>, orgId: string, b: BatchRow, rows: Checked[]) {
  const services = new Map(
    (
      await sql<{ code: string; id: string }>`
        select upper(code) as code, id from services where organization_id = ${orgId} and property_id = ${b.property_id}
          and archived_at is null`.execute(trx)
    ).rows.map((x) => [x.code, x.id]),
  );
  const seen: { c: Checked; unit: string; s: string; e: string | null }[] = [];
  for (const c of rows) {
    const d = c.data as Record<string, unknown>;
    const missing = (d.services as string[]).filter((x) => !services.has(x));
    if (missing.length > 0)
      c.errors.push({
        column: "services",
        code: "REFERENCE_NOT_FOUND",
        message: `Không có dịch vụ: ${missing.join(", ")}`,
      });
    d.service_ids = (d.services as string[]).map((x) => services.get(x)).filter(Boolean);
    if (typeof d.unit_id !== "string") continue;
    const s = d.billing_start_on as string;
    const e = (d.end_on as string | null) ?? null;
    // Chồng trong file (INV-I1, S-008): báo ở dòng sau, kèm external_id dòng bị chồng.
    const clash = seen.find(
      (x) => x.unit === d.unit_id && (x.e === null || x.e >= s) && (e === null || e >= x.s),
    );
    if (clash) {
      c.errors.push({
        column: "unit_code",
        code: "ROOM_UNAVAILABLE",
        message: "Phòng đã có người hoặc đã được giữ trong khoảng này.",
        ...(clash.c.externalId ? { ref: clash.c.externalId } : {}),
      });
      continue;
    }
    seen.push({ c, unit: d.unit_id, s, e });
    const db = await sql`
      select 1 from allocations a join properties p on p.organization_id = a.organization_id and p.id = a.property_id
      where a.organization_id = ${orgId} and a.unit_id = ${d.unit_id} and a.active
        and a.during && tstzrange((${s}::date::timestamp at time zone p.timezone),
                                  case when ${e}::date is null then null else ((${e}::date + 1)::timestamp at time zone p.timezone) end, '[)')
      limit 1`.execute(trx);
    if (db.rows.length > 0)
      c.errors.push({
        column: "unit_code",
        code: "ROOM_UNAVAILABLE",
        message: "Phòng đã có người hoặc đã được giữ trong khoảng này.",
      });
  }
}

async function checkReadings(trx: Transaction<unknown>, orgId: string, _b: BatchRow, rows: Checked[]) {
  for (const c of rows) {
    const d = c.data as Record<string, unknown>;
    if (typeof d.unit_id !== "string") continue;
    const prev = await sql<{ v: string | null }>`
      select max(r.value)::text as v from meter_readings r join meters m on m.organization_id = r.organization_id and m.id = r.meter_id
      where r.organization_id = ${orgId} and m.unit_id = ${d.unit_id} and m.kind = ${d.meter_kind} and m.removed_on is null
        and r.status = 'approved' and r.read_on <= ${d.read_on}::date`.execute(trx);
    const v = prev.rows[0]?.v;
    if (v != null && Number(d.value) < Number(v))
      c.errors.push({
        column: "value",
        code: "OUT_OF_RANGE",
        message: `Nhỏ hơn chỉ số đã duyệt trước (${Number(v)})`,
      });
  }
}

async function checkBalances(trx: Transaction<unknown>, orgId: string, b: BatchRow, rows: Checked[]) {
  const ids = rows.map((c) => c.data?.lease_external_id).filter((x): x is string => typeof x === "string");
  const refs = new Map(
    (
      await sql<{ external_id: string; target_id: string; has_deposit: boolean }>`
        select r.external_id, r.target_id,
               exists (select 1 from deposits d where d.organization_id = r.organization_id and d.lease_id = r.target_id) as has_deposit
        from import_external_refs r where r.organization_id = ${orgId} and r.property_id = ${b.property_id}
          and r.kind = 'leases' and r.external_id = any(${ids}::text[])`.execute(trx)
    ).rows.map((x) => [x.external_id, x]),
  );
  for (const c of rows) {
    const d = c.data as Record<string, unknown>;
    const ref = refs.get(d.lease_external_id as string);
    if (!ref) {
      c.errors.push({
        column: "lease_external_id",
        code: "REFERENCE_NOT_FOUND",
        message: "Chưa nhập hợp đồng này",
      });
      continue;
    }
    d.lease_id = ref.target_id;
    if (d.amount === 0) {
      c.action = "skip_empty";
      c.note = "Không có số dư";
    } else if (d.type === "deposit" && ref.has_deposit) {
      c.errors.push({ column: "lease_external_id", code: "ALREADY_EXISTS", message: "Hợp đồng đã có cọc" });
    }
  }
}

function totalsOf(kind: ImportKind, rows: Checked[]): Totals {
  const created = rows.filter((c) => c.action === "create");
  if (kind !== "opening_balances") return { rows: created.length };
  const sum = (t: string) =>
    created.filter((c) => c.data?.type === t).reduce((s, c) => s + Number(c.data?.amount), 0);
  return { debt: sum("debt"), deposit: sum("deposit") };
}

export interface ImportPreview {
  batch_id: string;
  kind: ImportKind;
  status: string;
  counts: Record<"create" | "skip_unchanged" | "skip_empty" | "error", number>;
  totals: Totals;
  expected_totals: Totals | null;
  errors: ({ row: number } & RowError)[];
  rows: { row: number; external_id: string | null; action: string; note?: string }[];
}

function previewOf(b: BatchRow, status: string, rows: Checked[]): ImportPreview {
  const counts = { create: 0, skip_unchanged: 0, skip_empty: 0, error: 0 };
  for (const c of rows) counts[c.action]++;
  return {
    batch_id: b.id,
    kind: b.kind,
    status,
    counts,
    totals: totalsOf(b.kind, rows),
    expected_totals: b.expected_totals,
    errors: rows.flatMap((c) => c.errors.map((e) => ({ row: c.rowNo, ...e }))).slice(0, IMPORT_LIMITS.errors),
    rows: rows.slice(0, IMPORT_LIMITS.previewRows).map((c) => ({
      row: c.rowNo,
      external_id: c.externalId,
      action: c.action,
      ...(c.note ? { note: c.note } : {}),
    })),
  };
}

/** `import.validate` (S-002, S-003, S-005, S-006, S-008, S-020): ghi kết quả từng dòng; kiểm lại huỷ xác nhận cũ. */
export async function validateBatch(ctx: CommandContext, input: { batchId: string }): Promise<ImportPreview> {
  const b = await lockBatch(ctx, input.batchId, "import.prepare");
  if (!["uploaded", "validated", "confirmed"].includes(b.status))
    throw transitionError(b.status, "validated");
  const rows = await checkRows(ctx.trx, ctx.actor.orgId, b);
  for (const c of rows) {
    await sql`
      update import_rows set external_id = ${c.externalId}, row_hash = ${c.hash}, action = ${c.action},
             errors = ${JSON.stringify(c.errors)}::jsonb, data = ${JSON.stringify({ ...c.data, ...(c.note ? { _note: c.note } : {}) })}::jsonb
      where organization_id = ${ctx.actor.orgId} and batch_id = ${b.id} and row_no = ${c.rowNo}`.execute(
      ctx.trx,
    );
  }
  const totals = totalsOf(b.kind, rows);
  await sql`
    update import_batches set status = 'validated', actual_totals = ${JSON.stringify(totals)}::jsonb, confirmed_by = null,
           confirmed_at = null
    where organization_id = ${ctx.actor.orgId} and id = ${b.id}`.execute(ctx.trx);
  const preview = previewOf({ ...b, actual_totals: totals }, "validated", rows);
  await ctx.audit({
    action: "import_batch.validated",
    entityType: "import_batch",
    entityId: b.id,
    propertyId: b.property_id,
    after: { counts: preview.counts, totals },
  });
  return preview;
}

/** `import.setExpectedTotals` (S-013): tổng nguồn do người phụ trách đối chiếu; đổi tổng thì phải xác nhận lại. */
export async function setExpectedTotals(
  ctx: CommandContext,
  input: { batchId: string; debt: number; deposit: number },
): Promise<{ diff: Totals }> {
  const b = await lockBatch(ctx, input.batchId, "import.prepare");
  if (b.kind !== "opening_balances")
    throw fieldError("batch_id", "NOT_APPLICABLE", "Chỉ lô số dư có tổng đối chiếu");
  if (!["validated", "confirmed"].includes(b.status)) throw transitionError(b.status, "validated");
  for (const [f, v] of [
    ["debt", input.debt],
    ["deposit", input.deposit],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw fieldError(f, "INVALID", "Tổng là số nguyên đồng ≥ 0");
  }
  const expected = { debt: input.debt, deposit: input.deposit };
  await sql`
    update import_batches set expected_totals = ${JSON.stringify(expected)}::jsonb, status = 'validated', confirmed_by = null,
           confirmed_at = null
    where organization_id = ${ctx.actor.orgId} and id = ${b.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "import_batch.expected_totals",
    entityType: "import_batch",
    entityId: b.id,
    propertyId: b.property_id,
    after: expected,
  });
  const actual = b.actual_totals ?? {};
  return { diff: { debt: (actual.debt ?? 0) - input.debt, deposit: (actual.deposit ?? 0) - input.deposit } };
}

async function assertReady(ctx: CommandContext, b: BatchRow) {
  const e = await sql<{ n: number }>`
    select count(*)::int as n from import_rows where organization_id = ${ctx.actor.orgId} and batch_id = ${b.id}
      and (action = 'error' or action is null)`.execute(ctx.trx);
  if ((e.rows[0]?.n ?? 0) > 0)
    throw new CommandError("IMPORT_HAS_ERRORS", 409, "Còn dòng lỗi. Sửa file và tải lại.");
  if (b.kind !== "opening_balances") return;
  if (!b.expected_totals)
    throw fieldError("expected_totals", "REQUIRED", "Cần nhập tổng nợ/cọc theo sổ nguồn để đối chiếu");
  const totals: Record<string, { expected: number; actual: number; diff: number }> = {};
  for (const k of ["debt", "deposit"] as const) {
    const expected = b.expected_totals[k] ?? 0;
    const actual = b.actual_totals?.[k] ?? 0;
    if (expected !== actual) totals[k] = { expected, actual, diff: actual - expected };
  }
  if (Object.keys(totals).length > 0)
    throw new CommandError("IMPORT_TOTALS_MISMATCH", 409, "Tổng trong file khác tổng bạn đã đối chiếu.", {
      extensions: { totals },
    });
}

/** `import.confirm` (S-014): owner xác nhận (tên, thời điểm, tổng đã đối chiếu) — mọi loại lô đều cần. */
export async function confirmBatch(ctx: CommandContext, input: { batchId: string }) {
  const b = await lockBatch(ctx, input.batchId, "import.commit");
  if (b.status !== "validated") throw transitionError(b.status, "confirmed");
  await assertReady(ctx, b);
  await sql`
    update import_batches set status = 'confirmed', confirmed_by = ${ctx.actor.membershipId}, confirmed_at = now()
    where organization_id = ${ctx.actor.orgId} and id = ${b.id}`.execute(ctx.trx);
  await ctx.audit({
    action: "import_batch.confirmed",
    entityType: "import_batch",
    entityId: b.id,
    propertyId: b.property_id,
    after: { actual_totals: b.actual_totals, expected_totals: b.expected_totals },
  });
  return { status: "confirmed" as const };
}

// ---------- Commit ----------

async function writeRow(
  ctx: CommandContext,
  b: BatchRow,
  rowNo: number,
  d: Record<string, unknown>,
): Promise<string> {
  const cutoff = b.cutoff_on as string;
  switch (b.kind) {
    case "units":
      return (
        await createUnit(ctx, {
          propertyId: b.property_id,
          floorName: d.floor as string,
          code: d.unit_code as string,
          capacity: d.capacity as number,
        })
      ).unitId;
    case "leases": {
      const unitId = d.unit_id as string;
      const rep = await createPerson(ctx, {
        propertyId: b.property_id,
        fullName: d.tenant_name as string,
        phone: d.tenant_phone as string,
      });
      const occupants = [];
      for (const name of d.occupants as string[]) {
        occupants.push({
          personId: (await createPerson(ctx, { propertyId: b.property_id, fullName: name })).personId,
          role: "occupant" as const,
        });
      }
      const start = d.billing_start_on as string;
      const { leaseId } = await createDraft(ctx, {
        unitId,
        representativePersonId: rep.personId,
        billingStartOn: start,
        signedOn: d.signed_on as string,
        terms: {
          effectiveFrom: start,
          effectiveTo: (d.end_on as string | null) ?? null,
          rentAmount: d.rent_amount as number,
          depositAmount: d.deposit_amount as number,
          services: (d.service_ids as string[]).map((serviceId) => ({ serviceId, quantity: 1 })),
        },
        occupants,
        source: "import",
      });
      await submitForSignature(ctx, { leaseId });
      await signLease(ctx, { leaseId, signerPersonId: rep.personId, signedOn: d.signed_on as string });
      await recordImportHandover(ctx, {
        leaseId,
        handedOverOn: start,
        note: `Bàn giao chuyển đổi (lô nhập, dòng ${rowNo})`,
      });
      await clearImportReadingsPending(ctx, { unitId, cutoffOn: cutoff });
      await activateLease(ctx, { leaseId });
      return leaseId;
    }
    case "meter_readings": {
      const r = await importReading(ctx, {
        unitId: d.unit_id as string,
        kind: d.meter_kind as "electric" | "water",
        value: d.value as string,
        readOn: d.read_on as string,
      });
      await clearImportReadingsPending(ctx, { unitId: d.unit_id as string, cutoffOn: cutoff });
      return r.readingId;
    }
    case "opening_balances":
      if (d.type === "debt") {
        return (
          await recordOpeningDebt(ctx, {
            leaseId: d.lease_id as string,
            amount: d.amount as number,
            businessDate: cutoff,
            ...(d.note ? { note: d.note as string } : {}),
            sourceId: `${b.id}:${rowNo}`,
          })
        ).invoiceId;
      }
      return (
        await recordOpeningDeposit(ctx, {
          leaseId: d.lease_id as string,
          amount: d.amount as number,
          businessDate: cutoff,
          sourceId: `${b.id}:${rowNo}`,
        })
      ).depositId;
  }
}

/**
 * `import.commit` (S-003, S-004, S-005, S-013, S-014, S-017): một transaction. Thứ tự kiểm: trạng thái → còn lỗi → tổng →
 * xác nhận. Lỗi ở dòng nào (ràng buộc CSDL, quy tắc module) ⇒ rollback mọi dòng; transaction lưu lỗi đưa lô về `validated`
 * và ghi `CONFLICT_AT_COMMIT` vào dòng đó.
 */
export async function commitBatch(
  ctx: CommandContext,
  input: { batchId: string },
): Promise<{ status: "committed"; created: number; skipped: number }> {
  const b = await lockBatch(ctx, input.batchId, "import.commit");
  if (b.status === "validated") {
    await assertReady(ctx, b);
    throw new CommandError(
      "IMPORT_CONFIRMATION_REQUIRED",
      409,
      "Cần người phụ trách xác nhận trước khi nhập.",
    );
  }
  if (b.status !== "confirmed") throw transitionError(b.status, "committed");
  await assertReady(ctx, b);
  const rows = await sql<{
    row_no: number;
    external_id: string;
    row_hash: string;
    action: string;
    data: Record<string, unknown>;
  }>`
    select row_no, external_id, row_hash, action, data from import_rows
    where organization_id = ${ctx.actor.orgId} and batch_id = ${b.id} order by row_no`.execute(ctx.trx);
  let created = 0;
  for (const row of rows.rows) {
    if (row.action !== "create") continue;
    let targetId: string;
    try {
      targetId = await writeRow(ctx, b, row.row_no, row.data);
      await sql`
        insert into import_external_refs (id, organization_id, property_id, batch_id, kind, external_id, target_id, row_hash)
        values (${randomUUID()}, ${ctx.actor.orgId}, ${b.property_id}, ${b.id}, ${b.kind}, ${row.external_id}, ${targetId}, ${row.row_hash})`.execute(
        ctx.trx,
      );
    } catch (e) {
      const p = toProblem(e);
      if (p.status >= 500) throw e;
      const message = `Lỗi khi ghi: ${p.detail ?? p.title} (${p.code})`;
      throw new CommandError(
        "IMPORT_HAS_ERRORS",
        409,
        `Dòng ${row.row_no}: ${message}. Không dòng nào được ghi.`,
        {
          persist: async (trx) => {
            await sql`
            update import_batches set status = 'validated', confirmed_by = null, confirmed_at = null
            where organization_id = ${ctx.actor.orgId} and id = ${b.id} and status = 'confirmed'`.execute(
              trx,
            );
            await sql`
            update import_rows set action = 'error',
                   errors = errors || ${JSON.stringify([{ column: "*", code: "CONFLICT_AT_COMMIT", message }])}::jsonb
            where organization_id = ${ctx.actor.orgId} and batch_id = ${b.id} and row_no = ${row.row_no}`.execute(
              trx,
            );
            return { errors: [{ path: `rows.${row.row_no}`, field: "*", code: "CONFLICT_AT_COMMIT" }] };
          },
        },
      );
    }
    await sql`
      update import_rows set target_id = ${targetId}
      where organization_id = ${ctx.actor.orgId} and batch_id = ${b.id} and row_no = ${row.row_no}`.execute(
      ctx.trx,
    );
    created++;
  }
  await sql`
    update import_batches set status = 'committed', committed_at = now()
    where organization_id = ${ctx.actor.orgId} and id = ${b.id}`.execute(ctx.trx);
  // Hạn giữ file nguồn (đề xuất mục 10: 30 ngày sau commit/huỷ).
  await sql`
    update files set delete_after = current_date + 30
    where organization_id = ${ctx.actor.orgId} and owner_type = 'import_batch' and owner_id = ${b.id}`.execute(
    ctx.trx,
  );
  await ctx.audit({
    action: "import_batch.committed",
    entityType: "import_batch",
    entityId: b.id,
    propertyId: b.property_id,
    after: { kind: b.kind, created, totals: b.actual_totals },
  });
  return { status: "committed", created, skipped: rows.rows.length - created };
}

/** `import.cancel` (S-016): lô chưa commit → `cancelled`, có lý do; không ghi dữ liệu nghiệp vụ. */
export async function cancelBatch(ctx: CommandContext, input: { batchId: string; reason: string }) {
  const b = await lockBatch(ctx, input.batchId, "import.prepare");
  if (!["uploaded", "validated", "confirmed"].includes(b.status))
    throw transitionError(b.status, "cancelled");
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw fieldError("reason", "REQUIRED", "Cần lý do huỷ (≤ 500 ký tự)");
  await sql`
    update import_batches set status = 'cancelled', cancelled_at = now(), cancel_reason = ${reason}
    where organization_id = ${ctx.actor.orgId} and id = ${b.id}`.execute(ctx.trx);
  await sql`
    update files set delete_after = current_date + 30
    where organization_id = ${ctx.actor.orgId} and owner_type = 'import_batch' and owner_id = ${b.id}`.execute(
    ctx.trx,
  );
  await ctx.audit({
    action: "import_batch.cancelled",
    entityType: "import_batch",
    entityId: b.id,
    propertyId: b.property_id,
    reason,
  });
  return { status: "cancelled" as const };
}

// ---------- Truy vấn ----------

async function readBatch(trx: Transaction<unknown>, actor: Actor, batchId: string) {
  if (!UUID.test(batchId)) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lô nhập");
  const r = await sql<
    BatchRow & { confirmed_by: string | null; confirmed_at: Date | null; committed_at: Date | null }
  >`
    select id, property_id, kind, status, cutoff_on::text, expected_totals, actual_totals, confirmed_by, confirmed_at, committed_at
    from import_batches where organization_id = ${actor.orgId} and id = ${batchId}`.execute(trx);
  const b = r.rows[0];
  if (!b) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy lô nhập");
  authorize(actor, "import.prepare", { propertyId: b.property_id });
  const rows = await sql<{
    row_no: number;
    external_id: string | null;
    action: string | null;
    errors: RowError[];
    data: { _note?: string } | null;
  }>`
    select row_no, external_id, action, errors, data from import_rows where organization_id = ${actor.orgId} and batch_id = ${b.id}
    order by row_no`.execute(trx);
  return { b, rows: rows.rows };
}

/** `import.get`: trạng thái, ai xác nhận, số dòng theo hành động, lỗi. */
export async function getBatch(db: Kysely<unknown>, actor: Actor, input: { batchId: string }) {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const { b, rows } = await readBatch(trx, actor, input.batchId);
    const counts: Record<string, number> = {
      create: 0,
      skip_unchanged: 0,
      skip_empty: 0,
      error: 0,
      unchecked: 0,
    };
    for (const r of rows) counts[r.action ?? "unchecked"] = (counts[r.action ?? "unchecked"] ?? 0) + 1;
    return {
      batch_id: b.id,
      kind: b.kind,
      status: b.status,
      cutoff_on: b.cutoff_on,
      confirmed_by: b.confirmed_by,
      confirmed_at: b.confirmed_at,
      committed_at: b.committed_at,
      actual_totals: b.actual_totals,
      expected_totals: b.expected_totals,
      counts,
      errors: rows
        .flatMap((r) => r.errors.map((e) => ({ row: r.row_no, ...e })))
        .slice(0, IMPORT_LIMITS.errors),
    };
  });
}

/** `import.downloadErrorReport` (S-018): CSV lỗi; ô văn bản chống formula injection, cột số giữ kiểu số. */
export async function downloadErrorReport(db: Kysely<unknown>, actor: Actor, input: { batchId: string }) {
  return withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const { b } = await readBatch(trx, actor, input.batchId);
    const rows = await sql<{ row_no: number; external_id: string | null; errors: RowError[]; raw: RawRow }>`
      select row_no, external_id, errors, raw from import_rows where organization_id = ${actor.orgId} and batch_id = ${b.id}
        and jsonb_array_length(errors) > 0 order by row_no`.execute(trx);
    const lines: (string | number | null)[][] = [
      ["row", "external_id", "column", "code", "message", "value"],
    ];
    for (const r of rows.rows) {
      for (const e of r.errors)
        lines.push([r.row_no, r.external_id, e.column, e.code, e.message, r.raw[e.column]?.v ?? null]);
    }
    return { filename: `loi-nhap-${b.id.slice(0, 8)}.csv`, csv: toCsv(lines) };
  });
}
