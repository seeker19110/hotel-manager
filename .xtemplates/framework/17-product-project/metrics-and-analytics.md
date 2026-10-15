---
title: Đo lường sản phẩm: sự kiện, funnel, quyền riêng tư trong analytics
kind: module
prefix: PM-METRIC
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo, api-service, ai-agent, agentic-system, data-ml, blockchain]
updated: 2026-10-14
---

# Đo lường sản phẩm: sự kiện, funnel, quyền riêng tư trong analytics

> Chỉ số thành công ở `PROJECT.md` chỉ có nghĩa khi có **sự kiện sản phẩm có schema** đo được nó, **funnel** cho luồng
> chính, một **North Star** và các chỉ số đầu vào — và tất cả được thu thập **tôn trọng quyền riêng tư** (không
> theo dõi khi chưa có căn cứ hợp pháp/đồng ý). Quan sát hệ thống (log/metric/trace) là việc khác, ở
> [`../15-operations/observability.md`](../15-operations/observability.md); đồng ý và quyền chủ thể dữ liệu ở
> [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md).

## Nguyên tắc

1. **Đo cái đã hứa.** Mỗi chỉ số thành công trong `PROJECT.md` ánh xạ tới ≥1 sự kiện; tính năng chưa có sự kiện đo thì chưa Done.
2. **Sự kiện là hợp đồng có schema.** Tên, thuộc tính, kiểu, phiên bản được định nghĩa ở một nơi (JSON Schema/kiểu tĩnh), kiểm lúc chạy và lúc build — không "gửi gì cũng được".
3. **North Star một, đầu vào vài.** Một chỉ số phản ánh giá trị người dùng nhận được; 2–4 chỉ số đầu vào đội có thể tác động; chỉ số phù phiếm (lượt xem, số đăng ký không dùng) không làm mục tiêu.
4. **Funnel cho luồng chính** (từ `PM-REQ-015`): mỗi bước một sự kiện, tỷ lệ rớt giữa các bước là nơi tìm việc tiếp theo.
5. **Quyền riêng tư theo thiết kế**: không thu thập khi chưa có căn cứ hợp pháp; không PII trong thuộc tính sự kiện; tối thiểu hoá; thời hạn lưu; tôn trọng tín hiệu từ chối; dữ liệu analytics cũng là dữ liệu cá nhân nếu định danh được.
6. **Thử nghiệm có kiểm định.** A/B có giả thuyết, chỉ số chính, cỡ mẫu tính trước, phương pháp kiểm định chọn trước, chỉ số rào chắn (guardrail); không "nhìn tới khi có ý nghĩa".
7. **Baseline trước khi đổi.** Đo trước phát hành/thay đổi để so sánh; không có baseline thì không kết luận "tăng".

## Quyết định

| Nhu cầu | Lựa chọn mặc định | Điều kiện | Cảnh báo |
|---|---|---|---|
| Web/site tĩnh chỉ cần lượt truy cập, không cookie | Analytics nhẹ không cookie, tự host (vd Plausible — AGPL-3.0; Umami — MIT) | Không cần hồ sơ người dùng, không funnel phức tạp | Vẫn là xử lý dữ liệu cá nhân nếu lưu IP/định danh — kiểm chính sách của công cụ; xác minh lại license/phiên bản trước khi dùng |
| Sản phẩm cần funnel, cohort, A/B, session | Nền tảng sự kiện tự host hoặc SaaS có DPA (vd PostHog — core MIT, phần EE license riêng) | Có người dùng đăng nhập, cần phân tích hành vi | Phần EE/cloud có điều khoản riêng; thẩm định theo `PM-RISK-006`; tắt tính năng ghi hình phiên nếu không có đồng ý rõ |
| Backend/API/CLI/thư viện | Đếm sự kiện phía server, log có cấu trúc + metric (OpenTelemetry) gửi tới hệ quan sát | Không có UI hoặc người dùng là máy | CLI: telemetry phải opt-in rõ, có biến tắt (catalog 11: tắt telemetry mặc định) |
| Mobile | SDK sự kiện có cơ chế đồng ý trước khi khởi tạo | Store yêu cầu khai báo thu thập dữ liệu | Không khởi tạo SDK trước khi có đồng ý; khai báo đúng trong store listing |
| Ngành bị quản lý / dữ liệu nhạy cảm | Tự host trong vùng dữ liệu cho phép, DPIA trước | Y tế, tài chính, trẻ em | Không dùng SaaS analytics chưa có DPA + đánh giá chuyển dữ liệu xuyên biên giới |

**Mặc định:** sự kiện định nghĩa trong repo (`analytics/events.schema.json` hoặc kiểu tĩnh) → một hàm `track()` duy nhất kiểm schema → không gọi khi chưa có đồng ý → dashboard North Star + funnel.

## Checklist

- [ ] `PM-METRIC-001` **MUST@L** Có bảng ánh xạ chỉ số thành công → sự kiện → cách tính; mỗi chỉ số trong `PROJECT.md` có ≥1 sự kiện. → Kiểm: `docs/metrics/METRICS.md` (hoặc mục trong `PROJECT.md`) có đủ cột; script so khớp tên chỉ số với schema sự kiện.
- [ ] `PM-METRIC-002` **MUST@L** Mọi sự kiện có schema ở một nơi: tên (quy ước `doi_tuong.hanh_dong`, snake_case), thuộc tính + kiểu, bắt buộc/tuỳ chọn, phiên bản, ngày thêm, chủ. → Kiểm: `analytics/events.schema.json` validate bằng `ajv`/`check-jsonschema`; test gọi `track()` với payload sai phải fail.
- [ ] `PM-METRIC-003` **MUST** Có đúng một điểm gửi sự kiện (`track()`/`emit()`), kiểm schema tại đó; không gọi SDK analytics rải rác. → Kiểm: `rg -n "posthog\.capture|plausible\(|gtag\(|analytics\.track" src/ | rg -v "analytics/track"` rỗng.
- [ ] `PM-METRIC-004` **MUST** Không gửi sự kiện, không khởi tạo SDK, không đặt cookie/định danh analytics trước khi có căn cứ hợp pháp (đồng ý khi luật yêu cầu); rút đồng ý thì dừng ngay. → Kiểm: E2E (Playwright/Maestro) tải trang lần đầu không có request tới domain analytics và không có cookie analytics; sau khi từ chối vẫn không có. · Nguồn: xem [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md)
- [ ] `PM-METRIC-005` **MUST** Thuộc tính sự kiện không chứa PII thô (email, số điện thoại, tên, địa chỉ, nội dung nhập tự do, token); định danh người dùng là ID nội bộ hoặc giả danh. → Kiểm: schema cấm tên trường trong danh sách đen; test đơn vị quét payload bằng regex email/số điện thoại; review PR thêm sự kiện.
- [ ] `PM-METRIC-006` **MUST@M** Thời hạn lưu dữ liệu analytics ghi rõ và được cấu hình (xoá/ẩn danh hoá sau N tháng theo chính sách và luật áp dụng); người dùng xoá tài khoản thì dữ liệu định danh được bị xoá/ngắt liên kết. → Kiểm: cấu hình retention trong công cụ (ảnh chụp/IaC); test luồng xoá tài khoản gọi API xoá của analytics.
- [ ] `PM-METRIC-007` **MUST@L** Funnel cho mỗi luồng chính được định nghĩa (bước → sự kiện) và có dashboard hiển thị tỷ lệ chuyển đổi từng bước. → Kiểm: `docs/metrics/METRICS.md` mục Funnel; link dashboard mở được; ảnh chụp tại cổng G7.
- [ ] `PM-METRIC-008` **MUST@L** Baseline của chỉ số thành công được đo và ghi trước mỗi phát hành lớn; so sánh sau phát hành ghi vào `PROGRESS.md`/release notes nội bộ. → Kiểm: bảng "Baseline → sau phát hành" có ngày và số cho mỗi mốc.
- [ ] `PM-METRIC-009` **SHOULD** North Star và 2–4 chỉ số đầu vào ghi trong `PROJECT.md`, mỗi chỉ số có định nghĩa tính toán rõ (tử số, mẫu số, cửa sổ thời gian). → Kiểm: mục "North Star" có công thức, không chỉ tên.
- [ ] `PM-METRIC-010` **SHOULD** Thay đổi schema sự kiện tương thích ngược (thêm trường tuỳ chọn; đổi nghĩa thì tạo tên/phiên bản mới), có ghi CHANGELOG của sự kiện. → Kiểm: diff schema trong PR; CI chạy test tương thích ngược (payload cũ vẫn validate).
- [ ] `PM-METRIC-011` **SHOULD** A/B test có tài liệu trước khi chạy: giả thuyết, chỉ số chính, chỉ số rào chắn, cỡ mẫu/thời gian tính trước, phương pháp kiểm định, tiêu chí dừng; kết quả ghi lại dù thất bại. → Kiểm: `docs/experiments/EXP-NNN.md` có đủ mục trước ngày bật; kết luận có p-value/khoảng tin cậy hoặc phương pháp Bayes đã khai báo.
- [ ] `PM-METRIC-012` **SHOULD** Tôn trọng tín hiệu từ chối của trình duyệt/hệ điều hành (Global Privacy Control, App Tracking Transparency) và không dùng kỹ thuật định danh vòng (fingerprinting). → Kiểm: test với header `Sec-GPC: 1` không gửi sự kiện định danh; review không có thư viện fingerprint.
- [ ] `PM-METRIC-013` **SHOULD** Dashboard North Star + funnel + chỉ số đầu vào mọi người trong đội mở được, cập nhật tự động, có ngày dữ liệu cuối. → Kiểm: link trong `README.md`/`docs/metrics/`; ảnh chụp tại cổng G8.
- [ ] `PM-METRIC-014` **SHOULD** Sự kiện cho tính năng mới là phần của DoD (`PM-SPEC-009`): PR tính năng kèm sự kiện + test schema. → Kiểm: PR `feat:` có diff `analytics/` hoặc ghi "không cần đo" có lý do.
- [ ] `PM-METRIC-015` **SHOULD** Sản phẩm dùng AI đo thêm: tỷ lệ phản hồi bị người dùng sửa/từ chối, chi phí mỗi tác vụ, độ trễ; chi tiết ở [`../13-ai-engineering/observability-and-cost.md`](../13-ai-engineering/observability-and-cost.md). → Kiểm: sự kiện `ai.*` trong schema.
- [ ] `PM-METRIC-016` **MAY** Thu thập phản hồi định tính có cấu trúc (khảo sát ngắn trong sản phẩm, kênh báo lỗi) và gắn với sự kiện để đối chiếu số với lời. → Kiểm: sự kiện `feedback.submitted` + kho phản hồi.
- [ ] `PM-METRIC-017` **MAY** Sự kiện kiểm toán nghiệp vụ (ai làm gì khi nào) tách khỏi analytics sản phẩm và có nhà riêng ở [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md). → Kiểm: không có sự kiện audit trong `events.schema.json`.

## Bẫy thường gặp

| Bẫy | Dấu hiệu | Cách tránh |
|---|---|---|
| Đo sau khi ra mắt | Không có baseline, không biết tính năng có tác dụng | Sự kiện là phần của DoD; baseline trước phát hành |
| Sự kiện tự do | 5 tên cho một hành động, thuộc tính kiểu lẫn lộn | Schema một nơi, `track()` một điểm, test schema |
| SDK khởi tạo trước đồng ý | Cookie/request analytics ngay lần tải đầu | E2E kiểm không có request trước đồng ý (`PM-METRIC-004`) |
| PII trong thuộc tính | Email, nội dung ô nhập trong payload | Danh sách đen trường + regex quét trong test |
| Chỉ số phù phiếm | "Lượt xem tăng" làm mục tiêu | North Star gắn giá trị người dùng; chỉ số đầu vào đội tác động được |
| Peeking A/B | Dừng khi "đã có ý nghĩa" sau 2 ngày | Cỡ mẫu và tiêu chí dừng khai báo trước; hoặc phương pháp sequential đã chọn trước |
| Trộn analytics với log hệ thống | Dashboard sản phẩm đọc từ log lỗi | Hai nhà: sự kiện sản phẩm vs observability |
| Session replay mặc định | Ghi hình phiên gồm dữ liệu nhập | Tắt mặc định; chỉ bật có đồng ý rõ, che ô nhập |
| Telemetry CLI ngầm | Thư viện/CLI gửi dữ liệu không báo | Opt-in, biến môi trường tắt, ghi trong README |

## Cổng tự động

| Việc | Công cụ / lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| Schema sự kiện hợp lệ | `npx ajv-cli validate -s analytics/events.schema.json -d "analytics/examples/*.json"` (MIT) · `check-jsonschema` (Apache-2.0) | pre-commit + CI | 0 lỗi |
| Một điểm gửi sự kiện | `rg -n "capture\(|gtag\(|\.track\(" src/ --glob '!src/analytics/**'` | CI | 0 kết quả |
| Không request analytics trước đồng ý | Playwright: `page.on('request')` lọc domain analytics khi tải lần đầu và sau khi từ chối | CI E2E | 0 request |
| Không PII trong payload | Test đơn vị quét payload mẫu bằng regex email/điện thoại; danh sách trường cấm | CI | 0 vi phạm |
| Tương thích ngược schema | Test validate payload phiên bản cũ với schema mới | CI | 0 lỗi |
| Retention cấu hình | IaC/ảnh chụp cấu hình công cụ, kiểm trong GO/NO-GO | Cổng G7 | Có bằng chứng |

## Nguồn

- Quyền riêng tư trong thu thập dữ liệu: pháp luật Việt Nam (Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15, hiệu lực 01/01/2026; NĐ 356/2025/NĐ-CP) và GDPR — nhà ở [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md), [`../16-compliance-privacy/international-privacy.md`](../16-compliance-privacy/international-privacy.md); xác minh 2026-10-13 qua <https://vbpl.moj.gov.vn/TW/Lists/vbpq/Attachments/187276/ND.356.2025.doc>.
- JSON Schema 2020-12 (schema sự kiện): <https://json-schema.org/specification> — xác minh 2026-10-13.
- OpenTelemetry (đếm sự kiện phía server, semantic conventions): <https://opentelemetry.io/docs/specs/semconv/> — (chưa xác minh trực tiếp ngày 2026-10-13; dùng qua `research/2026-10-13-ai-agent-research.md`).
- Global Privacy Control — (chưa xác minh: chưa truy cập <https://globalprivacycontrol.org/> ngày 2026-10-13); dùng ở mức SHOULD.
- Khung cũ X-stored `quality-supplements.md` PHẦN 4 (bảng ứng viên analytics kèm quyền riêng tư), commit `1b80fe4`; `seeker19110/stored` mục 11 (tắt telemetry mặc định), mục 07 (eval/observability) — đọc 2026-10-13.
- License công cụ (Plausible AGPL-3.0, Umami MIT, PostHog MIT + EE) — theo trang repo chính chủ, **xác minh lại trước khi dùng** (chưa xác minh lại ngày 2026-10-13).
