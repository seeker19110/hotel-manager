---
title: Hiệu năng — ngưỡng, kịch bản đo, baseline (Hotel Manager)
kind: perf
updated: 2026-10-17
---

# Hiệu năng

> Nguồn ngưỡng: `PROJECT.md` §5 và `docs/ops/SLO.md`. Mục blueprint: `XC-PERF-004` (phân vị, không dùng trung bình làm cổng), `XC-GREEN-001` (baseline tài nguyên),
> `QA-PERF-002/006/007/010`, `FE-PERF-002`. **Chưa đo trên staging/VPS thật** — các số trong repo là số đo cục bộ (xem "Baseline").

## 1. Ngưỡng (một nguồn, test `scripts/perf.test.mjs` đối chiếu với mã)

```json perf-thresholds
{
  "api_p95_ms": 800,
  "api_p99_ms": 2000,
  "hold_p95_ms": 1500,
  "hold_p99_ms": 3000,
  "http_req_failed_rate": 0.01,
  "lighthouse": { "performance": 0.9, "accessibility": 0.9, "lcp_ms": 2500, "cls": 0.1, "tbt_ms": 300, "runs": 5 }
}
```

| Chỉ số | Ngưỡng | Cổng | Nơi khai báo |
|---|---|---|---|
| API thường p95 / p99 | < 800 ms / < 2 000 ms | k6 `thresholds` (`abortOnFail` ở tỷ lệ lỗi) | `perf/k6/lib.js` (`LIMITS`) |
| Tạo giữ phòng p95 / p99 | < 1,5 s / < 3 s | k6 | `perf/k6/create-hold.js` |
| Tỷ lệ lỗi HTTP | < 1% (409/422 nghiệp vụ không tính) | k6 `http_req_failed` | `perf/k6/lib.js` |
| Lighthouse mobile (5 lần, median) | Performance ≥ 0,9 · Accessibility ≥ 0,9 · LCP ≤ 2 500 ms · CLS ≤ 0,1 → `error`; TBT ≤ 300 ms, Best Practices/SEO ≥ 0,9 → `warn` | `lhci assert` | `lighthouserc.json` |
| Trọng lượng trang / số request (build production, Pixel 7, không cache) | ngân sách từng màn = baseline × 1,3 | E2E `apps/web/e2e/perf-baseline.spec.ts` (job `e2e` hiện có, không cần đổi workflow) | `perf/budgets.json` |

Không có ngưỡng nào dùng trung bình (`avg<`) — chỉ phân vị (XC-PERF-004). Assertion Lighthouse mới đặt `warn` trước, siết `error` sau khi ổn định (QA-PERF-015): TBT, Best Practices, SEO đang `warn`, **đề xuất siết `error` sau 4 tuần có số đo thật (không muộn hơn 2026-12-31)**; không xoá assertion để cho xanh.

## 2. Kịch bản k6 (`perf/k6/`)

| Kịch bản | Luồng | Cần |
|---|---|---|
| `login-select-org.js` | đăng nhập → `/api/v1/me` → `session.switchOrganization` | `USER_EMAIL`, `USER_PASSWORD` (tài khoản không MFA), `ORG_ID` |
| `room-list.js` | `/phong` + `today.getSummary` + `reservation.list` 7 ngày | `K6_COOKIE`, `ORG_ID`, `PROPERTY_ID` |
| `create-hold.js` | `reservation.create` → `reservation.hold` | `K6_COOKIE` (lễ tân/quản lý, đã qua MFA), `ORG_ID`, `UNIT_IDS` |
| `collect-cash.js` | `payment.collectCash` trên hoá đơn đã phát hành | `K6_COOKIE`, `ORG_ID`, `INVOICE_IDS` (+ ca quầy đang mở), `AMOUNT` |

Dùng chung `perf/k6/lib.js`: `BASE_URL` bắt buộc và **phải nằm trong `K6_ALLOWED_HOSTS`** (mặc định chỉ `localhost,127.0.0.1,[::1]`; QA-PERF-007 — không tải vào production; thêm host staging có chủ đích). `K6_PROFILE=smoke` (mặc định, 1 VU × 30 s) · `load` (tăng dần tới `LOAD_VUS`, mặc định 200 phiên đồng thời) · `spike` (`ramping-arrival-rate`, QA-PERF-012).

```bash
k6 run -e BASE_URL=http://127.0.0.1:3100 -e K6_COOKIE="…" -e ORG_ID=… -e PROPERTY_ID=… perf/k6/room-list.js
k6 run -e K6_PROFILE=load -e LOAD_VUS=200 … perf/k6/create-hold.js
```

Dữ liệu đo tải theo `PROJECT.md` §5: 100 tổ chức, 5.000 phòng, 200 phiên — **seeder cho cỡ này chưa có** (việc kế tiếp; dùng `@hm/testkit` `seedOrg`). Giấy phép k6: AGPL-3.0 — chỉ dùng để đo, không phân phối bản sửa (ghi trong kiểm kê giấy phép).

## 3. Lighthouse CI (`lighthouserc.json`)

3 URL công khai (`/dang-nhap`, `/dang-nhap/nguoi-thue`, `/offline`) trên server E2E (`pnpm --filter @hm/web exec node e2e/server.ts`, cần `pnpm build` trước), `numberOfRuns: 5` (median loại bớt run nhiễu; ngưỡng giữ nguyên), `aggregationMethod: median`, mobile, `throttlingMethod: "simulate"` (mặc định của lhci, ghi tường minh — không tắt throttle), Chromium chạy với `--disable-dev-shm-usage` (`/dev/shm` nhỏ trên runner). `startServerReadyPattern` = `E2E_SERVER_READY`, dấu hiệu `e2e/server.ts` in sau khi `/api/health` của server CHÍNH trả 200 ("Ready in" của Next in cả cho bản sao nên không đủ); job đặt `E2E_NO_REPLICA=1` để không chạy bản sao thứ hai. Job CI `lighthouse` (`.github/workflows/frontend-quality.yml`) chạy `pnpm exec lhci autorun` (`@lhci/cli@0.15.1`, Apache-2.0, devDependency của pnpm workspace gốc — MỘT lockfile, FE-BUILD-001; phụ thuộc chuyển tiếp `parse-cache-control@1.0.1` khai giấy phép "BSD" không có SPDX id nên có ngoại lệ có hạn đúng gói+phiên bản trong `license-policy.json`, D-068, hạn rà lại 2027-04-18) (pha build chỉ chạy tay — D-084/D-085; harden: PR và main), đỏ khi vi phạm assert mức `error`; báo cáo lưu artifact `lighthouse-report`. Màn nhân viên (`/phong`…) cần đăng nhập: bổ sung `puppeteerScript` khi được duyệt thêm phụ thuộc (PRF-WEB-005 đòi ≥ 5 URL và required check — chưa đạt). Repo lhci không commit từ 2025-06-26 — theo dõi phương án thay thế mỗi 6 tháng (QA-PERF-016).

Số đo cục bộ 2026-10-18 (Chromium 1194, máy chia sẻ tải ~12 trên 4 lõi — **không** phải số chuẩn): lần đầu 3 URL × 3 run, `/dang-nhap` Performance 0,79/0,71/0,99 (median 0,79 → đỏ, TBT lên 2 228 ms ở run tải nặng); chạy lại riêng `/dang-nhap` 5 run: median đạt mọi assert. Runner CI chuyên dụng ít nhiễu hơn; **theo dõi lượt CI đầu tiên**, nếu vẫn dao động thì tối ưu trang, không hạ ngưỡng.

## 4. Baseline (`docs/perf/baseline-*.json`)

| File | Đo gì | Trạng thái |
|---|---|---|
| `baseline-web-2026-10-17.json` | trọng lượng + số request 8 màn, độ trễ API p50/p95/p99 (1.000 mẫu, 1 VU), CPU/RSS backend theo 1.000 yêu cầu | **đã đo** cục bộ (Chromium Pixel 7, localhost, không throttle) |
| `baseline-k6.json` | k6 theo kịch bản trên | **chưa đo** — không có k6 trong môi trường; lý do ghi trong file |
| `baseline-lighthouse.json` | Lighthouse CI | **chưa đo** — không có lhci/lighthouse; lý do ghi trong file |

Tạo lại baseline web (đổi code có ảnh hưởng tài nguyên, hoặc sau khi nâng phụ thuộc):

```bash
cd apps/web && PERF_BASELINE_OUT=../../docs/perf/baseline-web-$(date +%F).json pnpm exec playwright test perf-baseline
```

Mỗi file có `date`, `commit`, môi trường, thiết bị/mạng, số mẫu (QA-PERF-006); test `perf` từ chối file đã `measured: true` mà thiếu trường. kWh/1.000 yêu cầu **chưa đo** (cần đồng hồ/cgroup của VPS) — CPU-giây là chỉ báo thay thế (XC-GREEN-001). Số cục bộ chỉ so tương đối giữa các lần chạy cùng môi trường.

## 5. Job CI (1 đã có từ đợt 9 — `lighthouse`; còn lại là đề xuất)

1. **PR, job `e2e` (đã có):** `perf-baseline.spec.ts` chạy cùng bộ E2E, chặn khi vượt `perf/budgets.json` — **không cần đổi workflow**.
2. **Job `lighthouse` (đã có; pha build chỉ chạy tay — D-084/D-085, harden: mỗi PR):** `pnpm install --frozen-lockfile && pnpm build && pnpm exec lhci autorun` (3 URL × 5 lần, `error` theo `lighthouserc.json`), tải `.lighthouseci/` làm artifact.
3. **Nightly (đã có, đợt 10 — D-072): `.github/workflows/perf-nightly.yml` job `k6`** gọi `bash scripts/perf-load.sh` — cùng lệnh khoá `perf` của `xt.yaml` (`release-check` chạy trước phát hành; chạy cục bộ được, kết quả ra `mktemp -d`, `PERF_SKIP_BUILD=1` bỏ build) — chạy `perf/k6/room-list.js` (`K6_PROFILE=load`, 20 VU × 3 phút) hằng đêm và chạy tay, trên app dựng tạm trong runner như job `e2e` (Postgres service, seed giả), đỏ khi vượt `thresholds`; đích chỉ loopback (`scripts/k6-target-guard.mjs` + `assertSafeTarget`, QA-PERF-007). Khi có staging: thêm chế độ đích staging cho `scripts/perf-load.sh` (hiện script chỉ tải vào app tạm nó tự dựng, `BASE_URL` khác → exit 2) rồi đổi `BASE_URL`/`K6_ALLOWED_HOSTS` sang host staging (`*.staging.*`), thêm kịch bản ghi (`create-hold.js`) với phiên riêng; weekly `LOAD_DURATION=30m` (soak, QA-PERF-011) vẫn chờ staging.
4. Ghi kết quả đầu tiên vào `docs/perf/baseline-k6.json` / `baseline-lighthouse.json` và mục hiệu năng của `GO-NO-GO.md` (kèm 5 trường: commit, môi trường, thiết bị/mạng, VU/thời lượng, ngày).
