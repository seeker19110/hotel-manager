---
title: Log bảo mật, audit trail, phát hiện, ứng phó
kind: module
prefix: SEC-LOG
applies_to: [all]
updated: 2026-10-14
---

# Log bảo mật, audit trail, phát hiện, ứng phó

> Sự kiện **bảo mật** nào phải ghi, ghi thế nào để không lộ PII/secret, audit trail append-only (chuỗi HMAC), lưu trữ, phát hiện và
> đường nối sang ứng phó sự cố. Log ứng dụng nói chung là nhà của [`../01-baseline/errors-and-logging.md`](../01-baseline/errors-and-logging.md);
> nền tảng thu thập/lưu/truy vấn thuộc [`../15-operations/observability.md`](../15-operations/observability.md); quy trình sự cố thuộc
> [`../15-operations/incident-response.md`](../15-operations/incident-response.md); nghĩa vụ lưu trữ theo luật thuộc [`../16-compliance-privacy/records-and-audit-readiness.md`](../16-compliance-privacy/records-and-audit-readiness.md).

## Nguyên tắc

- **Log là để trả lời "ai, làm gì, với cái gì, khi nào, từ đâu, kết quả"** cho mọi hành động nhạy cảm — không phải để in debug. Mỗi sự kiện
  bảo mật có đủ 6 trường đó + correlation id.
- **Không log thứ không được log**: mật khẩu, token/session id (chỉ hash), khoá, số thẻ, dữ liệu sức khoẻ, PII ngoài mức cần — theo OWASP Logging CS.
  Che ở *nguồn* (logger), không che ở kho.
- **Audit trail khác log vận hành**: append-only, không sửa/xoá, có chứng minh toàn vẹn (chuỗi HMAC/WORM), lưu dài hơn, truy cập hẹp hơn.
- **Thất bại ghi log bảo mật = sự kiện bảo mật** (A09:2025): logger lỗi → cảnh báo, không im lặng bỏ qua.
- **Phát hiện phải có hành động**: mỗi alert bảo mật trỏ runbook; alert không ai xử lý được thì tắt hoặc sửa, không để nhiễu.
- **Thời gian UTC, đồng bộ NTP, timestamp ở nguồn** — để tái dựng dòng thời gian post-mortem và chứng cứ pháp lý.

## Quyết định

| Nhu cầu | Mặc định | Thay thế + điều kiện |
|---|---|---|
| Định dạng | JSON có cấu trúc theo OTel Logs Data Model (`Timestamp`, `SeverityNumber`, `Body`, `Attributes`, `TraceId/SpanId`, `Resource`) | Định dạng riêng chỉ khi hệ cũ; vẫn phải có trường `event`, `actor`, `target`, `outcome`, `trace_id` |
| Audit trail | Bảng/stream append-only + mỗi bản ghi `prev_hash` + `hmac` (khoá trong KMS) + neo định kỳ (hash gốc ký, lưu nơi khác) | Object storage **WORM/Object Lock** hoặc dịch vụ audit của cloud khi có; CSDL thường với quyền `INSERT`-only cho app và không `UPDATE/DELETE` |
| Lưu trữ | Log bảo mật ≥ 12 tháng, 3 tháng truy vấn nhanh (ngưỡng phổ biến trong chuẩn ngành — xác minh theo luật áp dụng ở 16) | Ngắn hơn chỉ khi không có nghĩa vụ và có DPIA lý do; dài hơn theo luật ngành |
| Phát hiện | Rule đơn giản trên log có cấu trúc (brute force, quyền bị từ chối tăng, export lớn, admin ngoài giờ, egress bị chặn) + alert theo runbook | SIEM (Wazuh/OpenSearch Security Analytics, dịch vụ cloud) khi ≥ L hoặc ngành bị quản lý |
| Truy cập log | Theo vai, read-only, có ghi lại ai truy vấn log chứa PII | Vault/kho riêng cho audit trail với quyền tách khỏi đội ứng dụng |
| Hệ có AI agent | Audit ledger ghi mọi tool call + quyết định HITL, correlation theo run/phiên/người; nội dung prompt/completion **opt-in** và đã che | — (xem [`ai-security.md`](ai-security.md)) |

## Checklist

- [ ] `SEC-LOG-001` **MUST** Ghi sự kiện bảo mật tối thiểu: đăng nhập thành công/thất bại, đăng xuất, đổi mật khẩu/MFA, cấp/thu hồi token, từ chối quyền (403), đổi vai/quyền, hành động admin, truy cập/xuất dữ liệu nhạy cảm, upload, đổi cấu hình, lỗi validate đầu vào, lỗi deserialize, lỗi TLS/chứng chỉ backend. → Kiểm: bảng `docs/security/security-events.md` liệt kê sự kiện ↔ tên `event` trong code; test tích hợp mỗi sự kiện tạo 1 dòng log có cấu trúc. · Nguồn: OWASP Logging CS; ASVS 5.0 V16; Top 10:2025 A09
- [ ] `SEC-LOG-002` **MUST** Mỗi sự kiện bảo mật có: `timestamp` UTC ISO-8601, `event`, `actor` (user id/service id, không tên thật nếu không cần), `target` (loại + id), `outcome` (success/denied/error), `source_ip`, `user_agent`, `trace_id`/`request_id`. → Kiểm: schema log (JSON Schema) + test validate mẫu; linter log tự viết. · Nguồn: OWASP Logging CS (what to log); OTel Logs Data Model
- [ ] `SEC-LOG-003` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`BASE-ERR-007`](../01-baseline/errors-and-logging.md) (dữ liệu không được log) và [`SEC-SECRET-007`](secrets-management.md) (bí mật không vào log/trace/URL); prompt/completion thô theo `SEC-LOG-014`.
- [ ] `SEC-LOG-004` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`OPS-OBS-002`](../15-operations/observability.md) (`trace_id` W3C Trace Context) và [`BASE-ERR-005/006`](../01-baseline/errors-and-logging.md) (log JSON có cấu trúc, mức theo OTel).
- [ ] `SEC-LOG-005` **MUST@L** Lỗi ghi log bảo mật (logger sink chết, queue đầy, mất kết nối kho log) phát cảnh báo; ứng dụng không im lặng nuốt lỗi logger. → Kiểm: test tắt sink → metric `log_write_errors_total` tăng + alert; không `try: log() except: pass`. · Nguồn: Top 10:2025 A09; ASVS 5.0 V16
- [ ] `SEC-LOG-006` **MUST** Log bảo mật tập trung ngoài máy ứng dụng (không chỉ file local), đồng hồ đồng bộ NTP, timestamp sinh tại nguồn. → Kiểm: cấu hình shipper (OTel Collector/agent) → kho trung tâm; `timedatectl`/NTP trên host hoặc image; lệch < 1 s. · Nguồn: OWASP Logging CS; ASVS 5.0 V16
- [ ] `SEC-LOG-007` **MUST** Audit trail cho hành động nhạy cảm (admin, quyền, export, tiền, dữ liệu cá nhân, tool call của agent) là **append-only**: app chỉ `INSERT`, không `UPDATE/DELETE`; xoá theo retention qua job riêng có ghi nhận. → Kiểm: quyền CSDL của app user trên bảng audit = INSERT/SELECT; test `UPDATE` → bị từ chối. · Nguồn: ASVS 5.0 V16; OWASP Secrets Mgmt CS (log bất biến)
- [ ] `SEC-LOG-008` **MUST@L** Audit trail có chứng minh toàn vẹn: mỗi bản ghi chứa `prev_hash` và `hmac` (khoá trong KMS/vault, không ở app), neo hash định kỳ (hàng ngày) ký và lưu nơi khác; có lệnh verify chuỗi. → Kiểm: `scripts/audit-verify` (dự án tự viết) chạy tuần = OK; test sửa 1 bản ghi → verify fail. · Nguồn: catalog stored 12 §3g (audit ledger HMAC); khung cũ spec C6
- [ ] `SEC-LOG-009` **MUST@L** Lưu trữ: log bảo mật/audit giữ ≥ 12 tháng, ≥ 3 tháng truy vấn nhanh (hoặc theo luật ngành áp dụng — ghi ở 16); log vận hành có retention riêng ngắn hơn; chính sách retention viết trong IaC/cấu hình kho. → Kiểm: cấu hình retention của kho log; bảng retention trong `docs/security/`; mẫu log cũ 11 tháng truy vấn được. · Nguồn: ngưỡng 12/3 tháng là thông lệ chuẩn ngành (PCI DSS Req 10 — chưa xác minh số mục 2026-10-13); [`../16-compliance-privacy/records-and-audit-readiness.md`](../16-compliance-privacy/records-and-audit-readiness.md)
- [ ] `SEC-LOG-010` **MUST@L** Quy tắc phát hiện tối thiểu có alert + runbook: ≥ N đăng nhập thất bại/tài khoản/IP trong 10 phút; 403 tăng đột biến; export dữ liệu lớn; hành động admin ngoài giờ/từ IP mới; đăng nhập từ quốc gia mới; egress bị chặn tăng; gitleaks/scanner phát hiện; cert sắp hết hạn. → Kiểm: mỗi rule có test kích hoạt (sinh log giả → alert nổ) ghi ngày diễn tập; alert trỏ runbook. · Nguồn: OWASP Logging CS (monitoring); NIST SP 800-61r3 (detect)
- [ ] `SEC-LOG-011` **MUST@L** Truy cập log/audit theo vai, read-only; truy vấn log chứa PII được ghi lại (ai, khi nào, truy vấn gì). → Kiểm: IAM/role của kho log; audit log của chính kho log bật. · Nguồn: OWASP Logging CS (protect logs); Luật 91/2025/QH15 + NĐ 356/2025/NĐ-CP (xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md))
- [ ] `SEC-LOG-012` **MUST@L** Cảnh báo bảo mật nối với quy trình sự cố: SEV theo bảng của [`../15-operations/incident-response.md`](../15-operations/incident-response.md); lộ dữ liệu/secret/bị xâm nhập = SEV1; có người trực nhận alert bảo mật. → Kiểm: routing alert `security.*` → kênh on-call; diễn tập 1 alert → ticket incident tạo trong ≤ 15 phút. · Nguồn: NIST SP 800-61r3; P12
- [ ] `SEC-LOG-013` **MUST@L** Bảo toàn chứng cứ khi nghi xâm nhập: snapshot log/disk/bộ nhớ trước khi sửa, chuỗi lưu giữ (chain of custody) có người ký; không xoá log liên quan. → Kiểm: RUNBOOK mục "Bảo toàn chứng cứ" với lệnh snapshot; diễn tập hàng năm. · Nguồn: NIST SP 800-61r3; ISO/IEC 27035 (chưa xác minh)
- [ ] `SEC-LOG-014` **MUST@L** Hệ có AI agent: mọi tool call, tham số (đã che), kết quả tóm tắt, quyết định HITL, kill switch, circuit opened đi vào audit trail với `run_id`/`session_id`/`user_id`; prompt/completion đầy đủ chỉ ghi khi opt-in và đã che PII. → Kiểm: test 1 tool call → 1 bản ghi audit đủ trường; cấu hình OTel GenAI `content capture` = off mặc định. · Nguồn: OWASP MCP Top 10 MCP08; OTel GenAI semconv (content opt-in); [`ai-security.md`](ai-security.md)
- [ ] `SEC-LOG-015` **SHOULD** Sự kiện bảo mật dùng mức severity riêng/ nhãn `security=true` để lọc và route; không trộn vào `info` chung. → Kiểm: schema có trường `category: security`; query `category=security` trả đúng. · Nguồn: OWASP Logging CS
- [ ] `SEC-LOG-016` **SHOULD** Có dashboard bảo mật tối thiểu: đăng nhập thất bại, 403, hành động admin, export, alert đang mở, finding scanner theo thời gian. → Kiểm: dashboard tồn tại trong IaC/JSON commit; ảnh chụp trong GO/NO-GO. · Nguồn: P10
- [ ] `SEC-LOG-017` **SHOULD** Log ở client (mobile/desktop/browser) không chứa PII/token và không gửi về server mặc định; crash report có che. → Kiểm: cấu hình SDK crash (scrub) + test. · Nguồn: OWASP Logging CS; [`../07-frontend/client-security.md`](../07-frontend/client-security.md)
- [ ] `SEC-LOG-018` **SHOULD** Rà định kỳ (hàng quý) danh sách sự kiện bảo mật so với tính năng mới (route/tool mới có sự kiện chưa?) và so với threat model. → Kiểm: biên bản rà quý; script liệt kê route/tool thiếu `event`. · Nguồn: [`threat-modeling.md`](threat-modeling.md); P12
- [ ] `SEC-LOG-019` **MAY** Dùng SIEM/OSS (Wazuh, OpenSearch Security Analytics) với rule Sigma khi ≥ L; ingest log cloud (CloudTrail/Audit Logs) cùng log ứng dụng. → Kiểm: pipeline ingest + ≥ 5 rule Sigma bật. · Nguồn: Sigma rules (chưa xác minh phiên bản)
- [ ] `SEC-LOG-020` **MAY** Honeytoken/canary trong dữ liệu và log để phát hiện truy cập trái phép. → Kiểm: canary đã kích hoạt thử. · Nguồn: kinh nghiệm vận hành

## Bẫy thường gặp

1. **Log mọi thứ "để debug"** → PII/token tràn vào kho log, kho log thành mục tiêu lộ dữ liệu. Tránh: `BASE-ERR-007` + `SEC-SECRET-007` (bộ che tại logger); retention ngắn cho debug.
2. **Chỉ log lỗi, không log thành công** → không biết kẻ tấn công *đã* đăng nhập được bằng mật khẩu lộ. Tránh: ghi cả success cho auth/admin/export.
3. **Audit trail là bảng thường có `UPDATE`** → kẻ xâm nhập (hoặc bug) xoá dấu vết. Tránh: INSERT-only + HMAC chain (`SEC-LOG-007/008`).
4. **Khoá HMAC audit nằm trong env app** → chiếm app là giả được chuỗi. Khoá ở KMS, app chỉ gọi ký.
5. **Alert không có runbook** → mọi người tắt thông báo; sự cố thật bị bỏ qua. Tránh: `SEC-LOG-010` (mỗi alert ↔ runbook ↔ test kích hoạt).
6. **Đồng hồ lệch giữa máy** → dòng thời gian post-mortem không dựng được, chứng cứ vô giá trị. NTP + timestamp nguồn (`SEC-LOG-006`).
7. **Log chỉ ở file local trên container** → container bị xoá/bị chiếm là mất log. Ship ra ngoài ngay.
8. **Ghi prompt/completion đầy đủ mặc định** vào trace "để debug AI" → PII và secret vào hệ thống thứ ba. Tránh: opt-in + che (`SEC-LOG-014`).
9. **Retention = mãi mãi** → tốn tiền và vi phạm tối thiểu hoá dữ liệu; **retention = 7 ngày** → không điều tra được sự cố phát hiện muộn. Tránh: bảng retention có lý do (`SEC-LOG-009`).
10. **Xoá log để "dọn" ngay sau sự cố** → mất chứng cứ, không post-mortem được. Tránh: `SEC-LOG-013`.

## Cổng tự động

| Việc | Công cụ (license) | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Schema log | JSON Schema + test | validate mẫu log mỗi sự kiện trong `security-events.md` | job test | thiếu trường = đỏ |
| Redact | unit test logger; gitleaks trên artifact log | `gitleaks detect --no-git -s logs/` | job test + CI | lộ = đỏ |
| Sự kiện ↔ route/tool | script tự viết | liệt kê route/tool nhạy cảm không gọi `audit.log(...)` | CI | thiếu = đỏ |
| Append-only | test quyền CSDL | `UPDATE audit_log` bằng user app → lỗi | job test | thành công = đỏ |
| Chuỗi HMAC | `scripts/audit-verify` (dự án tự viết) | verify từ neo gần nhất | lịch tuần | fail = SEV2 |
| Alert có runbook + test | script đọc cấu hình alert | mỗi `security.*` có `runbook_url`; file `alert-drills.md` ghi ngày | CI + quý | thiếu = đỏ |
| Retention | đọc cấu hình kho (IaC) | so với bảng retention | CI IaC | lệch = đỏ |
| NTP | kiểm host/image | `timedatectl show -p NTPSynchronized` | job lịch | no = cảnh báo |
| OTel content capture | kiểm cấu hình SDK | `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (tên biến theo semconv — xác minh) = false mặc định | CI | bật ở prod không có DPIA = đỏ |

## Nguồn

- OWASP Logging Cheat Sheet (sự kiện cần log; dữ liệu không được log; bảo vệ log): <https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html> — xác minh 2026-10-13.
- OWASP Top 10:2025 A09 Security Logging and Alerting Failures: <https://top10.owasp.org/2025> — xác minh 2026-10-13.
- OWASP ASVS 5.0.0 V16 Security Logging and Error Handling: <https://github.com/OWASP/ASVS/tree/master/5.0/en> — xác minh 2026-10-13.
- OpenTelemetry Logs Data Model (Stable; Timestamp/TraceId/SpanId/SeverityNumber/Body/Attributes/Resource): <https://opentelemetry.io/docs/specs/otel/logs/data-model/> — xác minh 2026-10-13.
- W3C Trace Context Level 1 (Recommendation 2021-11-23; `traceparent`, `tracestate`): <https://www.w3.org/TR/trace-context/> — xác minh 2026-10-13.
- NIST SP 800-61 Rev. 3 Incident Response Recommendations (CSF 2.0 Community Profile, 04/2025): <https://csrc.nist.gov/pubs/sp/800/61/r3/final> — xác minh 2026-10-13.
- OWASP MCP Top 10 MCP08 Lack of Audit and Telemetry: <https://github.com/OWASP/www-project-mcp-top-10> — xác minh 2026-10-13.
- OTel GenAI semantic conventions (trạng thái Development; prompt/completion opt-in): theo `research/2026-10-13-ai-agent-research.md` §4.3 [F/S].
- (chưa xác minh 2026-10-13) PCI DSS v4 Requirement 10 (12 tháng/3 tháng), ISO/IEC 27035, Sigma rules, tên biến OTel capture content — xác minh trước khi dẫn.
- Catalog `seeker19110/stored` 12 §3g (audit ledger HMAC), đọc 2026-10-13; khung cũ spec §A4.6 C6 Governance, commit `1b80fe4`.
