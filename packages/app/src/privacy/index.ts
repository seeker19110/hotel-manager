// Điểm công khai của module quyền riêng tư (ARC-MOD-005; PLAN T-2310, D-122): danh mục mục đích, thu/rút đồng ý, trạng thái +
// lịch sử theo người dùng, bộ kiểm đồng ý cho analytics.
export {
  CONSENT_CHANNELS,
  type ConsentAction,
  type ConsentChannel,
  ConsentError,
  type ConsentRecord,
  consentHistory,
  consentOverview,
  createAnalyticsConsentCheck,
  grantConsent,
  hasConsent,
  type PurposeStatus,
  type SetConsentInput,
  type SetConsentResult,
  withdrawConsent,
} from "./consent.ts";
export {
  analyticsConsentView,
  CONSENT_PURPOSES,
  type ConsentPurpose,
  isConsentPurpose,
  type LegalBasisCode,
  PURPOSES,
  type PurposeDef,
  type PurposeTexts,
  type PurposeView,
  purposeDef,
  purposeView,
  uiSnapshotHash,
} from "./purposes.ts";
