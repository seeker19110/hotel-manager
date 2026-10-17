---
title: Integration & contract test: DB thật, API contract, Pact, testcontainers
kind: module
prefix: QA-INT
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-16
---

# Integration & contract test: DB thật, API contract, Pact, testcontainers

> Kiểm phần unit không bắt được: ghép nối với CSDL thật, hàng đợi, dịch vụ ngoài, và **hợp đồng** giữa producer/consumer.
> Thiết kế API ở [`../08-backend/api-design.md`](../08-backend/api-design.md); chuẩn OpenAPI/Problem Details ở
> [`../04-standards/api-and-web-standards.md`](../04-standards/api-and-web-standards.md).

## Nguyên tắc

- **Phụ thuộc thật trong container, không mock.** Postgres/Redis/Kafka chạy bằng testcontainers (hoặc `services:` của CI) đúng phiên bản production. SQLite thay Postgres không phải integration test.
- **Hợp đồng là file được kiểm hai chiều.** OpenAPI/Pact/schema sự kiện: provider chứng minh triển khai đúng spec; consumer chứng minh chỉ dùng thứ spec hứa.
- **Dịch vụ bên thứ ba: record/replay + contract tối thiểu.** Không gọi API thật ở PR; ghi lại cassette, kiểm schema phản hồi; gọi thật ở nightly có kiểm soát chi phí.
- **Mỗi test tự dựng và dọn dữ liệu của mình** — transaction rollback hoặc schema/database riêng theo worker để chạy song song.
- **Migration là một phần của integration test.** Test chạy trên DB đã apply toàn bộ migration từ đầu (xem [`../09-database/migrations.md`](../09-database/migrations.md)).

## Quyết định

| Nhu cầu | Mặc định | Thay thế + điều kiện | Không dùng |
|---|---|---|---|
| DB/queue/cache thật trong test | testcontainers (Node 12.2.0, Python 4.15.0, Go/Java có module riêng) | CI `services:` khi không có Docker-in-Docker; DB nhúng (embedded-postgres) khi sandbox agent cấm Docker | SQLite/in-memory thay Postgres |
| Hợp đồng HTTP nội bộ nhiều đội (consumer-driven) | Pact (`@pact-foundation/pact` 17.1.4, `pact-python` 3.4.1) + Pact Broker/PactFlow (**Broker OSS MIT; PactFlow thương mại**) | OpenAPI + provider test theo spec khi 1 đội sở hữu cả hai đầu | Pact cho API công khai nhiều consumer vô danh |
| API công khai theo spec | Provider test từ OpenAPI (Schemathesis 4.31.0, Dredd) + oasdiff chặn breaking | Pact bi-directional khi có PactFlow | — |
| Sự kiện/async | Schema registry (Avro/JSON Schema/Protobuf) + test tương thích schema | Pact message khi consumer-driven | Sự kiện không schema |
| Dịch vụ bên thứ ba (thanh toán, email, LLM) | Record/replay (VCR.py, Polly.js, MSW) + kiểm schema phản hồi | Sandbox của nhà cung cấp ở nightly | Gọi thật ở PR |
| gRPC | Test server in-process + `buf breaking` | — | — |

## Checklist

- [ ] `QA-INT-001` **MUST** Integration test chạy trên CSDL thật cùng engine và major version với production (container/service), không SQLite thay thế. → Kiểm: cấu hình testcontainers/`services:` ghi image `postgres:<major>` trùng `PROJECT.md`; test kết nối thật.
- [ ] `QA-INT-002` **MUST** DB test được dựng bằng chính chuỗi migration từ rỗng, không bằng dump schema. → Kiểm: bước setup gọi lệnh migrate (`prisma migrate deploy`/`alembic upgrade head`/`goose up`); không file `schema.sql` tải tay.
- [ ] `QA-INT-003` **MUST@L** Mỗi test cách ly dữ liệu (transaction rollback, schema theo worker, hoặc truncate) và chạy song song xanh. → Kiểm: `-n auto`/`workers > 1` xanh 3 lần liên tiếp.
- [ ] `QA-INT-004` **MUST@L** Mọi endpoint trong OpenAPI có ≥ 1 test gọi thật qua HTTP (không gọi handler trực tiếp) kiểm status, content-type và schema phản hồi. → Kiểm: script đối chiếu `paths` trong spec với test đã chạy (coverage theo operationId) = 100%.
- [ ] `QA-INT-005` **MUST@L** Phản hồi lỗi được test theo schema `Problem` (RFC 9457) ít nhất cho 400, 401/403, 404, 409, 422. → Kiểm: test parameterized 5 mã, assert `application/problem+json`. · Nguồn: [`../04-standards/api-and-web-standards.md`](../04-standards/api-and-web-standards.md) STD-API-003
- [ ] `QA-INT-006` **MUST** Test phân quyền ở tầng HTTP: cho mỗi endpoint có dữ liệu theo người dùng, test người dùng A không đọc/sửa được tài nguyên của B (BOLA) và vai trò thấp không gọi được thao tác admin (BFLA). → Kiểm: test tag `api1-bola`, `api5-bfla` phủ mọi operationId chạm dữ liệu cá nhân (script `check_authz_tests` theo catalog 23 §3.3). · Nguồn: OWASP API Security Top 10 2023 API1, API5
- [ ] `QA-INT-007` **MUST** Thay đổi phá vỡ hợp đồng bị chặn ở PR (oasdiff / Pact can-i-deploy / `buf breaking` / schema registry compatibility). → Kiểm: job CI tương ứng exit 0.
- [ ] `QA-INT-008` **MUST@L** Dịch vụ bên thứ ba không được gọi thật ở PR: record/replay hoặc mock ở biên HTTP, kèm test schema phản hồi theo tài liệu nhà cung cấp. → Kiểm: job PR không có secret của nhà cung cấp; cassette/fixture trong repo không chứa bí mật (gitleaks).
- [ ] `QA-INT-009` **MUST@L** Webhook nhận vào có test: chữ ký sai → 401, trùng `event_id` → idempotent, thứ tự đảo → đúng trạng thái. → Kiểm: 3 test đặt tên `webhook-signature`, `webhook-replay`, `webhook-out-of-order`. · Nguồn: [`../08-backend/integrations-and-webhooks.md`](../08-backend/integrations-and-webhooks.md)
- [ ] `QA-INT-010` **MUST@L** Hàng đợi/job nền có test: job lỗi được retry theo chính sách, vượt ngưỡng vào DLQ, job chạy lại không nhân đôi tác dụng. → Kiểm: test với broker thật (container), assert số lần chạy và DLQ. · Nguồn: [`../08-backend/background-jobs-and-queues.md`](../08-backend/background-jobs-and-queues.md)
- [ ] `QA-INT-011` **MUST@L** Pact (nếu dùng): consumer publish pact mỗi PR; provider verify mỗi PR; deploy chỉ khi `can-i-deploy` xanh. → Kiểm: job `pact-verify` + `can-i-deploy` required.
- [ ] `QA-INT-012` **MUST@L** Agent/MCP: test tích hợp với MCP server thật trong container, snapshot `tools/list` và kiểm schema input/output 2020-12. → Kiểm: test `mcp-tools-snapshot` + validator; xem [`../04-standards/ai-standards.md`](../04-standards/ai-standards.md) STD-AI-006.
- [ ] `QA-INT-013` **SHOULD** Thời gian integration suite ≤ 10 phút; container tái dùng giữa test (một container cho cả suite, dữ liệu cách ly). → Kiểm: log thời gian job; cấu hình `reuse`/fixture scope `session`.
- [ ] `QA-INT-014` **SHOULD** Test truy vấn: kế hoạch thực thi của truy vấn nóng không full-scan (`EXPLAIN`) trên dữ liệu seed đủ lớn. → Kiểm: test assert `EXPLAIN` không chứa `Seq Scan` trên bảng > N hàng; xem [`../09-database/indexing-and-query-performance.md`](../09-database/indexing-and-query-performance.md).
- [ ] `QA-INT-015` **SHOULD** Cấu hình/biến môi trường được validate khi khởi động và có test khởi động thiếu biến → fail nhanh. → Kiểm: test bỏ `DATABASE_URL` → tiến trình thoát mã ≠ 0 kèm thông báo rõ.
- [ ] `QA-INT-016` **SHOULD** Smoke test tích hợp sau deploy (health, DB, queue, 1 giao dịch đọc) chạy tự động. → Kiểm: `run_smoke.sh` tồn tại và được gọi trong pipeline deploy.
- [ ] `QA-INT-017` **SHOULD** Contract test cho sự kiện: schema sự kiện đăng ký trong registry, kiểm tương thích backward trước khi publish. → Kiểm: job `schema-compat` exit 0.
- [ ] `QA-INT-018` **MAY** Nightly gọi sandbox thật của nhà cung cấp (thanh toán, LLM) với ngân sách giới hạn, cập nhật cassette khi lệch.
- [ ] `QA-INT-019` **MAY** Blockchain: fork test trên mainnet snapshot (Foundry `--fork-url`) cho tích hợp với hợp đồng ngoài.
- [ ] `QA-INT-020` **SHOULD** Khi cài đặt một chuẩn có bộ test hoặc test vector chính thức (VietQR/EMVCo, XML hoá đơn điện tử, FHIR, ISO 20022, IDS của buildingSMART…), CI chạy bộ đó **ghim theo phiên bản/commit**; ca chưa đạt ghi trong `known-gaps.txt` kèm lý do, và file này **chỉ được giảm**. → Kiểm: CI đỏ khi có ca fail mới ngoài `known-gaps.txt` hoặc khi số dòng `known-gaps.txt` tăng so với nhánh chính. · Nguồn: `seeker19110/stored` 23 §4.4 (Dhcb-Tools: corpus IDS buildingSMART 334 ca ghim commit + `known-gaps.txt`; đọc 2026-10-16)

## Bẫy thường gặp

- **SQLite in-memory "cho nhanh".** Khác kiểu dữ liệu, khoá, JSON, transaction → production đỏ. Cách tránh: QA-INT-001.
- **Dump schema thay migration** → migration hỏng mà test vẫn xanh. Cách tránh: QA-INT-002.
- **Mock HTTP client thay vì mock ở biên mạng** → không kiểm serialization/headers thật. Cách tránh: MSW/VCR ở tầng HTTP.
- **Cassette chứa token thật** commit lên repo. Cách tránh: filter header trước ghi; gitleaks trên fixture.
- **Pact cho mọi thứ** → chi phí broker, provider verify chậm khi chỉ một đội sở hữu cả hai đầu. Cách tránh: bảng Quyết định.
- **Test authz chỉ ở unit** (gọi hàm `can()`), bỏ middleware/route. Cách tránh: QA-INT-006 qua HTTP thật.
- **Cổng authz-gate `continue-on-error`** khi đã có endpoint PII. Cách tránh: fitness function cho chính CI (`xt.py ci-check` + job `protection-guard`; xem Nguồn).
- **Container mới cho mỗi test** → suite 40 phút. Cách tránh: QA-INT-013 reuse + cách ly dữ liệu.
- **Cài chuẩn "theo đọc spec" rồi tuyên bố tuân thủ** mà không chạy bộ test/test vector chính thức → sai lệch chỉ lộ khi đối tác/cơ quan từ chối. Cách tránh: QA-INT-020 (ghim phiên bản + `known-gaps.txt` chỉ giảm).

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| testcontainers (Node 12.2.0 MIT, Python 4.15.0 Apache-2.0) | trong test; `TESTCONTAINERS_RYUK_DISABLED=false` | CI (runner có Docker) | 0 fail |
| Schemathesis 4.31.0 (MIT) | `schemathesis run openapi.yaml --url http://localhost:8080 --checks all --report junit` | CI PR (nhanh) + nightly (sâu) | 0 failure; 0 5xx |
| oasdiff (Apache-2.0; phiên bản **chưa xác minh**) | `oasdiff breaking base.yaml head.yaml --fail-on ERR` | CI PR | 0 breaking |
| Pact 17.1.4 / pact-python 3.4.1 (MIT) + Pact Broker | `pact-broker can-i-deploy --pacticipant <svc> --version $SHA --to-environment prod` | CI trước deploy | exit 0 |
| `buf` (Apache-2.0; phiên bản **chưa xác minh**) | `buf breaking --against '.git#branch=main'` | CI PR | 0 breaking |
| Script coverage theo operationId | `python3 scripts/check-api-test-coverage.py openapi.yaml junit.xml` (dự án tự viết) | CI | 100% |
| `check_authz_tests` (tự viết theo mẫu qlkh) | mọi operationId chạm PII có test authz | CI | 0 thiếu |
| Bộ test/vector chuẩn chính thức (ghim phiên bản) | job CI chạy bộ test của chuẩn, so với `known-gaps.txt` | CI PR | Ca fail mới ngoài known-gaps hoặc known-gaps tăng = đỏ |

## Nguồn

- Phiên bản công cụ (registry, xác minh 2026-10-13): npm `testcontainers` 12.2.0, `@pact-foundation/pact` 17.1.4; PyPI `testcontainers` 4.15.0 (2026-07-24), `pact-python` 3.4.1 (2026-09-17), `schemathesis` 4.31.0 (2026-10-12).
- Pact specification (v1–v4; v4 là RFC #71): <https://docs.pact.io/implementation_guides/pact_specification> — xác minh 2026-10-13 (trang cập nhật 2022)
- RFC 9457 Problem Details: <https://www.rfc-editor.org/rfc/rfc9457> — xác minh 2026-10-13
- OWASP API Security Top 10 2023: <https://api-security.owasp.org/> — xác minh 2026-10-13
- Catalog `seeker19110/stored` 23 §3.3 (`check_authz_tests.py`, `ci_guard.py`, `run_smoke.sh`), 07 (record/replay) — đọc 2026-10-13.
- Catalog `seeker19110/stored` 23 §4.4 (Dhcb-Tools: CI đối chiếu corpus chuẩn ghim commit — IDS buildingSMART 334 ca, BCF schema — với `known-gaps.txt`) — đọc 2026-10-16.
