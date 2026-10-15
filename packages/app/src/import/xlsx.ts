// Đọc/ghi XLSX tối thiểu cho import (SPEC-import S-018, S-019). Chỉ dùng node:zlib + node:buffer, không thêm thư viện.
// Đọc: ZIP qua End Of Central Directory + central directory (không tin kích thước trong local header), chặn zip bomb bằng
// giới hạn số entry/kích thước; chỉ đọc workbook, rels, sharedStrings và sheet ĐẦU TIÊN — mọi phần khác (macro, liên kết
// ngoài, drawing…) không bao giờ được mở. Công thức `<f>` luôn bị bỏ qua: chỉ dùng giá trị đã lưu `<v>`, không tính lại.
// Ghi: workbook hợp lệ tối thiểu, ZIP method 0 (store) + CRC32; chuỗi dùng inlineStr nên không cần sharedStrings.
import { Buffer } from "node:buffer";
import { crc32, inflateRawSync } from "node:zlib";
import type { Cell } from "@hm/domain";

export class XlsxError extends Error {}

export interface XlsxLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Trần số ô sau khi điền đủ (chống file khai ô ở cột XFD để phình bộ nhớ). Mặc định 1.000.000. */
  maxCells?: number;
}

export const DEFAULT_XLSX_LIMITS: XlsxLimits = {
  maxEntries: 2000,
  maxEntryBytes: 20 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
};

const DEFAULT_MAX_CELLS = 1_000_000;
const MAX_COLUMNS = 16384; // XFD
const MAX_ROWS = 1_048_576;

// ---------------------------------------------------------------------------------------------------------------------
// ZIP (đọc)
// ---------------------------------------------------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

interface ZipEntry {
  method: number;
  csize: number;
  usize: number;
  crc: number;
  offset: number;
}

interface Zip {
  has(name: string): boolean;
  /** Giải nén một entry (kiểm kích thước khai báo, CRC và tổng dung lượng đã giải nén); không có → `undefined`. */
  read(name: string): Buffer | undefined;
}

function openZip(bytes: Uint8Array, limits: XlsxLimits): Zip {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 22) throw new XlsxError("Không phải file XLSX (quá ngắn).");

  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError("Không phải file XLSX (không thấy cấu trúc ZIP).");
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR)
    throw new XlsxError("ZIP64 không được hỗ trợ.");

  const diskNo = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (diskNo !== 0 || cdDisk !== 0) throw new XlsxError("ZIP nhiều đĩa không được hỗ trợ.");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new XlsxError("ZIP64 không được hỗ trợ.");
  }
  if (total > limits.maxEntries) throw new XlsxError("File chứa quá nhiều phần.");
  if (cdOffset + cdSize > eocd) throw new XlsxError("Thư mục trung tâm của ZIP bị hỏng.");

  const entries = new Map<string, ZipEntry>();
  let declaredTotal = 0;
  let p = cdOffset;
  for (let k = 0; k < total; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL)
      throw new XlsxError("Thư mục trung tâm của ZIP bị hỏng.");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new XlsxError("Thư mục trung tâm của ZIP bị hỏng.");
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.includes("..") || name.includes("\0") || name.includes("\\") || name.startsWith("/")) {
      throw new XlsxError("Tên phần trong ZIP không hợp lệ.");
    }
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) throw new XlsxError("File mã hoá không được hỗ trợ.");
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff)
      throw new XlsxError("ZIP64 không được hỗ trợ.");
    if (name.endsWith("/")) continue; // thư mục
    if (method !== 0 && method !== 8) throw new XlsxError("Kiểu nén không được hỗ trợ.");
    if (usize > limits.maxEntryBytes) throw new XlsxError("Một phần trong file vượt giới hạn dung lượng.");
    declaredTotal += usize;
    if (declaredTotal > limits.maxTotalBytes) throw new XlsxError("Tổng dung lượng giải nén vượt giới hạn.");
    if (entries.has(name)) throw new XlsxError("ZIP có hai phần trùng tên.");
    entries.set(name, { method, csize, usize, crc, offset });
  }

  let inflated = 0;
  return {
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) return undefined;
      if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== SIG_LOCAL)
        throw new XlsxError("ZIP bị hỏng (local header).");
      const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
      const end = start + e.csize;
      if (end > cdOffset) throw new XlsxError("ZIP bị hỏng (dữ liệu ngoài vùng cho phép).");
      const data = buf.subarray(start, end);
      let out: Buffer;
      if (e.method === 0) {
        if (e.csize !== e.usize) throw new XlsxError("ZIP bị hỏng (kích thước không khớp).");
        out = data;
      } else {
        try {
          // Trần giải nén = kích thước khai báo (đã ≤ maxEntryBytes): khai nhỏ mà nén bom sẽ bị chặn tại đây.
          out = inflateRawSync(data, { maxOutputLength: Math.max(1, e.usize) });
        } catch (cause) {
          throw new XlsxError("Không giải nén được (hỏng hoặc vượt kích thước khai báo).", { cause });
        }
      }
      if (out.length !== e.usize) throw new XlsxError("ZIP bị hỏng (kích thước giải nén không khớp).");
      if (crc32(out) !== e.crc) throw new XlsxError("ZIP bị hỏng (CRC không khớp).");
      inflated += out.length;
      if (inflated > limits.maxTotalBytes) throw new XlsxError("Tổng dung lượng giải nén vượt giới hạn.");
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// XML tối thiểu (quét bằng indexOf — tuyến tính, không regex lồng nhau)
// ---------------------------------------------------------------------------------------------------------------------

interface El {
  attrs: string;
  inner: string;
}

function* elements(xml: string, name: string): Generator<El> {
  const open = `<${name}`;
  let pos = 0;
  for (;;) {
    const i = xml.indexOf(open, pos);
    if (i < 0) return;
    const next = xml.charAt(i + open.length);
    if (next !== ">" && next !== "/" && next !== " " && next !== "\t" && next !== "\n" && next !== "\r") {
      pos = i + open.length; // thẻ khác cùng tiền tố (vd. <cols> khi tìm <c>)
      continue;
    }
    const gt = xml.indexOf(">", i + open.length);
    if (gt < 0) throw new XlsxError("XML bị cắt cụt.");
    if (xml.charAt(gt - 1) === "/") {
      yield { attrs: xml.slice(i + open.length, gt - 1), inner: "" };
      pos = gt + 1;
      continue;
    }
    const closeTag = `</${name}>`;
    const close = xml.indexOf(closeTag, gt + 1);
    if (close < 0) throw new XlsxError("XML bị cắt cụt.");
    yield { attrs: xml.slice(i + open.length, gt), inner: xml.slice(gt + 1, close) };
    pos = close + closeTag.length;
  }
}

function first(xml: string, name: string): El | undefined {
  for (const el of elements(xml, name)) return el;
  return undefined;
}

const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;

function decodeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(ENTITY, (_whole, ref: string) => {
    switch (ref) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const cp = ref.startsWith("#x") ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    const invalid =
      !Number.isFinite(cp) ||
      cp > 0x10ffff ||
      cp === 0 ||
      (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) ||
      (cp >= 0xd800 && cp <= 0xdfff) ||
      cp === 0xfffe ||
      cp === 0xffff;
    if (invalid) throw new XlsxError("XML chứa ký tự không hợp lệ.");
    return String.fromCodePoint(cp);
  });
}

function attrsOf(s: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of s.matchAll(/([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    map.set(m[1] as string, decodeXml(m[2] ?? m[3] ?? ""));
  }
  return map;
}

function stripPhonetic(xml: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const i = xml.indexOf("<rPh", pos);
    if (i < 0) return out + xml.slice(pos);
    out += xml.slice(pos, i);
    const end = xml.indexOf("</rPh>", i);
    if (end < 0) return out;
    pos = end + "</rPh>".length;
  }
}

/** Gộp mọi `<t>` (chuỗi thường hoặc rich text nhiều `<r><t>`), bỏ chú âm `<rPh>`; không cắt khoảng trắng (xml:space). */
function textOf(xml: string): string {
  let out = "";
  for (const t of elements(stripPhonetic(xml), "t")) out += decodeXml(t.inner);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// XLSX (đọc)
// ---------------------------------------------------------------------------------------------------------------------

function utf8(buf: Buffer): string {
  const s = buf.toString("utf8");
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function requirePart(zip: Zip, name: string): string {
  const b = zip.read(name);
  if (!b) throw new XlsxError(`Thiếu phần ${name} — không phải file XLSX hợp lệ.`);
  return utf8(b);
}

/** Chuẩn hoá đường dẫn đích của quan hệ: tương đối với `xl/` hoặc tuyệt đối `/xl/...`; không cho thoát khỏi gốc. */
function resolveTarget(target: string): string {
  const parts: string[] = [];
  const segments = target.startsWith("/") ? target.slice(1).split("/") : ["xl", ...target.split("/")];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.pop() === undefined) throw new XlsxError("Đường dẫn quan hệ không hợp lệ.");
    } else parts.push(seg);
  }
  return parts.join("/");
}

function firstSheetPath(zip: Zip): string {
  const workbook = requirePart(zip, "xl/workbook.xml");
  const sheet = first(workbook, "sheet");
  if (!sheet) throw new XlsxError("Workbook không có sheet nào.");
  let rid: string | undefined;
  for (const [k, v] of attrsOf(sheet.attrs)) {
    if (k === "r:id" || k.endsWith(":id")) rid = v;
  }
  if (rid === undefined) throw new XlsxError("Sheet đầu tiên thiếu r:id.");

  const rels = requirePart(zip, "xl/_rels/workbook.xml.rels");
  for (const rel of elements(rels, "Relationship")) {
    const a = attrsOf(rel.attrs);
    if (a.get("Id") !== rid) continue;
    if (a.get("TargetMode") === "External") throw new XlsxError("Sheet trỏ ra ngoài file.");
    const target = a.get("Target");
    if (target === undefined) break;
    return resolveTarget(target);
  }
  throw new XlsxError("Không phân giải được sheet đầu tiên.");
}

function readSharedStrings(zip: Zip): string[] {
  const b = zip.read("xl/sharedStrings.xml");
  if (!b) return [];
  const out: string[] = [];
  for (const si of elements(utf8(b), "si")) out.push(textOf(si.inner));
  return out;
}

function colIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

function parseRef(ref: string): { col: number; row: number } | undefined {
  const m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(ref);
  if (!m) return undefined;
  const col = colIndex((m[1] as string).toUpperCase());
  const row = Number(m[2]);
  if (col >= MAX_COLUMNS || row < 1 || row > MAX_ROWS) return undefined;
  return { col, row };
}

function readCell(attrs: Map<string, string>, inner: string, shared: string[], where: string): Cell {
  const t = attrs.get("t");
  // `<f>` (công thức) không bao giờ được đọc: chỉ lấy giá trị đã lưu.
  const vEl = first(inner, "v");
  const raw = vEl ? decodeXml(vEl.inner) : undefined;

  if (t === "inlineStr") {
    const is = first(inner, "is");
    return { v: is ? textOf(is.inner) : "", numeric: false };
  }
  if (raw === undefined) return { v: "", numeric: false };
  switch (t) {
    case "s": {
      const idx = Number(raw.trim());
      const s = Number.isInteger(idx) ? shared[idx] : undefined;
      if (s === undefined) throw new XlsxError(`Ô ${where} trỏ tới chuỗi dùng chung không tồn tại.`);
      return { v: s, numeric: false };
    }
    case "b":
      return { v: raw.trim() === "1" ? "TRUE" : "FALSE", numeric: false };
    case "str":
    case "e":
    case "d":
      return { v: raw, numeric: false };
    case undefined:
    case "n": {
      const trimmed = raw.trim();
      if (trimmed === "") return { v: "", numeric: false };
      const n = Number(trimmed);
      if (!Number.isFinite(n)) throw new XlsxError(`Ô ${where} có giá trị số không hợp lệ.`);
      return { v: String(n), numeric: true };
    }
    default:
      return { v: raw, numeric: false };
  }
}

/**
 * Đọc sheet đầu tiên của XLSX. Mỗi hàng không trống trả `{ rowNo (số hàng Excel), cells }`, ô thiếu điền `""` để hàng dài
 * bằng ô cuối của nó. Mọi lỗi cấu trúc/giới hạn → `XlsxError`.
 */
export function readXlsx(
  bytes: Uint8Array,
  limits: XlsxLimits = DEFAULT_XLSX_LIMITS,
): { rowNo: number; cells: Cell[] }[] {
  try {
    const zip = openZip(bytes, limits);
    const sheetPath = firstSheetPath(zip);
    const shared = readSharedStrings(zip);
    const sheetXml = requirePart(zip, sheetPath);
    const maxCells = limits.maxCells ?? DEFAULT_MAX_CELLS;

    const rows: { rowNo: number; cells: Cell[] }[] = [];
    let cellCount = 0;
    let prevRow = 0;
    for (const row of elements(sheetXml, "row")) {
      const ra = attrsOf(row.attrs);
      const rAttr = ra.get("r");
      const rowNo = rAttr === undefined ? prevRow + 1 : Number(rAttr);
      if (!Number.isInteger(rowNo) || rowNo < 1 || rowNo > MAX_ROWS)
        throw new XlsxError("Số hàng không hợp lệ.");
      prevRow = rowNo;

      const cells: (Cell | undefined)[] = [];
      let prevCol = -1;
      for (const c of elements(row.inner, "c")) {
        const ca = attrsOf(c.attrs);
        const ref = ca.get("r");
        let col = prevCol + 1;
        if (ref !== undefined) {
          const parsed = parseRef(ref);
          if (!parsed) throw new XlsxError(`Địa chỉ ô không hợp lệ: ${ref}`);
          col = parsed.col;
        }
        if (col >= MAX_COLUMNS) throw new XlsxError("Quá nhiều cột.");
        prevCol = col;
        cells[col] = readCell(ca, c.inner, shared, ref ?? `#${col + 1}`);
      }

      cellCount += cells.length;
      if (cellCount > maxCells) throw new XlsxError("Sheet có quá nhiều ô.");
      const filled: Cell[] = [];
      let blank = true;
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i] ?? { v: "", numeric: false };
        if (cell.v !== "") blank = false;
        filled.push(cell);
      }
      if (!blank) rows.push({ rowNo, cells: filled });
    }
    return rows;
  } catch (e) {
    if (e instanceof XlsxError) throw e;
    throw new XlsxError("Không đọc được file XLSX.", { cause: e });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// XLSX (ghi)
// ---------------------------------------------------------------------------------------------------------------------

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

/** Escape cho nội dung và thuộc tính; ký tự không hợp lệ trong XML 1.0 → U+FFFD; CR → `&#13;` để không bị chuẩn hoá. */
function esc(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (cp === 13) out += "&#13;";
    else if (
      (cp < 0x20 && cp !== 9 && cp !== 10) ||
      (cp >= 0xd800 && cp <= 0xdfff) ||
      cp === 0xfffe ||
      cp === 0xffff
    ) {
      out += "�";
    } else out += ch;
  }
  return out;
}

function colLetters(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetName(raw: string, index: number): string {
  let name = raw.replace(/[[\]:*?/\\]/g, "_");
  // Giới hạn 31 đơn vị UTF-16, không cắt giữa cặp thay thế.
  let cut = "";
  for (const ch of name) {
    if (cut.length + ch.length > 31) break;
    cut += ch;
  }
  name = cut.trim();
  return name === "" ? `Sheet${index + 1}` : name;
}

function sheetXml(rows: (string | number)[][]): string {
  if (rows.length > MAX_ROWS) throw new XlsxError("Quá nhiều hàng.");
  let out = `${XML_HEAD}<worksheet xmlns="${NS_MAIN}"><sheetData>`;
  rows.forEach((row, ri) => {
    if (row.length > MAX_COLUMNS) throw new XlsxError("Quá nhiều cột.");
    out += `<row r="${ri + 1}">`;
    row.forEach((value, ci) => {
      const ref = `${colLetters(ci)}${ri + 1}`;
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new XlsxError(`Ô ${ref} không phải số hữu hạn.`);
        out += `<c r="${ref}"><v>${String(value + 0)}</v></c>`;
      } else if (value !== "") {
        out += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
      }
    });
    out += "</row>";
  });
  return `${out}</sheetData></worksheet>`;
}

interface ZipFile {
  name: string;
  data: Buffer;
}

function zipStore(files: ZipFile[]): Uint8Array {
  const DOS_DATE = 0x21; // 1980-01-01, cố định để đầu ra tất định
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // tên UTF-8
    local.writeUInt16LE(0, 8); // method 0 = store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_EOCD, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  const out = Buffer.concat([...locals, cd, end]);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** Tạo XLSX tối thiểu hợp lệ: chuỗi → inlineStr (escape XML), số → `<v>`; ô `""` bỏ trống. */
export function writeXlsx(sheets: { name: string; rows: (string | number)[][] }[]): Uint8Array {
  if (sheets.length === 0) throw new XlsxError("Workbook cần ít nhất một sheet.");
  const names = sheets.map((s, i) => sheetName(s.name, i));
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n.toLowerCase())) throw new XlsxError(`Tên sheet trùng: ${n}`);
    seen.add(n.toLowerCase());
  }

  const overrides = sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  const contentTypes =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `${overrides}</Types>`;
  const rootRels =
    `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook =
    `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
    names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    "</sheets></workbook>";
  const workbookRels =
    `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    "</Relationships>";

  const files: ZipFile[] = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels, "utf8") },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(sheetXml(s.rows), "utf8"),
    })),
  ];
  return zipStore(files);
}
