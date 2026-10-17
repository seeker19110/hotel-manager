// Phiên bản bản build (SPEC-pwa S-009, `app.getVersion`): lấy từ `apps/web/package.json` — không qua biến môi trường.
// `version` là phiên bản build đang chạy; `hm.minClientVersion` là mức client tối thiểu server còn chấp nhận (thấp hơn ⇒ 426).
import pkg from "../package.json" with { type: "json" };

export const APP_VERSION: string = pkg.version;
export const MIN_CLIENT_VERSION: string = pkg.hm.minClientVersion;
