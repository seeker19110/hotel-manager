// T-211 — phần thuần của thông báo: token huỷ đăng ký (S-010), mẫu email (S-012), adapter giả (S-003, S-005).
import { describe, expect, it } from "vitest";
import { EmailError, FakeEmailSender, hasEmailChannel, renderEmail, TemplateError } from "./email.ts";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "./token.ts";

const SECRET = "k".repeat(40);
const ORG = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-16T00:00:00Z");

describe("token huỷ đăng ký (S-010)", () => {
  const claims = { orgId: ORG, personId: PERSON, type: "invoice_overdue" };

  it("ký rồi xác minh được; hạn mặc định 30 ngày; chỉ chứa id + loại", () => {
    const tok = signUnsubscribeToken(SECRET, claims, NOW);
    expect(verifyUnsubscribeToken(SECRET, tok, NOW)).toEqual({ status: "ok", claims });
    expect(verifyUnsubscribeToken(SECRET, tok, new Date(NOW.getTime() + 29 * 86_400_000))).toMatchObject({
      status: "ok",
    });
    expect(verifyUnsubscribeToken(SECRET, tok, new Date(NOW.getTime() + 30 * 86_400_000))).toEqual({
      status: "expired",
    });
    const payload = Buffer.from(tok.split(".")[0] as string, "base64url").toString();
    expect(payload).not.toMatch(/@/);
  });

  it("sai khoá, bị sửa, rỗng, quá dài, định dạng lạ → invalid (không phân biệt lý do)", () => {
    const tok = signUnsubscribeToken(SECRET, claims, NOW);
    const [body] = tok.split(".") as [string];
    const tampered = Buffer.from(
      JSON.stringify({ v: 1, o: ORG, p: PERSON, t: "invoice_issued", exp: 9_999_999_999 }),
    ).toString("base64url");
    for (const bad of ["", "x", "a.b.c", `${tampered}.${tok.split(".")[1]}`, `${body}.`, "é".repeat(700)]) {
      expect(verifyUnsubscribeToken(SECRET, bad, NOW)).toEqual({ status: "invalid" });
    }
    expect(verifyUnsubscribeToken("z".repeat(40), tok, NOW)).toEqual({ status: "invalid" });
  });

  it("token hết hạn nhưng chữ ký giả → invalid chứ không lộ 'expired'; khoá ngắn bị từ chối", () => {
    const forgedExpired = Buffer.from(
      JSON.stringify({ v: 1, o: ORG, p: PERSON, t: "invoice_issued", exp: 1 }),
    ).toString("base64url");
    expect(verifyUnsubscribeToken(SECRET, `${forgedExpired}.AAAA`, NOW)).toEqual({ status: "invalid" });
    expect(() => signUnsubscribeToken("ngắn", claims, NOW)).toThrow(/32 byte/);
  });
});

describe("mẫu email tối thiểu (S-012)", () => {
  it("thiếu biến → TemplateError, không dựng email rỗng; mẫu lạ → TemplateError", () => {
    expect(() =>
      renderEmail("invoice_issued", { propertyName: "X", periodLabel: "10/2026", portalUrl: "https://a" }),
    ).toThrow(TemplateError);
    expect(() =>
      renderEmail("invoice_issued", {
        propertyName: "X",
        periodLabel: " ",
        dueDate: "d",
        portalUrl: "https://a",
      }),
    ).toThrow(/periodLabel/);
    expect(() => renderEmail("khong_co", {})).toThrow(TemplateError);
    expect(() => renderEmail("__proto__", {})).toThrow(TemplateError);
  });

  it("chỉ dùng biến đã khai: dù vars chứa PII, mẫu không in ra", () => {
    const r = renderEmail("invoice_overdue", {
      propertyName: "Hoa Sen",
      periodLabel: "10/2026",
      dueDate: "10/10/2026",
      portalUrl: "https://app.example/hoa-don/1",
      cccd: "012345678901",
      phone: "0912345678",
    });
    expect(r.subject + r.text).not.toMatch(/012345678901|0912345678/);
  });

  it("stay_notice_due chỉ trong app", () => {
    expect(hasEmailChannel("stay_notice_due")).toBe(false);
    expect(hasEmailChannel("invoice_issued")).toBe(true);
  });
});

describe("FakeEmailSender", () => {
  const msg = {
    to: "an@example.test",
    template: "lease_expiring",
    vars: { propertyName: "H", endDate: "30/11/2026", portalUrl: "https://a" },
    idempotencyKey: "k1",
  };

  it("cùng idempotencyKey → trả id cũ, không thêm thư", async () => {
    const f = new FakeEmailSender();
    const a = await f.send(msg);
    const b = await f.send(msg);
    expect(b).toEqual(a);
    expect(f.mailbox).toHaveLength(1);
    expect(f.calls).toBe(2);
  });

  it("lỗi tạm/vĩnh viễn cấu hình được; địa chỉ sai → PERMANENT RECIPIENT_INVALID", async () => {
    const f = new FakeEmailSender();
    f.behavior = "temporary";
    await expect(f.send(msg)).rejects.toMatchObject({ kind: "TEMPORARY", code: "PROVIDER_TEMPORARY" });
    f.behavior = "ok";
    const e = await f.send({ ...msg, to: "khong-phai-email", idempotencyKey: "k2" }).catch((x) => x);
    expect(e).toBeInstanceOf(EmailError);
    expect(e).toMatchObject({ kind: "PERMANENT", code: "RECIPIENT_INVALID" });
    expect(f.mailbox).toHaveLength(0);
  });
});
