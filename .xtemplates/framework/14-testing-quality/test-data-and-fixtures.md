---
title: Dữ liệu test, fixture, seed, ẩn danh hoá, factory
kind: module
prefix: QA-DATA
applies_to: [all]
updated: 2026-10-14
---

# Dữ liệu test, fixture, seed, ẩn danh hoá, factory

> Cách tạo, quản lý và bảo vệ dữ liệu dùng trong test và môi trường thử: factory thay fixture tĩnh, seed tất định,
> **không bao giờ** dùng dump production, và cách kiểm máy rằng fixture không chứa dữ liệu cá nhân thật.
> Kiểm soát dữ liệu nhạy cảm trong CSDL ở [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md).

## Nguyên tắc

- **Dữ liệu tối thiểu cho ca test, tạo bằng factory.** Fixture tĩnh khổng lồ làm test khó đọc và gãy dây chuyền khi schema đổi.
- **Tất định:** faker có seed, thời gian giả lập, ID có thể đoán trong test; chạy lần nào cũng ra một kết quả.
- **Không dữ liệu thật ngoài production.** Dump production vào staging/dev/test là vi phạm pháp lý (Luật 91/2025, GDPR) và là rủi ro rò rỉ; cần dữ liệu giống thật → sinh tổng hợp hoặc ẩn danh hoá **không đảo ngược** theo quy trình được duyệt.
- **Fixture là code:** review, lint, quét bí mật/PII như code.
- **Seed cho dev/staging là script có phiên bản**, chạy được từ DB rỗng sau migration, idempotent.

## Quyết định

| Nhu cầu | Mặc định | Thay thế + điều kiện | Không dùng |
|---|---|---|---|
| Dữ liệu cho unit/integration | Factory có default hợp lệ + override theo ca (`fishery`/`@faker-js/faker` JS; `factory_boy` + `Faker` Python; Go functional options; Java `Instancio`/builder) — phiên bản **chưa xác minh** | Fixture JSON nhỏ cho golden/contract | Dump DB |
| Dữ liệu cho E2E | Tạo qua API/seed script per test, dọn sau | Snapshot DB khôi phục mỗi suite khi tạo qua API quá chậm | Tài khoản dùng chung |
| Seed dev/staging | Script `seed` idempotent, dữ liệu tổng hợp có seed cố định | Bản sao ẩn danh hoá khi cần phân phối thống kê thật (M+, có DPIA/duyệt) | Dump thô |
| Dữ liệu lớn cho perf | Sinh bằng script theo tỷ lệ production (số hàng, phân phối) | Ẩn danh hoá | — |
| Phản hồi dịch vụ ngoài | Record/replay cassette đã lọc header/secret | Mock schema-driven (MSW/Prism từ OpenAPI) | Cassette chứa token |
| Dữ liệu cho eval LLM | Golden dataset có holdout, phiên bản, nhãn nguồn; negative control | — | Chấm trên dữ liệu đã dùng để tinh chỉnh prompt |

## Checklist

- [ ] `QA-DATA-001` **MUST** Không có dump/export dữ liệu production trong repo, CI, staging hay máy dev; chính sách ghi trong `PROJECT.md`. → Kiểm: gitleaks + script quét file `.sql/.csv/.json` > 1 MB hoặc có cột PII; `PROJECT.md` mục "Dữ liệu test" có câu cấm. · Nguồn: Luật 91/2025/QH15; GDPR Art. 5(1)(c)
- [ ] `QA-DATA-002` **MUST** Fixture/seed không chứa dữ liệu cá nhân thật (tên, email, SĐT, CCCD, địa chỉ); email test dùng domain dành riêng (`example.com`/`example.test`) hoặc `+tag`. → Kiểm: CI quét fixture bằng regex/Presidio: 0 email ngoài domain cho phép, 0 SĐT VN dạng thật trừ số mẫu ghi trong `docs/compliance/test-data-policy.md`.
- [ ] `QA-DATA-003` **MUST@L** Faker/random có seed cố định trong test; cùng seed → cùng dữ liệu. → Kiểm: `faker.seed(…)`/`Faker.seed(…)` ở setup; test chạy 2 lần ra cùng snapshot dữ liệu.
- [ ] `QA-DATA-004` **MUST@L** Mỗi bảng/aggregate chính có factory với default hợp lệ (qua validate/schema) và override theo trường. → Kiểm: thư mục `tests/factories/` có file cho mỗi aggregate trong `PROJECT.md`; test tạo factory mặc định pass validation.
- [ ] `QA-DATA-005` **MUST@L** Seed chạy được từ DB rỗng sau migration, idempotent (chạy 2 lần không nhân đôi). → Kiểm: CI job `migrate && seed && seed` rồi đếm bản ghi = lần 1.
- [ ] `QA-DATA-006` **MUST@L** Test tự dọn dữ liệu mình tạo (transaction rollback, truncate theo worker, hoặc xoá theo tag `e2e-<run-id>`). → Kiểm: sau suite, truy vấn đếm bản ghi có tag run = 0.
- [ ] `QA-DATA-007` **MUST@M** Bản sao ẩn danh hoá (nếu dùng) được tạo bằng script có phiên bản, kỹ thuật không đảo ngược (xoá/băm có muối/tổng quát hoá), có DPIA hoặc phê duyệt ghi trong repo; không giữ bảng ánh xạ. → Kiểm: `scripts/anonymize/` + `docs/compliance/anonymization.md` có `approved_by`; test mẫu: không tìm được bản ghi gốc từ bản sao. · Nguồn: [`../04-standards/data-privacy-standards.md`](../04-standards/data-privacy-standards.md) STD-PRIV-003
- [ ] `QA-DATA-008` **MUST@M** Cassette record/replay được lọc header `Authorization`/`Cookie`/`Set-Cookie`, API key và PII trước khi ghi. → Kiểm: cấu hình filter (`filter_headers`, `before_record`) + gitleaks trên thư mục cassette = 0.
- [ ] `QA-DATA-009` **MUST@L** Dữ liệu test có ca tiếng Việt (dấu NFC/NFD, tên 4–5 từ, địa chỉ có số/`/`), Unicode và chuỗi dài để bắt lỗi encode/so sánh/cắt. → Kiểm: factory `person` có ≥ 1 giá trị tiếng Việt có dấu; test tìm kiếm với NFD xanh.
- [ ] `QA-DATA-010` **MUST@L** Dữ liệu thời gian trong test là UTC cố định bằng clock giả; fixture không chứa `now()`. → Kiểm: grep `new Date()`/`datetime.now()` trong `tests/` = 0 ngoài helper clock.
- [ ] `QA-DATA-011` **SHOULD** Fixture lớn (> 200 dòng) thay bằng factory hoặc builder; fixture JSON chỉ cho golden/contract. → Kiểm: lint kích thước file `tests/fixtures/*.json` ≤ ngưỡng ghi trong repo.
- [ ] `QA-DATA-012` **SHOULD** Dữ liệu perf sinh theo tỷ lệ production (số hàng, phân phối giá trị, tỷ lệ null) ghi trong `PROJECT.md`. → Kiểm: script `seed --profile perf` có tham số số hàng; load test dùng profile này.
- [ ] `QA-DATA-013` **SHOULD** Golden dataset cho eval LLM có phiên bản, nguồn nhãn, tập holdout không dùng khi tinh chỉnh prompt; negative control. → Kiểm: `evals/dataset.jsonl` + `evals/README` ghi `version`, `holdout`; xem [`../13-ai-engineering/evaluation.md`](../13-ai-engineering/evaluation.md).
- [ ] `QA-DATA-014` **SHOULD** Dữ liệu seed cho staging đủ để chạy toàn bộ luồng chính (tài khoản mỗi vai trò, 1 bản ghi mỗi trạng thái nghiệp vụ). → Kiểm: `docs/ops/seed-catalog.md` liệt kê tài khoản/trạng thái; E2E `@smoke` chạy trên seed này.
- [ ] `QA-DATA-015` **SHOULD** Schema đổi → factory/seed cập nhật cùng PR migration (CI đỏ nếu factory không validate). → Kiểm: job chạy `seed` sau mọi PR có migration.
- [ ] `QA-DATA-016` **MAY** Sinh dữ liệu tổng hợp giữ tương quan thống kê (SDV hoặc tương đương) cho data/ML.
- [ ] `QA-DATA-017` **MAY** Snapshot DB (pg_dump của DB seed, không phải production) để khôi phục nhanh trước mỗi suite E2E.

## Bẫy thường gặp

- **"Chỉ copy vài bảng production sang staging"** → vẫn là dữ liệu cá nhân thật, vi phạm và rò rỉ qua log/screenshot. Cách tránh: QA-DATA-001/007.
- **Fixture dùng chung cho mọi test** → một test sửa fixture, mười test gãy. Cách tránh: factory + dữ liệu tối thiểu theo ca.
- **Faker không seed** → test flaky khi trúng giá trị biên (tên rỗng, email trùng). Cách tránh: QA-DATA-003.
- **Email test `@gmail.com` thật** → gửi mail nhầm cho người thật. Cách tránh: domain `example.com`; mail sandbox.
- **Cassette chứa token** rồi commit. Cách tránh: QA-DATA-008; gitleaks fixture.
- **Seed chỉ chạy được một lần** (unique conflict lần 2). Cách tránh: upsert theo khoá tự nhiên.
- **Dữ liệu test toàn ASCII** → lỗi tiếng Việt chỉ lộ ở production. Cách tránh: QA-DATA-009.
- **Eval chấm trên dữ liệu đã nhìn khi tinh chỉnh** → điểm ảo. Cách tránh: holdout (QA-DATA-013).

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| gitleaks (MIT) | `gitleaks detect --source tests/ --no-git` + `--log-opts=--all` tuần | CI + weekly | 0 finding |
| Microsoft Presidio (MIT) / regex PII | `python3 scripts/scan-fixtures-pii.py tests/ evals/` | CI | 0 PII thật (danh sách mẫu cho phép ghi trong policy) |
| Script seed idempotent | lệnh khoá `migrate` trong `xt.yaml` (lệnh khai báo, agent/CI chạy trực tiếp; `dev-task.sh` không chạy khoá này) `&& make seed && make seed && make seed-count` | CI | đếm lần 2 = lần 1 |
| Kiểm kích thước fixture | `find tests/fixtures -size +200k` | CI | rỗng (ngoại lệ ghi lý do) |
| Grep thời gian thật | `grep -rnE "new Date\(\)|datetime\.now\(|time\.Now\(" tests/` | CI | 0 ngoài helper clock |
| Faker seed | kiểm `faker.seed` trong setup toàn cục | CI (grep) | có |

## Nguồn

- Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 (hiệu lực 01/01/2026): <https://bocongan.gov.vn/chinh-sach-phap-luat/co-so-du-lieu-van-ban/luat-bao-ve-du-lieu-ca-nhan-1753688803> — xác minh 2026-10-13 (nguồn Bộ Công an; đối chiếu văn bản gốc trước khi trích)
- GDPR Art. 5 (data minimisation), Art. 35: <https://eur-lex.europa.eu/eli/reg/2016/679/oj> — **(chưa xác minh trực tiếp ngày 2026-10-13)**
- Reserved domains cho ví dụ (`example.com`): RFC 2606 — <https://www.rfc-editor.org/rfc/rfc2606> (**chưa truy cập lại ngày 2026-10-13**)
- Catalog `seeker19110/stored` 07 (golden dataset, negative control, record/replay), 23 §3.1 (ghi lại eval chỉ qua `workflow_dispatch`), 09 (quét secret toàn bộ lịch sử) — đọc 2026-10-13.
- Khung cũ X-stored `quality-supplements.md` Nhóm 2 mục 4 "Chiến lược dữ liệu test" (factory, không dump production, E2E tự tạo/xoá, cố định thời gian/ngẫu nhiên), commit `1b80fe4`.
