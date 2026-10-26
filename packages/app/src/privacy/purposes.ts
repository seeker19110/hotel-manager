// Danh mục MỤC ĐÍCH xử lý dữ liệu cá nhân trong mã (PLAN T-2310; CMP-RIGHTS-001, CMP-VN-001; D-122) — một nguồn cho: trang Quyền
// riêng tư, ô đồng ý (đăng ký, nhận lời mời, portal), CHECK `purpose` của `consent_records` (migration 0068) và bộ kiểm đồng ý của
// analytics. Chỉ mục đích `requiresConsent` mới thu/rút đồng ý; mục đích hợp đồng/nghĩa vụ pháp lý hiển thị để minh bạch và ghi
// rõ là KHÔNG cần đồng ý riêng. Không có bên thứ ba nhận dữ liệu ⇒ việc lan rút đồng ý tới bên thứ ba là không áp dụng (D-122).
// - Văn bản ở catalog `packages/app/messages/vi.json` (khoá `privacy.purpose.<id>.*`), không viết thẳng (rào i18n).
// - `version`: phiên bản văn bản của mục cần đồng ý. ĐỔI CHỮ ⇒ TĂNG version (test `privacy.test.ts` ghim băm theo version):
//   đồng ý cũ gắn với văn bản cũ nên KHÔNG còn hiệu lực cho văn bản mới (cách hiểu chặt — Luật 91/2025 Đ.9: đồng ý cụ thể, có
//   bằng chứng) — người dùng được hỏi lại.
// - `uiSnapshotHash`: sha-256 hex của đúng văn bản hiển thị (tiêu đề, mô tả, dữ liệu, bên nhận, cơ sở, nhãn ô) + id + version —
//   server tự tính lúc ghi, không nhận từ client.
// Module CHỈ dùng ở server (import catalog của packages/app) — trang server truyền văn bản đã dịch xuống client component.
import { createHash } from "node:crypto";
import { t } from "../i18n.ts";

export type LegalBasisCode = "consent" | "contract" | "legal_obligation";

export interface PurposeTexts {
  title: string;
  description: string;
  /** Loại dữ liệu xử lý cho mục đích này. */
  data: string;
  /** Bên nhận dữ liệu. */
  recipients: string;
  /** Cơ sở pháp lý, nói bằng lời. */
  basis: string;
  /** Nhãn ô đồng ý (chỉ mục cần đồng ý). */
  checkbox: string | null;
}

export interface PurposeDef {
  id: string;
  requiresConsent: boolean;
  legalBasisCode: LegalBasisCode;
  /** Ngày phát hành văn bản `YYYY-MM-DD` (thêm `.n` nếu sửa nhiều lần trong ngày) — khớp CHECK của `consent_records.policy_version`. */
  version: string;
  texts: () => PurposeTexts;
}

/** Mục đích CẦN đồng ý — khớp `CHECK (purpose IN (…))` của `consent_records` (test DB đối chiếu catalog CSDL). */
export const CONSENT_PURPOSES = ["analytics"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const PURPOSES: readonly PurposeDef[] = [
  {
    id: "service",
    requiresConsent: false,
    legalBasisCode: "contract",
    version: "2026-10-25",
    texts: () => ({
      title: t("privacy.purpose.service.title"),
      description: t("privacy.purpose.service.description"),
      data: t("privacy.purpose.service.data"),
      recipients: t("privacy.purpose.service.recipients"),
      basis: t("privacy.purpose.service.basis"),
      checkbox: null,
    }),
  },
  {
    id: "legal",
    requiresConsent: false,
    legalBasisCode: "legal_obligation",
    version: "2026-10-25",
    texts: () => ({
      title: t("privacy.purpose.legal.title"),
      description: t("privacy.purpose.legal.description"),
      data: t("privacy.purpose.legal.data"),
      recipients: t("privacy.purpose.legal.recipients"),
      basis: t("privacy.purpose.legal.basis"),
      checkbox: null,
    }),
  },
  {
    id: "analytics",
    requiresConsent: true,
    legalBasisCode: "consent",
    version: "2026-10-25",
    texts: () => ({
      title: t("privacy.purpose.analytics.title"),
      description: t("privacy.purpose.analytics.description"),
      data: t("privacy.purpose.analytics.data"),
      recipients: t("privacy.purpose.analytics.recipients"),
      basis: t("privacy.purpose.analytics.basis"),
      checkbox: t("privacy.purpose.analytics.checkbox"),
    }),
  },
];

export function isConsentPurpose(id: string): id is ConsentPurpose {
  return (CONSENT_PURPOSES as readonly string[]).includes(id);
}

export function purposeDef(id: ConsentPurpose): PurposeDef {
  const def = PURPOSES.find((p) => p.id === id);
  if (!def?.requiresConsent)
    throw new Error(`purpose "${id}" missing from catalog or does not require consent`);
  return def;
}

/** sha-256 hex của văn bản hiển thị của mục đích (thứ tự khoá cố định) — bằng chứng "người dùng đã thấy gì". */
export function uiSnapshotHash(def: PurposeDef): string {
  const x = def.texts();
  const canonical = JSON.stringify([
    def.id,
    def.version,
    x.title,
    x.description,
    x.data,
    x.recipients,
    x.basis,
    x.checkbox,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Dạng gửi xuống trang/client component: văn bản đã dịch + version để client gửi lại khi đồng ý. */
export interface PurposeView extends PurposeTexts {
  id: string;
  requiresConsent: boolean;
  legalBasisCode: LegalBasisCode;
  version: string;
}

export function purposeView(def: PurposeDef): PurposeView {
  return {
    id: def.id,
    requiresConsent: def.requiresConsent,
    legalBasisCode: def.legalBasisCode,
    version: def.version,
    ...def.texts(),
  };
}

/** Văn bản ô đồng ý analytics cho form đăng ký/nhận lời mời (không tick sẵn). */
export function analyticsConsentView(): PurposeView {
  return purposeView(purposeDef("analytics"));
}
