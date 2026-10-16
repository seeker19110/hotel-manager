// Đọc sao kê CSV có ánh xạ cột (SPEC-ledger S-019). Thuần, không I/O: CSV RFC 4180 (ngoặc kép, xuống dòng trong ô, BOM),
// số tiền kiểu Việt Nam ("1.580.000", "1,580,000", "1.580.000,00"), ngày giờ địa phương Asia/Ho_Chi_Minh (+07:00).
// Lỗi từng dòng được trả về theo dòng — không làm hỏng cả file.

export const STATEMENT_MAX_ROWS = 5000;
export const STATEMENT_MAX_BYTES = 2 * 1024 * 1024;

export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const d =
    delimiter ??
    ([";", "\t", ","] as const)
      .map((c) => [c, firstLine.split(c).length] as const)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ??
    ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === d) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw new RangeError("CSV: thiếu dấu đóng ngoặc kép");
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

/** Số tiền VND (nguyên đồng); phần thập phân chỉ chấp nhận ,00/.00. Không nhận dạng được → null. */
export function parseVndAmount(raw: string): number | null {
  let s = raw.replace(/\s|VND|vnđ|VNĐ|đ/g, "");
  let sign = 1;
  if (/^[+-]/.test(s)) {
    if (s[0] === "-") sign = -1;
    s = s.slice(1);
  }
  let digits: string | null = null;
  if (/^\d+$/.test(s)) digits = s;
  else if (/^\d{1,3}(\.\d{3})+(,0{1,2})?$/.test(s)) digits = s.replace(/,0{1,2}$/, "").replaceAll(".", "");
  else if (/^\d{1,3}(,\d{3})+(\.0{1,2})?$/.test(s)) digits = s.replace(/\.0{1,2}$/, "").replaceAll(",", "");
  else if (/^\d+[.,]0{1,2}$/.test(s)) digits = s.replace(/[.,]0{1,2}$/, "");
  if (digits === null) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? sign * n : null;
}

const VN_OFFSET = "+07:00";

/** dd/mm/yyyy[ HH:mm[:ss]] (cả dấu -), hoặc ISO 8601; không múi giờ → giờ Việt Nam. Sai lịch (31/02) → null. */
export function parseStatementDate(raw: string): Date | null {
  const s = raw.trim();
  let y: number;
  let mo: number;
  let d: number;
  let time = "00:00:00";
  let zone = VN_OFFSET;
  const vn = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(s);
  if (vn) {
    [d, mo, y] = [Number(vn[1]), Number(vn[2]), Number(vn[3])];
    if (vn[4]) time = `${vn[4].padStart(2, "0")}:${vn[5]}:${vn[6] ?? "00"}`;
  } else if (iso) {
    [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (iso[4]) time = `${iso[4]}:${iso[5]}:${iso[6] ?? "00"}`;
    if (iso[7]) zone = iso[7];
  } else return null;
  const [hh, mm, ss] = time.split(":").map(Number) as [number, number, number];
  if (
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > new Date(Date.UTC(y, mo, 0)).getUTCDate() ||
    hh > 23 ||
    mm > 59 ||
    ss > 59
  )
    return null;
  const out = new Date(
    `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${time}${zone}`,
  );
  return Number.isNaN(out.getTime()) ? null : out;
}

/** Cột theo tên tiêu đề (không phân biệt hoa thường, bỏ khoảng trắng thừa) hoặc chỉ số 0-based. */
export type ColumnRef = string | number;

export interface StatementMapping {
  date: ColumnRef;
  description: ColumnRef;
  /** Một cột có dấu (âm = tiền ra) … */
  amount?: ColumnRef;
  /** … hoặc cặp cột Có (tiền vào) / Nợ (tiền ra). */
  credit?: ColumnRef;
  debit?: ColumnRef;
  ref?: ColumnRef;
  balance?: ColumnRef;
  /** Mặc định true: dòng đầu là tiêu đề. */
  header?: boolean;
}

export type StatementRow =
  | {
      line: number;
      kind: "credit";
      occurredAt: Date;
      amount: number;
      description: string;
      ref: string | null;
      balanceAfter: number | null;
    }
  | { line: number; kind: "skipped"; why: "outflow" | "zero" }
  | { line: number; kind: "invalid"; error: string };

export function mapStatement(rows: readonly string[][], m: StatementMapping): StatementRow[] {
  const hasHeader = m.header ?? true;
  const header = hasHeader ? (rows[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, " ")) : [];
  const col = (ref: ColumnRef | undefined, field: string): number | undefined => {
    if (ref === undefined) return undefined;
    const i = typeof ref === "number" ? ref : header.indexOf(ref.trim().toLowerCase().replace(/\s+/g, " "));
    if (!Number.isInteger(i) || i < 0) throw new RangeError(`Không tìm thấy cột ${field}: ${String(ref)}`);
    return i;
  };
  if ((m.amount === undefined) === (m.credit === undefined))
    throw new RangeError("Ánh xạ cần đúng một trong: cột số tiền, hoặc cột Có (kèm Nợ nếu có)");
  const c = {
    date: col(m.date, "ngày") as number,
    description: col(m.description, "nội dung") as number,
    amount: col(m.amount, "số tiền"),
    credit: col(m.credit, "tiền vào"),
    debit: col(m.debit, "tiền ra"),
    ref: col(m.ref, "mã giao dịch"),
    balance: col(m.balance, "số dư"),
  };
  const body = rows.slice(hasHeader ? 1 : 0);
  if (body.length > STATEMENT_MAX_ROWS)
    throw new RangeError(`Tối đa ${STATEMENT_MAX_ROWS} dòng mỗi lần nhập`);
  return body.map((r, idx): StatementRow => {
    const line = idx + (hasHeader ? 2 : 1);
    const cell = (i: number | undefined) => (i === undefined ? "" : (r[i] ?? "").trim());
    const occurredAt = parseStatementDate(cell(c.date));
    if (!occurredAt) return { line, kind: "invalid", error: "Ngày giao dịch không hợp lệ" };
    let amount: number | null;
    if (c.amount !== undefined) amount = parseVndAmount(cell(c.amount));
    else {
      const cr = cell(c.credit) === "" ? 0 : parseVndAmount(cell(c.credit));
      const dr = cell(c.debit) === "" ? 0 : parseVndAmount(cell(c.debit));
      if (cr === null || dr === null) amount = null;
      else if (cr > 0 && dr > 0) return { line, kind: "invalid", error: "Dòng có cả tiền vào và tiền ra" };
      else amount = cr > 0 ? cr : -Math.abs(dr);
    }
    if (amount === null) return { line, kind: "invalid", error: "Số tiền không hợp lệ" };
    if (amount === 0) return { line, kind: "skipped", why: "zero" };
    if (amount < 0) return { line, kind: "skipped", why: "outflow" };
    const balanceRaw = cell(c.balance);
    const balanceAfter = balanceRaw === "" ? null : parseVndAmount(balanceRaw);
    if (balanceRaw !== "" && balanceAfter === null)
      return { line, kind: "invalid", error: "Số dư không hợp lệ" };
    const ref = cell(c.ref);
    if (ref.length > 100) return { line, kind: "invalid", error: "Mã giao dịch quá dài" };
    return {
      line,
      kind: "credit",
      occurredAt,
      amount,
      description: cell(c.description).slice(0, 500),
      ref: ref === "" ? null : ref,
      balanceAfter,
    };
  });
}
