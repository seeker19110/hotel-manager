---
title: Xử lý lỗi và ghi log có cấu trúc
kind: baseline
prefix: BASE-ERR
applies_to: [all]
updated: 2026-10-14
---

# Xử lý lỗi và ghi log có cấu trúc

> **Nhà của log ứng dụng** trong khung: mọi thao tác có thể thất bại đều có nhánh lỗi, lỗi không lộ nội bộ ra ngoài,
> log là JSON có cấu trúc ra stdout với mức, thời gian UTC, mã tương quan và không chứa bí mật. Nền tảng quan sát
> (collector, metric, trace, dashboard) là nhà của [`../15-operations/observability.md`](../15-operations/observability.md);
> log **sự kiện bảo mật** và audit trail ở [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md);
> định dạng lỗi HTTP API ở [`../08-backend/api-design.md`](../08-backend/api-design.md).

## Nguyên tắc

- **Mọi thao tác có thể thất bại** (mạng, I/O, CSDL, parse, tiến trình con, tool/LLM) **có nhánh lỗi** được quyết định
  tường minh: xử lý, chuyển tiếp có ngữ cảnh, hoặc dừng — không nuốt.
- **Lỗi cho người dùng ≠ lỗi cho người vận hành**: người dùng nhận thông điệp hành động được + mã tham chiếu; chi tiết
  (stack, truy vấn, đường dẫn) chỉ ở log.
- **Log là luồng sự kiện** (12-factor XI): ghi stdout, mỗi dòng một JSON; nơi lưu/định tuyến là việc của môi trường.
- **Bốn câu hỏi cho mỗi bản ghi**: khi nào (timestamp UTC), ở đâu (service, phiên bản, vị trí), ai (actor, request id),
  cái gì (event, severity, kết quả).
- **Log không phải nơi chứa bí mật**: mask tại nguồn; log injection là tấn công thật — encode trước khi ghi.

## Quyết định

| Câu hỏi | Chọn | Khi nào không dùng |
|---|---|---|
| Ngoại lệ hay giá trị lỗi? | Theo idiom ngôn ngữ: exception (Python/JS/Java/C#), `error` trả về (Go), `Result<T,E>` (Rust). Không trộn hai kiểu trong một codebase. | Thư viện công khai: ghi rõ hợp đồng lỗi trong API docs. |
| Lỗi "mong đợi" vs "bất ngờ" | Mong đợi (validate sai, không tìm thấy, hết hạn) → kiểu lỗi có tên, mã ổn định, mức `WARN`/`INFO`; bất ngờ (bug, hạ tầng) → handler toàn cục, mức `ERROR`, có stack. | — |
| Mức log | Theo thang OTel: `TRACE`(1–4) `DEBUG`(5–8) `INFO`(9–12) `WARN`(13–16) `ERROR`(17–20) `FATAL`(21–24); `ERROR` chỉ khi có việc cần người/alert xử lý. | Không thêm mức tự chế (`NOTICE`, `VERBOSE`) nếu backend không map được. |
| Thư viện log | JS/TS: pino 10.x · Python: structlog 26.x (hoặc `logging` + JSON formatter) · Go: `log/slog` · Java: SLF4J + Logback JSON encoder · .NET: `Microsoft.Extensions.Logging` + Serilog JSON. | `console.log`/`print` trong mã sản phẩm: chỉ cho CLI xuất kết quả (stdout) — còn thông báo/lỗi ra stderr. |
| Định dạng lỗi API | RFC 9457 `application/problem+json` (`type`, `title`, `status`, `detail`, `instance`) + `trace_id`. Chi tiết ở [`../08-backend/api-design.md`](../08-backend/api-design.md). | gRPC: status code chuẩn + `google.rpc.Status`. |
| Retry ở đâu? | Chỉ retry lỗi **tạm thời** (timeout, 429, 503, kết nối) với backoff + jitter và trần số lần; thao tác retry phải **idempotent**. | Lỗi 4xx (trừ 408/429) hay lỗi logic: không retry. `outcome_unknown` (timeout sau khi gửi) → reconcile, không retry mù. |

## Checklist

- [ ] `BASE-ERR-001` **MUST** Không có lỗi bị nuốt: không `catch {}` rỗng, không `except: pass`, không `_ = err`, không `.catch(() => {})`; mỗi nhánh bắt lỗi hoặc xử lý, hoặc chuyển tiếp có ngữ cảnh, hoặc ghi log mức phù hợp. → Kiểm: lint (`no-empty`, ruff `S110`/`BLE001`, `errcheck`, `clippy::let_underscore_must_use`) 0 vi phạm; grep `except:\s*pass|catch\s*\(\w*\)\s*\{\s*\}` rỗng. · Nguồn: OWASP Error Handling CS
- [ ] `BASE-ERR-002` **MUST** Có **handler lỗi toàn cục** (middleware/exception handler/`process.on('unhandledRejection')`/`sys.excepthook`/`recover` ở biên goroutine) ghi log đầy đủ và trả phản hồi chung; tiến trình không chết im lặng. → Kiểm: server: test gây exception chưa bắt → log `ERROR` kèm stack, phản hồi 500/RFC 9457 kèm `trace_id`, không stack trong phản hồi, handler tiếp tục; CLI/thư viện: test lỗi → exit ≠ 0 + một dòng stderr dễ hiểu, stack chỉ khi bật `--debug`/biến debug. · Nguồn: OWASP Error Handling CS; ASVS 5.0 V16
- [ ] `BASE-ERR-003` **MUST** Phản hồi lỗi cho người dùng **không chứa** stack trace, đường dẫn, phiên bản framework, câu SQL, tên bảng, địa chỉ nội bộ; có **mã tham chiếu** (request/trace id) để tra log. → Kiểm: server: test 500 và 4xx → body RFC 9457 kèm `trace_id`, không khớp regex `(Traceback|at .*\.(js|py|java)|SELECT |/home/|/var/)`; CLI/thư viện: test lỗi → exit ≠ 0 + một dòng stderr dễ hiểu (không khớp regex trên), stack chỉ khi bật `--debug`/biến debug. · Nguồn: OWASP Error Handling CS; ASVS 5.0 V16; CWE-209
- [ ] `BASE-ERR-004` **MUST** Mọi lời gọi ra ngoài (HTTP, CSDL, queue, tiến trình con, tool) có **timeout tường minh**; không có lời gọi mạng không timeout. → Kiểm: grep client/driver cấu hình `timeout`; test với server treo → lỗi timeout trong giới hạn. · Nguồn: [`../08-backend/reliability-and-errors.md`](../08-backend/reliability-and-errors.md)
- [ ] `BASE-ERR-005` **MUST@M** Dịch vụ chạy dài/server: log ở dạng **có cấu trúc** (một JSON/dòng) ra **stdout**, không tự ghi/xoay file, không gửi thẳng tới dịch vụ bên ngoài từ mã ứng dụng. CLI: theo [`PRF-CLI-003`](../02-profiles/cli-tool.md) (stdout dữ liệu, stderr thông báo). → Kiểm: chạy app, `head -1 | jq .` parse được; không có `FileHandler`/`fs.appendFile` cho log trong mã sản phẩm. · Nguồn: 12-factor XI
- [ ] `BASE-ERR-006` **MUST@M** Dịch vụ chạy dài/server: mỗi bản ghi có tối thiểu: `timestamp` RFC 3339 UTC (`Z`, độ phân giải ≥ ms), `level` (tên + số theo OTel), `message`, `service`, `version`, `env`; với request: `request_id`/`trace_id`, `span_id`. CLI: theo [`PRF-CLI-003`](../02-profiles/cli-tool.md) (stdout dữ liệu, stderr thông báo). → Kiểm: test schema log (JSON Schema) trên mẫu log từ test tích hợp; 100 % bản ghi hợp lệ. · Nguồn: OTel Logs Data Model; OWASP Logging CS (when/where/who/what)
- [ ] `BASE-ERR-007` **MUST** Không ghi vào log: mật khẩu, token/session id, API key, khoá mã hoá, chuỗi kết nối, số thẻ, dữ liệu sức khoẻ/giấy tờ định danh; PII thường (email, tên) chỉ khi cần và đã pseudonymize. → Kiểm: redaction cấu hình tại logger (pino `redact`, structlog processor) cho các khoá `password|token|authorization|cookie|secret|key`; test ghi object có `password` → log hiện `[REDACTED]`; gitleaks quét mẫu log CI. · Nguồn: OWASP Logging CS (data to exclude); ASVS 5.0 V16
- [ ] `BASE-ERR-008` **MUST** Dữ liệu từ bên ngoài đưa vào log được **encode/escape** (loại CR/LF, ký tự điều khiển) để chống log injection; log không bao giờ được render như HTML. → Kiểm: test ghi chuỗi chứa `\n[ERROR] fake` → một bản ghi JSON duy nhất, chuỗi nằm trong trường, không tạo dòng mới. · Nguồn: OWASP Logging CS (log injection); CWE-117
- [ ] `BASE-ERR-009` **MUST** Ngoại lệ ghi log kèm `exception.type`, `exception.message`, `exception.stacktrace` (tên trường theo OTel) và **chuỗi nguyên nhân** (`cause`/`__cause__`/`%w`) không bị cắt. → Kiểm: test ném lỗi bọc lỗi → log có đủ ba trường và nguyên nhân gốc. · Nguồn: OTel semconv exceptions (Stable)
- [ ] `BASE-ERR-010` **MUST** Lỗi ở **cổng bảo mật** (auth, authz, validate, chữ ký) → **thất bại đóng**: từ chối, không fallback cho qua; lỗi phụ thuộc không quan trọng → degrade có kiểm soát và ghi log. → Kiểm: test giả lỗi backend auth → 401/403, không 200; danh sách điểm fail-open (nếu có) ghi trong THREAT-MODEL kèm lý do. · Nguồn: P7 (principles.md)
- [ ] `BASE-ERR-011` **MUST@M** Lỗi mức `ERROR`/`FATAL` được **thu thập và cảnh báo** (Sentry/GlitchTip/OTel collector → alert) trong vòng phút; không "mù" trên production. → Kiểm: tạo lỗi thử trên staging → alert đến kênh trực; chi tiết ở [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md). · Nguồn: P10
- [ ] `BASE-ERR-012` **SHOULD** Lỗi nghiệp vụ có **mã ổn định** (enum/`type` URI) và thông điệp người dùng có thể dịch; mã không đổi khi đổi câu chữ. → Kiểm: bảng mã lỗi trong tài liệu/`errors.ts`/`errors.py`; test snapshot mã lỗi. · Nguồn: RFC 9457 §3.1
- [ ] `BASE-ERR-013` **SHOULD** Retry theo nguyên tắc của [`ARC-RES-002`](../05-architecture/resilience-and-scalability.md) (chỉ lỗi tạm, chỉ thao tác idempotent, backoff mũ + jitter, trần số lần) áp cho **mọi loại phần mềm**, kể cả client mobile/desktop, CLI, SDK nằm ngoài phạm vi module đó; số mặc định phía dịch vụ ở `BE-REL-003`, job ở `BE-JOB-003`. → Kiểm: test: lỗi 400 không retry; lỗi 503 retry ≤ N lần rồi bỏ cuộc với lỗi tổng hợp. · Nguồn: [`ARC-RES-002`](../05-architecture/resilience-and-scalability.md); catalog 21 §8 (outbox, `outcome_unknown`)
- [ ] `BASE-ERR-014` **SHOULD** CLI/batch: exit code 0 = thành công, ≠ 0 = thất bại, mã khác nhau cho lớp lỗi chính; thông điệp lỗi gợi ý cách sửa; kết quả ra stdout, chẩn đoán ra stderr. → Kiểm: test chạy lệnh với input sai → exit ≠ 0, stderr có gợi ý, stdout rỗng. · Nguồn: clig.dev (Errors, Output)
- [ ] `BASE-ERR-015` **SHOULD** Mức log cấu hình được qua biến môi trường (`LOG_LEVEL`) mà không build lại; mặc định prod `INFO`, dev `DEBUG`; `DEBUG` không bao giờ bật ở prod kèm payload đầy đủ. → Kiểm: khởi động với `LOG_LEVEL=debug` thấy bản ghi DEBUG; cấu hình prod ghi `INFO`. · Nguồn: 12-factor III
- [ ] `BASE-ERR-016` **SHOULD** Log có **ngân sách**: không log trong vòng lặp nóng ở mức ≥ INFO, không log payload > 1 KB mặc định, có sampling cho sự kiện lặp; disk/chi phí không bị cạn vì log. → Kiểm: test tải → tốc độ log < ngưỡng (vd 100 dòng/s/instance) ghi trong RUNBOOK. · Nguồn: OWASP Logging CS (resource exhaustion)
- [ ] `BASE-ERR-017` **SHOULD** Thời gian trong log và trong hệ thống là **UTC**; đồng hồ máy chủ đồng bộ NTP; thời gian hiển thị cho người mới đổi múi giờ. → Kiểm: mẫu log có hậu tố `Z`; chi tiết ở [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md). · Nguồn: RFC 3339
- [ ] `BASE-ERR-018` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`OPS-OBS-002`](../15-operations/observability.md): `trace_id` W3C Trace Context lan truyền qua HTTP/queue/job/tool call (MCP `_meta.traceparent`).
- [ ] `BASE-ERR-019` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`SEC-LOG-015`](../12-security/logging-audit-and-incident.md): sự kiện bảo mật gắn nhãn `security` để định tuyến và giữ lâu hơn.

## Bẫy thường gặp

- **`catch (e) { console.log(e) }` rồi tiếp tục như không có gì.** Lỗi được "xử lý" nhưng trạng thái sai lan tiếp. Quy tắc: bắt lỗi thì phải quyết định hậu quả.
- **Stack trace trong body 500 ở prod** vì `DEBUG=True`/developer exception page. Cấu hình prod tắt; test tự động kiểm.
- **Log chuỗi nối** `"user " + name + " failed"` — không query được, dễ injection. Dùng trường có tên.
- **Timestamp giờ địa phương không offset** → không ghép được log giữa máy chủ ở hai múi giờ. UTC + `Z`.
- **`ERROR` cho mọi thứ** (cả 404, validate sai) → alert nhiễu, người tắt alert. `ERROR` = cần người.
- **Retry lỗi 4xx hay retry thao tác không idempotent** → tính tiền hai lần, gửi mail hai lần. Idempotency key trước, retry sau.
- **Nuốt timeout thành "thành công"**: 504 có thể đã chạy (catalog 12 §3b: "504 = có thể đã chạy, đừng gửi lại"). Reconcile bằng đọc lại trạng thái.
- **Log token để debug rồi quên gỡ.** Redaction ở logger, không ở ý chí.
- **Thư viện tự in ra stdout** làm hỏng output JSON của CLI. Chẩn đoán ra stderr; kiểm bằng test pipe.

## Cổng tự động

| Việc kiểm | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Lỗi bị nuốt | ESLint/Biome `no-empty`, `no-floating-promises`; ruff `S110`, `BLE001`, `E722`; `errcheck`/`staticcheck`; `clippy` | theo lệnh `lint` chuẩn | hook + CI | 0 |
| Schema log | JSON Schema + test tích hợp (ajv / `jsonschema`) | `test` (fixture log) | CI | 100 % bản ghi hợp lệ |
| Bí mật trong log | gitleaks v8.30.1 (MIT) trên artefact log của CI; test redaction | `gitleaks detect --source=ci-logs/ --no-git` | CI | 0 |
| Lộ nội bộ trong phản hồi | test tích hợp regex trên body lỗi | `test` | CI | 0 khớp |
| Timeout thiếu | Semgrep OSS rule tự viết (`requests.get` không `timeout=`, `fetch` không `AbortSignal`) | `semgrep --config .semgrep/` | CI | 0 |
| Log injection | test gửi `\r\n` qua input | `test` | CI | 1 bản ghi/sự kiện |
| Alert lỗi prod | Sentry (FSL-1.1-Apache-2.0, SDK MIT) hoặc GlitchTip (MIT) + OTel Collector (Apache-2.0) | kích lỗi thử staging | sau deploy | alert ≤ 5 phút |

Lưu ý license: Sentry server là FSL (không OSI, chuyển Apache-2.0 sau 2 năm), SDK MIT; GlitchTip MIT tương thích SDK Sentry; OpenTelemetry Collector Apache-2.0.

## Nguồn

- OWASP Cheat Sheet Series — Logging: <https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html> — xác minh 2026-10-13
- OWASP Cheat Sheet Series — Error Handling: <https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html> — xác minh 2026-10-13
- OWASP ASVS 5.0.0 V16 Security Logging and Error Handling: <https://github.com/OWASP/ASVS/tree/master/5.0/en> — xác minh 2026-10-13
- OpenTelemetry Logs Data Model (Stable; SeverityNumber 1–24): <https://opentelemetry.io/docs/specs/otel/logs/data-model/> — xác minh 2026-10-13
- OpenTelemetry Semantic Conventions 1.44.0 — logs (Development) và exceptions (Stable): <https://opentelemetry.io/docs/specs/semconv/general/logs/>, <https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-logs/> — xác minh 2026-10-13
- RFC 9457 Problem Details for HTTP APIs (2023, obsoletes RFC 7807): <https://www.rfc-editor.org/rfc/rfc9457> — xác minh 2026-10-13
- RFC 3339 Date and Time on the Internet: Timestamps: <https://www.rfc-editor.org/rfc/rfc3339> — xác minh 2026-10-13
- The Twelve-Factor App XI Logs, III Config: <https://12factor.net/logs> — xác minh 2026-10-13
- Command Line Interface Guidelines (errors, exit codes, stdout/stderr): <https://clig.dev/> — xác minh 2026-10-13
- Phiên bản thư viện (xác minh 2026-10-13 qua registry): pino 10.4.0 (MIT), winston 3.19.0 (MIT), structlog 26.1.0.
- Khung cũ X-stored `quality-supplements.md` N2 §7 (Sentry: `beforeSend`, tách env), commit `1b80fe4`; catalog `seeker19110/stored` 12 §3b (504 = có thể đã chạy), 21 §8 (outbox, outcome_unknown), đọc 2026-10-13.
