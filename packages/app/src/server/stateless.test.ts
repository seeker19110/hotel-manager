// ARC-RES-005 (12-factor VI) — tiến trình phục vụ KHÔNG giữ trạng thái giữa request: phiên, upload tạm, khoá, cache "nguồn
// sự thật" đều ở Postgres/object storage. Rào tĩnh (bổ sung cho E2E hai bản sao `apps/web/e2e/replicas.spec.ts` và test
// DB hai pool `webhook-rate-limit.db.test.ts`): mọi biến CẤP MODULE có thể đổi (`let`, `Map`/`WeakMap`/`Set` rỗng, bộ đếm
// metric) phải nằm trong danh sách đã duyệt kèm lý do "không làm sai kết quả khi chạy ≥ 2 bản"; mọi chỗ ghi file ngoài thư
// mục tạm cũng vậy. Mục mới chưa khai báo → đỏ; mục khai báo mà mã đã bỏ → đỏ (danh sách không phình âm thầm).
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../testing/source-scan.ts";

const ROOTS = ["packages/app/src", "packages/domain/src", "packages/db/src", "apps/web/app", "apps/web/lib"];

/** `tệp:tên` → lý do biến cấp module này an toàn khi scale ngang. */
const MODULE_STATE: Record<string, string> = {
  "packages/app/src/server/context.ts:ctx":
    "singleton kết nối (pool CSDL, auth, dịch vụ) dựng lười một lần mỗi tiến trình — tài nguyên, không phải dữ liệu nghiệp vụ",
  "packages/app/src/logging/logger.ts:cachedVersion":
    "hằng build (phiên bản) đọc một lần; mọi bản sao cùng giá trị",
  "packages/app/src/analytics/track.ts:defaults":
    "cấu hình tiêm MỘT lần lúc khởi động tiến trình (bộ kiểm đồng ý analytics, chế độ strict); mọi bản sao dựng giống nhau, mặc định từ chối — không giữ dữ liệu nghiệp vụ giữa các request",
  "packages/app/src/logging/runtime.ts:current":
    "logger của tiến trình (đầu ra), không ảnh hưởng kết quả request",
  "packages/app/src/auth/auth.ts:requestState":
    "WeakMap theo đối tượng Request đang xử lý — sống đúng một request, thu gom khi xong",
  "packages/app/src/privacy/consent.ts:perTransaction":
    "WeakMap theo đối tượng transaction của lệnh: cache kết quả kiểm đồng ý analytics trong đúng transaction đó, thu gom khi xong — không sống qua request",
  "packages/app/src/logging/trace.ts:byRequest":
    "WeakMap theo Request: ngữ cảnh truy vết của đúng request đó, không sống qua request",
  "packages/app/src/approvals/approvals.ts:executors":
    "danh bạ hàm thực thi đăng ký lúc nạp module (mã, không dữ liệu) — mọi bản sao đăng ký như nhau",
  "packages/app/src/deposits/deposits.ts:registered":
    "cờ đăng ký executor một lần lúc nạp module (idempotent)",
  "packages/app/src/ledger/period-close.ts:registered":
    "cờ đăng ký executor một lần lúc nạp module (idempotent)",
  "packages/app/src/stay/checkout.ts:registered": "cờ đăng ký executor một lần lúc nạp module (idempotent)",
  "packages/app/src/stay/folio.ts:registered": "cờ đăng ký executor một lần lúc nạp module (idempotent)",
  "packages/app/src/stay/reservations.ts:registered":
    "cờ đăng ký executor một lần lúc nạp module (idempotent)",
  "packages/app/src/observability/http-metrics.ts:httpMetrics":
    "bộ đếm metric của TIẾN TRÌNH này (Prometheus scrape từng bản sao rồi cộng) — quan sát, không quyết định kết quả",
  "packages/domain/src/format/intl.ts:currencyFormats":
    "memo các đối tượng Intl thuần theo (locale, tuỳ chọn) — hàm thuần, không đổi kết quả",
  "packages/domain/src/format/intl.ts:numberFormats": "memo đối tượng Intl thuần — không đổi kết quả",
  "packages/domain/src/format/intl.ts:dateFormats": "memo đối tượng Intl thuần — không đổi kết quả",
  "packages/domain/src/format/intl.ts:unitPriceFormats": "memo đối tượng Intl thuần — không đổi kết quả",
};

/** Ghi file: `tệp` → lý do được phép (ngoài thư mục tạm). */
const FILE_WRITES: Record<string, string> = {
  "packages/app/src/auth/otp-mail.ts":
    "nhà vận chuyển thư GIẢ `fake://file` cho dev/E2E (cấu hình tường minh); không phải trạng thái phục vụ",
};

const LET = /^(?:export )?let (\w+)/gm;
const MUTABLE_CONST =
  /^(?:export )?const (\w+)(?:: [^=\n]+)? = (?:new (?:Map|WeakMap)(?:<[^(\n]*>)?\(|new Set(?:<[^(\n]*>)?\(\)|createHttpMetrics\(\))/gm;

/** Biến cấp module (cột 0) có thể đổi: mọi `let`, `Map`/`WeakMap` mới, `Set` rỗng, bộ đếm metric. */
function moduleState(text: string): string[] {
  return [...text.matchAll(LET), ...text.matchAll(MUTABLE_CONST)].map((m) => m[1] as string);
}

describe("ARC-RES-005 — không trạng thái trong bộ nhớ tiến trình làm sai kết quả", () => {
  const files = sourceFiles(ROOTS, /\.(ts|tsx)$/).filter((f) => !f.path.includes("/testing/"));

  it("bộ dò bắt đúng (let, Map, Set rỗng, metric) và bỏ qua hằng/hàm", () => {
    const sample = [
      "let a = 1;",
      "export let b: string | undefined;",
      "const c = new Map<string, number>();",
      "const d = new WeakMap<object, number>();",
      'const e = new Set(["x"]);',
      "const f = new Set();",
      "const g = createHttpMetrics();",
      "const h = 5;",
      "  let nested = 1;",
    ].join("\n");
    expect(moduleState(sample).sort()).toEqual(["a", "b", "c", "d", "f", "g"]);
  });

  it("mọi biến cấp module có thể đổi đều nằm trong danh sách đã duyệt kèm lý do; không mục thừa", () => {
    const found = files.flatMap((f) => moduleState(f.text).map((n) => `${f.path}:${n}`));
    expect(found.sort()).toEqual(Object.keys(MODULE_STATE).sort());
    for (const why of Object.values(MODULE_STATE)) expect(why.length).toBeGreaterThan(30);
  });

  it("ghi file ngoài thư mục tạm chỉ ở nơi đã duyệt (mã phục vụ web/worker không lưu upload/phiên ra đĩa)", () => {
    const WRITE =
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdirSync|renameSync|copyFile)\b/;
    const found = files.filter((f) => WRITE.test(f.text)).map((f) => f.path);
    expect(found.sort()).toEqual(Object.keys(FILE_WRITES).sort());
    for (const why of Object.values(FILE_WRITES)) expect(why.length).toBeGreaterThan(30);
  });
});
