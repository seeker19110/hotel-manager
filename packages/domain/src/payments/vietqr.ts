// Chuỗi VietQR (NAPAS, theo EMVCo MPM) — chỉ là THÔNG TIN chuyển tiền (SPEC-ledger S-015), không phải xác nhận đã trả.
// Nguồn xác minh 2026-10-15 (docs/research/2026-10-15-vietqr.md): cấu trúc trường từ nguồn thứ cấp (README thư viện MIT,
// blog) có 3 chuỗi mẫu tự khớp CRC; văn bản NAPAS v1.5.2 gốc CHƯA truy cập được → (chưa xác minh) với 59/60, giới hạn
// 62.08. Vì vậy chỉ sinh đúng tập trường của các chuỗi mẫu: 00, 01, 38 (00 GUID, 01 BIN+TK, 02 QRIBFTTA), 53, 54, 58,
// 62.08, 63; nội dung CK chỉ gồm [A-Z0-9 ] ≤ 25 ký tự (mã tham chiếu 8 ký tự) để an toàn với mọi ứng dụng ngân hàng.

/** BIN ngân hàng (api.vietqr.io/v2/banks, 2026-10-15). `bank_code` của tài khoản nhận có thể là mã ngắn hoặc chính BIN. */
export const BANK_BINS: Readonly<Record<string, string>> = {
  VCB: "970436",
  TCB: "970407",
  MB: "970422",
  VPB: "970432",
  ACB: "970416",
  BIDV: "970418",
  ICB: "970415",
};

export function bankBin(bankCode: string): string | null {
  if (/^97\d{4}$/.test(bankCode)) return bankCode;
  return BANK_BINS[bankCode] ?? null;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — kiểm: "123456789" → 29B1. */
export function crc16CcittFalse(s: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(s)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function tlv(id: string, value: string): string {
  if (value.length > 99) throw new RangeError(`Trường ${id} dài quá 99 ký tự`);
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

export interface VietQrInput {
  bin: string;
  accountNumber: string;
  /** Đồng, số nguyên dương; bỏ trống → QR tĩnh (người chuyển tự nhập số tiền). */
  amount?: number;
  /** Nội dung chuyển khoản (mã tham chiếu). */
  memo?: string;
}

export function buildVietQr(input: VietQrInput): string {
  if (!/^\d{6}$/.test(input.bin)) throw new RangeError("BIN ngân hàng phải 6 chữ số");
  if (!/^\d{4,19}$/.test(input.accountNumber)) throw new RangeError("Số tài khoản không hợp lệ");
  if (
    input.amount !== undefined &&
    (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > 9_999_999_999_999)
  ) {
    throw new RangeError("Số tiền phải là số nguyên đồng dương, tối đa 13 chữ số");
  }
  if (input.memo !== undefined && !/^[A-Z0-9 ]{1,25}$/.test(input.memo)) {
    throw new RangeError("Nội dung CK chỉ gồm A-Z, 0-9, khoảng trắng, tối đa 25 ký tự");
  }
  const beneficiary = tlv("00", input.bin) + tlv("01", input.accountNumber);
  const merchant = tlv("00", "A000000727") + tlv("01", beneficiary) + tlv("02", "QRIBFTTA");
  let s =
    tlv("00", "01") +
    tlv("01", input.amount === undefined ? "11" : "12") +
    tlv("38", merchant) +
    tlv("53", "704");
  if (input.amount !== undefined) s += tlv("54", String(input.amount));
  s += tlv("58", "VN");
  if (input.memo !== undefined) s += tlv("62", tlv("08", input.memo));
  s += "6304";
  return s + crc16CcittFalse(s);
}
