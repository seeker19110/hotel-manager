// BASE-DATA-002, UX-CONTENT-002, XC-I18N-005 — chuẩn hoá NFC ở biên đầu vào (thuần, không DB).
// Ca DB "Việt" NFD → lưu NFC nằm ở logging/security-events.db.test.ts (cùng gate T-304).
import { describe, expect, it } from "vitest";
import { nfcDeep } from "./normalize.ts";
import { COMMANDS, QUERIES } from "./registry.ts";

const NFD = "Việt Nam"; // "Việt Nam": ê + dấu nặng tổ hợp
const NFC = "Việt Nam";
const KEY_NFD = "na\u0300me"; // khoá "nàme" dạng tổ hợp

describe("nfc — nfcDeep", () => {
  it("NFD và NFC của 'Việt' khác nhau trước, bằng nhau sau khi chuẩn hoá", () => {
    expect(NFD).not.toBe(NFC);
    expect(NFD.normalize("NFC")).toBe(NFC);
    expect(nfcDeep(NFD)).toBe(NFC);
    expect(nfcDeep(NFC)).toBe(NFC);
  });

  it("đi xuyên object/mảng lồng nhau, cả khoá; số/bool/null/undefined giữ nguyên", () => {
    const out = nfcDeep({
      [KEY_NFD]: NFD,
      list: [NFD, 1, true, null, { x: NFD }],
      n: 0,
      u: undefined,
    });
    expect(out).toEqual({ nàme: NFC, list: [NFC, 1, true, null, { x: NFC }], n: 0, u: undefined });
    expect(Object.keys(out)).toContain("nàme");
  });

  it("chuỗi rỗng, chuỗi chỉ có ký tự ASCII và emoji không đổi; Unicode không tổ hợp được giữ nguyên", () => {
    expect(nfcDeep("")).toBe("");
    expect(nfcDeep("abc 123")).toBe("abc 123");
    expect(nfcDeep("🏨 phòng 201")).toBe("🏨 phòng 201");
    expect(nfcDeep("́")).toBe("́"); // dấu rời đứng một mình không có chữ gốc
  });

  it("không dùng NFKC: ký tự tương thích (¹, ＡＢ) giữ nguyên nghĩa", () => {
    expect(nfcDeep("m¹ Ａ")).toBe("m¹ Ａ");
  });

  it("không biến đổi tại chỗ đầu vào; cấu trúc quá sâu không làm tràn stack", () => {
    const input = { a: [NFD] };
    nfcDeep(input);
    expect(input.a[0]).toBe(NFD);
    let deep: unknown = NFD;
    for (let i = 0; i < 5000; i++) deep = { d: deep };
    expect(() => nfcDeep(deep)).not.toThrow();
  });

  it("schema registry (trim/min/max) nhận chuỗi đã chuẩn hoá: 'Việt' NFD sau nfcDeep qua room_type.create như NFC", () => {
    const def = COMMANDS["room_type.create"];
    const body = (name: string) => ({
      property_id: "6f1a2b3c-0000-4000-8000-123456789012",
      code: "STD",
      name,
      capacity: 2,
    });
    const a = def?.input.safeParse(nfcDeep(body(` ${NFD} `)));
    const b = def?.input.safeParse(nfcDeep(body(NFC)));
    expect(a?.success).toBe(true);
    expect(a?.data).toEqual(b?.data);
    expect(a?.data?.name).toBe(NFC);
  });

  it("registry có lệnh và truy vấn (bảo đảm test trên không rỗng)", () => {
    expect(Object.keys(COMMANDS).length).toBeGreaterThan(50);
    expect(Object.keys(QUERIES).length).toBeGreaterThan(10);
  });
});
