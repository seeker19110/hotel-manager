// Đọc giá trị ô của file import (SPEC-import S-018, S-019, S-020). THUẦN: không I/O, không node:*.
// Nguyên tắc: không đoán ý người nhập — dạng nào không khớp mẫu chặt thì trả mã lỗi dòng, không tự sửa.
// Tiền luôn là số nguyên đồng; số thập phân (chỉ số công tơ) giữ dạng chuỗi, không qua số thực.
import { MS_PER_DAY } from "../units/units.ts";

/** Một ô đã đọc. `numeric` = ô số thật của XLSX (CSV luôn `false`). */
export interface Cell {
  v: string;
  numeric: boolean;
}

export type ValueCode = "REQUIRED" | "NOT_INTEGER_VND" | "OUT_OF_RANGE" | "INVALID_FORMAT" | "TOO_LONG";

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: ValueCode };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (code: ValueCode): Parsed<never> => ({ ok: false, code });

function text(cell: Cell | undefined): string {
  return cell === undefined ? "" : cell.v.trim();
}

// Chỉ nhận dạng số thập phân/khoa học thông thường — chặn "0x10", "Infinity", "1_000" mà Number() lại chấp nhận.
const NUMERIC_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function numericOf(raw: string): number | undefined {
  if (!NUMERIC_LITERAL.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

const DIGITS = /^\d+$/;
const GROUPED_THOUSANDS = /^\d{1,3}(\.\d{3})+$/;

/**
 * Số tiền VND nguyên (S-020). Chuỗi: `^\d+$` hoặc đúng mẫu nhóm nghìn `^\d{1,3}(\.\d{3})+$` ("1.500" = 1500).
 * Mọi dạng khác có `.`/`,`/thập phân/chữ → `NOT_INTEGER_VND`; số âm hoặc vượt `MAX_SAFE_INTEGER` → `OUT_OF_RANGE`.
 * Ô số của XLSX phải là số nguyên an toàn (1.234 là số lẻ, KHÔNG phải 1234). Không nhận "đ"/"VND".
 * 0 hợp lệ (người gọi quyết định bỏ qua); chỉ khi `allowZero === false` thì 0 → `OUT_OF_RANGE`.
 */
export function parseImportVnd(cell: Cell | undefined, opts?: { allowZero?: boolean }): Parsed<number> {
  const raw = text(cell);
  if (raw === "") return fail("REQUIRED");
  const zero = (n: number): Parsed<number> =>
    n === 0 && opts?.allowZero === false ? fail("OUT_OF_RANGE") : ok(n);

  if (cell?.numeric) {
    const n = numericOf(raw);
    if (n === undefined || !Number.isInteger(n)) return fail("NOT_INTEGER_VND");
    if (!Number.isSafeInteger(n) || n < 0) return fail("OUT_OF_RANGE");
    return zero(n + 0); // `+ 0` chuẩn hoá -0 thành 0
  }

  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  let digits: string;
  if (DIGITS.test(body)) digits = body;
  else if (GROUPED_THOUSANDS.test(body)) digits = body.replaceAll(".", "");
  else return fail("NOT_INTEGER_VND");
  if (negative) return fail("OUT_OF_RANGE");
  const n = Number(digits);
  if (n > Number.MAX_SAFE_INTEGER) return fail("OUT_OF_RANGE");
  return zero(n);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EXCEL_MAX_SERIAL = 2958465; // 9999-12-31
const DAY_MS = MS_PER_DAY;

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysIn(y: number, m: number): number {
  return m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function ymd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Ngày → `YYYY-MM-DD` (S-019). Chuỗi chỉ nhận đúng `yyyy-mm-dd` và ngày lịch có thật; `dd/mm/yyyy` bị từ chối (không đoán).
 * Ô số = số seri Excel hệ 1900 (1..2958465, phần lẻ giờ bỏ qua); seri 60 (29/02/1900 không tồn tại) → `INVALID_FORMAT`.
 */
export function parseImportDate(cell: Cell | undefined): Parsed<string> {
  const raw = text(cell);
  if (raw === "") return fail("REQUIRED");

  if (cell?.numeric) {
    const n = numericOf(raw);
    if (n === undefined) return fail("INVALID_FORMAT");
    const serial = Math.floor(n);
    if (serial < 1 || serial > EXCEL_MAX_SERIAL || serial === 60) return fail("INVALID_FORMAT");
    // Excel coi 1900 là năm nhuận: từ seri 61 gốc là 1899-12-30, trước đó (1..59) gốc là 1899-12-31.
    const base = serial >= 61 ? Date.UTC(1899, 11, 30) : Date.UTC(1899, 11, 31);
    const d = new Date(base + serial * DAY_MS);
    return ok(ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
  }

  const m = ISO_DATE.exec(raw);
  if (!m) return fail("INVALID_FORMAT");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return fail("INVALID_FORMAT");
  return ok(raw);
}

function decimalPattern(maxDecimals: number): RegExp {
  return maxDecimals <= 0 ? DIGITS : new RegExp(`^\\d+(\\.\\d{1,${maxDecimals}})?$`);
}

function canonicalDecimal(s: string): string {
  const [intPart = "0", frac = ""] = s.split(".");
  const i = intPart.replace(/^0+(?=\d)/, "");
  const f = frac.replace(/0+$/, "");
  return f === "" ? i : `${i}.${f}`;
}

/**
 * Số thập phân không âm (chỉ số công tơ), tối đa `maxDecimals` chữ số thập phân; kiểm bằng chuỗi, không làm tròn.
 * Trả chuỗi chuẩn: "1250.500" → "1250.5", "007" → "7". Âm → `OUT_OF_RANGE`; dạng khác (dấu phẩy, quá số lẻ, chữ) → `INVALID_FORMAT`.
 */
export function parseImportDecimal(cell: Cell | undefined, maxDecimals = 3): Parsed<string> {
  const raw = text(cell);
  if (raw === "") return fail("REQUIRED");
  const pattern = decimalPattern(maxDecimals);

  if (cell?.numeric) {
    const n = numericOf(raw);
    if (n === undefined) return fail("INVALID_FORMAT");
    if (n < 0) return fail("OUT_OF_RANGE");
    const s = String(n);
    // Dạng khoa học chỉ xuất hiện ở số rất lớn (≥ 1e21) hoặc rất nhỏ (< 1e-6, quá số lẻ cho phép).
    if (s.includes("e")) return fail(n >= 1 ? "OUT_OF_RANGE" : "INVALID_FORMAT");
    return pattern.test(s) ? ok(canonicalDecimal(s)) : fail("INVALID_FORMAT");
  }

  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  if (!pattern.test(body)) return fail("INVALID_FORMAT");
  if (negative) return fail("OUT_OF_RANGE");
  return ok(canonicalDecimal(body));
}

/** Số nguyên trong [min, max] (sức chứa, số người…). Không phải số nguyên → `INVALID_FORMAT`; ngoài khoảng → `OUT_OF_RANGE`. */
export function parseImportInt(cell: Cell | undefined, min: number, max: number): Parsed<number> {
  const raw = text(cell);
  if (raw === "") return fail("REQUIRED");
  let n: number | undefined;
  if (cell?.numeric) n = numericOf(raw);
  else if (/^[+-]?\d+$/.test(raw)) n = Number(raw);
  if (n === undefined || !Number.isInteger(n)) return fail("INVALID_FORMAT");
  if (!Number.isSafeInteger(n) || n < min || n > max) return fail("OUT_OF_RANGE");
  return ok(n + 0);
}

/**
 * Văn bản: cắt khoảng trắng hai đầu, đếm độ dài theo code point. Không lọc/biến đổi nội dung
 * (công thức `=...` chỉ là dữ liệu; chống injection làm ở lúc xuất — `csvCell`).
 */
export function parseImportText(cell: Cell | undefined, max = 500, required = true): Parsed<string> {
  const raw = text(cell);
  if (raw === "") return required ? fail("REQUIRED") : ok("");
  // length (UTF-16) ≥ số code point: chỉ đếm chính xác khi có khả năng vượt.
  if (raw.length > max && [...raw].length > max) return fail("TOO_LONG");
  return ok(raw);
}

const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Một ô CSV an toàn (S-018, OWASP CSV injection): số giữ kiểu số; chuỗi bắt đầu bằng `=`, `+`, `-`, `@`, tab, CR
 * được thêm tiền tố `'`; chứa `"`, `,`, `;`, xuống dòng thì bọc ngoặc kép và nhân đôi `"`.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const safe = value !== "" && FORMULA_TRIGGERS.has(value.charAt(0)) ? `'${value}` : value;
  return /["\n\r,;]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** CSV UTF-8 có BOM (Excel đọc đúng tiếng Việt), dòng nối bằng CRLF. */
export function toCsv(rows: (string | number | null)[][]): string {
  return `﻿${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}`;
}
