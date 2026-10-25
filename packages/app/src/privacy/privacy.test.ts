// PLAN T-2310 (D-122) — danh mục mục đích: chỉ mục cần đồng ý mới có ô; mã cơ sở pháp lý hợp lệ; phiên bản khớp CHECK của
// `consent_records.policy_version`; ĐỔI CHỮ hiển thị mà không tăng `version` ⇒ đỏ (băm văn bản ghim theo phiên bản), vì đồng ý gắn
// với đúng văn bản người dùng đã thấy.
import { describe, expect, it } from "vitest";
import {
  analyticsConsentView,
  CONSENT_PURPOSES,
  isConsentPurpose,
  PURPOSES,
  purposeDef,
  uiSnapshotHash,
} from "./index.ts";

/** `id@version` → băm văn bản đã phát hành. Sửa chữ của mục cần đồng ý: tăng `version` trong purposes.ts rồi thêm dòng mới ở đây. */
const PUBLISHED: Record<string, string> = {
  "analytics@2026-10-25": "25c708893f884778b2dec4f389f3ab5b19afa6fcfd901557a1df1e42d8cfac3f",
};

describe("danh mục mục đích (privacy/purposes.ts)", () => {
  it("CONSENT_PURPOSES = đúng các mục requiresConsent; hiện chỉ analytics", () => {
    expect(PURPOSES.filter((p) => p.requiresConsent).map((p) => p.id)).toEqual([...CONSENT_PURPOSES]);
    expect([...CONSENT_PURPOSES]).toEqual(["analytics"]);
    expect(isConsentPurpose("service")).toBe(false);
    expect(isConsentPurpose("analytics")).toBe(true);
    expect(() => purposeDef("service" as never)).toThrow();
  });

  it("mục cần đồng ý có cơ sở 'consent' và nhãn ô; mục khác không có ô và không dựa vào đồng ý", () => {
    for (const p of PURPOSES) {
      const x = p.texts();
      for (const v of [x.title, x.description, x.data, x.recipients, x.basis])
        expect(v.trim(), p.id).not.toBe("");
      if (p.requiresConsent) {
        expect(p.legalBasisCode).toBe("consent");
        expect(x.checkbox?.trim()).toBeTruthy();
      } else {
        expect(p.legalBasisCode).not.toBe("consent");
        expect(x.checkbox).toBeNull();
      }
    }
    expect(new Set(PURPOSES.map((p) => p.id)).size).toBe(PURPOSES.length);
  });

  it("phiên bản khớp CHECK của consent_records.policy_version", () => {
    for (const p of PURPOSES) expect(p.version, p.id).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]{1,3})?$/);
  });

  it("băm văn bản của mọi mục cần đồng ý ghim theo phiên bản (đổi chữ mà không tăng version ⇒ đỏ)", () => {
    for (const id of CONSENT_PURPOSES) {
      const def = purposeDef(id);
      const h = uiSnapshotHash(def);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(PUBLISHED[`${id}@${def.version}`], `${id}@${def.version}: thêm băm đã phát hành`).toBe(h);
    }
  });

  it("băm xác định và đổi khi chữ/phiên bản đổi", () => {
    const def = purposeDef("analytics");
    expect(uiSnapshotHash(def)).toBe(uiSnapshotHash(def));
    expect(uiSnapshotHash({ ...def, version: "2099-01-01" })).not.toBe(uiSnapshotHash(def));
    expect(uiSnapshotHash({ ...def, texts: () => ({ ...def.texts(), recipients: "Bên thứ ba" }) })).not.toBe(
      uiSnapshotHash(def),
    );
  });

  it("view cho form đăng ký/nhận lời mời mang nhãn ô + phiên bản", () => {
    const v = analyticsConsentView();
    expect(v).toMatchObject({
      id: "analytics",
      requiresConsent: true,
      version: purposeDef("analytics").version,
    });
    expect(v.checkbox).toMatch(/không bắt buộc/);
  });
});
