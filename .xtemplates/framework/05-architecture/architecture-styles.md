---
title: Chọn kiểu kiến trúc: monolith · modular · microservices · serverless · event-driven
kind: module
prefix: ARC-STYLE
applies_to: [all]
updated: 2026-10-14
---

# Chọn kiểu kiến trúc: monolith · modular · microservices · serverless · event-driven

> Quy tắc chọn **kiểu kiến trúc** cho một hệ thống: bắt đầu từ monolith có module, chỉ tách dịch vụ khi có
> **bằng chứng** (đội, tải, nhịp phát hành độc lập), và mọi đơn vị triển khai tuân 12-factor. Áp dụng ở G2–G4
> (xem [`../00-method/lifecycle.md`](../00-method/lifecycle.md)); ranh giới module và luật phụ thuộc ở
> [`boundaries-and-modularity.md`](boundaries-and-modularity.md), ADR ghi quyết định ở [`decision-records.md`](decision-records.md).

## Nguyên tắc

1. **Monolith-first.** Một codebase, một đơn vị triển khai, module hoá bên trong. Chi phí vận hành của hệ phân tán
   (mạng, nhất quán, quan sát, on-call) chỉ đáng trả khi lợi ích tổ chức/kỹ thuật đã đo được (P3, P4 trong
   [`../00-method/principles.md`](../00-method/principles.md)).
2. **Kiểu kiến trúc là quyết định có bằng chứng, không phải sở thích.** Mỗi lần tách dịch vụ phải nêu được ít nhất
   một trong ba: (a) ≥ 2 đội cần phát hành độc lập; (b) một thành phần cần mở rộng/cô lập tài nguyên khác hẳn phần
   còn lại; (c) ràng buộc tuân thủ/cách ly dữ liệu bắt buộc tách.
3. **Ranh giới đi theo dữ liệu.** Dịch vụ sở hữu dữ liệu của mình; hai dịch vụ ghi chung một bảng là *distributed
   monolith* — mang đủ chi phí phân tán mà không có lợi ích nào.
4. **Kiểu kiến trúc ≠ topology triển khai.** Modular monolith có thể chạy nhiều bản sao, nhiều vùng; microservices
   có thể chạy trong một cluster. Quyết định "chia code thế nào" tách khỏi "chạy ở đâu".
5. **12-factor là sàn cho mọi đơn vị triển khai**: config từ môi trường (III), tiến trình stateless (VI), log là
   luồng sự kiện ra stdout (XI), backing service là tài nguyên gắn qua URL (IV), build–release–run tách bạch (V).
6. **Bản vẽ tương lai không phải bản dựng hôm nay.** Nếu giữ một kiến trúc đích (vd nhiều máy) bên cạnh bản đang
   chạy (một máy), phải ghi **điều kiện chuyển** tường minh — bài học ADR-0003 khung cũ (hồ sơ cục bộ/đám mây).

## Quyết định

Cây quyết định (đi từ trên xuống, dừng ở dòng đầu tiên thoả):

| Tình huống (có bằng chứng) | Kiểu khuyến nghị | Không dùng khi |
|---|---|---|
| Dự án mới, ≤ 2 đội, chưa có số liệu tải | **Modular monolith** (một deployable, module có ranh giới máy kiểm) | Có ràng buộc pháp lý buộc cách ly dữ liệu theo vùng/tenant ngay từ đầu |
| Workload theo sự kiện, bùng nổ ngắn, idle phần lớn thời gian (webhook, cron, xử lý file) | **Serverless/FaaS** cho phần đó, lõi vẫn monolith | Tải đều 24/7 (tốn hơn VM/container), cần kết nối CSDL lâu dài, hàm chạy > giới hạn nền tảng |
| Nhiều consumer cần phản ứng cùng một sự kiện nghiệp vụ, hoặc cần tách thời gian (producer không chờ consumer) | **Event-driven** (broker + outbox, xem [`integration-patterns.md`](integration-patterns.md)) | Luồng cần trả lời ngay cho người dùng (truy vấn, đăng nhập) |
| ≥ 2 đội phát hành độc lập **và** đã có CI/CD, trace phân tán, on-call | **Tách dịch vụ theo miền** (bounded context), mỗi dịch vụ sở hữu dữ liệu | Chưa có 3 điều kiện tiên quyết trên; đội < 2 |
| Thành phần có hồ sơ tài nguyên khác hẳn (GPU, bộ nhớ lớn, đuôi độ trễ) | Tách **một** dịch vụ đó, phần còn lại giữ nguyên | Có thể giải bằng hàng đợi + worker trong cùng codebase |
| Hệ có sẵn, cần hiện đại hoá | **Strangler fig**: bọc hệ cũ, chuyển từng năng lực sang hệ mới qua một cổng | Hệ cũ sắp ngừng, không có người dùng thật |

Mặc định cho mọi hồ sơ: **modular monolith + hàng đợi job nền** (job nền xem
[`../08-backend/background-jobs-and-queues.md`](../08-backend/background-jobs-and-queues.md)). Mobile/desktop/CLI:
kiến trúc áp cho phần backend nếu có; client tuân luật phụ thuộc ở [`boundaries-and-modularity.md`](boundaries-and-modularity.md).

## Checklist

- [ ] `ARC-STYLE-001` **MUST** Kiểu kiến trúc được chốt bằng một ADR ở G2–G4, có ≥ 2 phương án cân nhắc và mục "điều kiện đọc lại". → Kiểm: tồn tại `docs/adr/*` chứa tiêu đề quyết định kiến trúc, có heading "Phương án đã cân nhắc" (hoặc "Considered Options") và heading điều kiện đọc lại. · Nguồn: [`decision-records.md`](decision-records.md) · lifecycle G4
- [ ] `ARC-STYLE-002` **MUST** Dự án mới mặc định là một đơn vị triển khai (modular monolith); mọi dịch vụ tách thêm phải nêu bằng chứng (đội/tải/cách ly) trong ADR. → Kiểm: số deployable trong CI/IaC = 1, hoặc mỗi deployable thêm được trỏ tới một ADR có mục "Bằng chứng tách". · Nguồn: catalog 13 §6b (CRM 6 service vs modular monolith)
- [ ] `ARC-STYLE-003` **MUST** Mỗi đơn vị triển khai đọc cấu hình từ biến môi trường, không đọc file cấu hình chứa bí mật trong image. → Kiểm: `grep` không thấy chuỗi kết nối/khoá trong source; Dockerfile không `COPY .env`; cổng bí mật ở [`../12-security/secrets-management.md`](../12-security/secrets-management.md). · Nguồn: 12-factor III
- [ ] `ARC-STYLE-004` **MUST@L** Tiến trình phục vụ request là stateless: phiên, upload tạm, cache cục bộ không là nguồn sự thật; trạng thái nằm ở backing service. → Kiểm: test tích hợp chạy 2 bản sao sau load balancer với sticky session tắt, luồng chính vẫn đúng. · Nguồn: 12-factor VI
- [ ] `ARC-STYLE-005` **MUST@L** Log ghi ra stdout/stderr dạng có cấu trúc; không tự quay file log trong container. → Kiểm: chạy container với stdout bị bắt, thấy JSON log; không có file `*.log` sinh trong image. · Nguồn: 12-factor XI · [`../01-baseline/errors-and-logging.md`](../01-baseline/errors-and-logging.md)
- [ ] `ARC-STYLE-006` **MUST** Khi đã tách dịch vụ: mỗi bảng/collection chỉ có đúng một dịch vụ ghi; dịch vụ khác đọc qua API hoặc sự kiện. → Kiểm: bảng ánh xạ `bảng → dịch vụ sở hữu` trong `docs/architecture/`; test tích hợp xác nhận tài khoản CSDL của dịch vụ B không có quyền INSERT/UPDATE vào bảng của A. · Nguồn: microservices.io Database per Service (xem Nguồn)
- [ ] `ARC-STYLE-007` **MUST@L** Không tách dịch vụ khi chưa có đủ ba điều kiện tiên quyết: CI/CD tự động cho từng dịch vụ, trace phân tán xuyên dịch vụ, lịch on-call. → Kiểm: ADR tách dịch vụ có bảng 3 điều kiện kèm link workflow CI, dashboard trace, lịch trực. · Nguồn: catalog 13 §6b · [`../15-operations/observability.md`](../15-operations/observability.md)
- [ ] `ARC-STYLE-008` **MUST@L** Đồ thị gọi giữa các dịch vụ là DAG (không vòng đồng bộ); vòng chỉ chấp nhận qua sự kiện bất đồng bộ và được ghi trong ADR. → Kiểm: script dựng đồ thị từ trace/service map và kiểm chu trình chạy trong CI, exit ≠ 0 khi có vòng đồng bộ. · Nguồn: Azure Saga pattern ("cyclic dependency" là nhược điểm choreography)
- [ ] `ARC-STYLE-009` **SHOULD** Mỗi dịch vụ/module có đúng một đội sở hữu, ghi trong `CODEOWNERS`. → Kiểm: mọi thư mục dịch vụ khớp ≥ 1 dòng `CODEOWNERS`; PR tự gán reviewer. · Nguồn: catalog 23 §4 (CODEOWNERS/`pr-policy`)
- [ ] `ARC-STYLE-010` **SHOULD** Thành phần serverless có handler idempotent (nền tảng gọi lại ít nhất một lần) và giới hạn đồng thời cấu hình tường minh. → Kiểm: test gọi handler 2 lần cùng event → một tác động; IaC khai báo `reserved_concurrency`/tương đương. · Nguồn: [`integration-patterns.md`](integration-patterns.md) ARC-INT-001
- [ ] `ARC-STYLE-011` **SHOULD** Serverless chỉ dùng khi đã đo cold start và chi phí ở tải thật; kết nối CSDL qua pool/proxy chứ không mở trực tiếp mỗi lần gọi. → Kiểm: báo cáo đo p95 cold start và ước tính chi phí/tháng trong ADR; cấu hình pool (xem [`../09-database/indexing-and-query-performance.md`](../09-database/indexing-and-query-performance.md)). · Nguồn: evidence-and-sources §2
- [ ] `ARC-STYLE-012` **SHOULD** Code dùng chung giữa các dịch vụ đóng gói thành thư viện có phiên bản semver; không dùng chung CSDL làm "thư viện". → Kiểm: `package.json`/`pyproject.toml`/`go.mod` của mỗi dịch vụ trỏ phiên bản thư viện nội bộ; không có hai dịch vụ cùng connection string. · Nguồn: 12-factor II
- [ ] `ARC-STYLE-013` **SHOULD** Dự án có sẵn hiện đại hoá bằng strangler fig: một cổng vào duy nhất, chuyển dần từng năng lực, có bảng tiến độ năng lực đã chuyển. → Kiểm: `docs/architecture/strangler-progress.md` liệt kê năng lực + trạng thái + ngày. · Nguồn: [`../00-method/lifecycle.md`](../00-method/lifecycle.md) quy tắc 5 (brownfield)
- [ ] `ARC-STYLE-014` **SHOULD** Kiến trúc đích (nếu khác bản đang chạy) được tách thành hồ sơ riêng kèm điều kiện chuyển; tài liệu nói rõ "đang áp dụng" vs "đích". → Kiểm: mục kiến trúc trong `PROJECT.md`/ADR có hai nhãn đó và danh sách điều kiện chuyển. · Nguồn: khung cũ ADR-0003 (`git show 1b80fe4:docs/adr/0003-thu-hep-ve-boi-canh-cuc-bo.md`)
- [ ] `ARC-STYLE-015` **MAY** Dùng BFF (backend-for-frontend) riêng cho từng loại client khi hợp đồng dữ liệu web/mobile khác nhau đáng kể. → Kiểm: ADR nêu khác biệt hợp đồng; BFF không chứa logic nghiệp vụ (chỉ gom/biến đổi).
- [ ] `ARC-STYLE-016` **MAY** Cell-based deployment (nhiều bản sao độc lập toàn hệ) cho quy mô L để giới hạn bán kính sự cố. → Kiểm: IaC khai báo ≥ 2 cell, test chuyển tenant giữa cell. · Nguồn: Azure Bulkhead pattern ("cell-based architecture")
- [ ] `ARC-STYLE-017` **MAY** Ghi lại kiến trúc dưới dạng "fitness function" chạy được (ví dụ kiểm số deployable, kiểm quyền ghi bảng) thay vì chỉ sơ đồ. → Kiểm: script `scripts/arch-check.*` chạy trong CI. · Nguồn: [`boundaries-and-modularity.md`](boundaries-and-modularity.md)

## Bẫy thường gặp

- **Microservices từ ngày đầu.** Ảnh CRM 6 service + Kubernetes (catalog 13 §6b) — các CRM mã nguồn mở thực tế
  (Twenty, …) đều là monolith + hàng đợi. Tránh: mục ARC-STYLE-002/007.
- **Distributed monolith.** Tách tiến trình nhưng dùng chung schema; mọi thay đổi bảng kéo theo deploy đồng loạt.
  Tránh: ARC-STYLE-006, kiểm quyền CSDL theo dịch vụ.
- **Tách theo lớp kỹ thuật** (service "DB", service "API", service "UI") thay vì theo miền nghiệp vụ → mọi tính
  năng chạm cả ba. Tránh: ranh giới = bounded context, xem [`boundaries-and-modularity.md`](boundaries-and-modularity.md).
- **"Serverless rẻ hơn".** Chỉ đúng với tải thưa; tải đều + kết nối CSDL mở mỗi lần gọi làm cạn pool. Tránh: ARC-STYLE-011.
- **Event-driven không schema.** Producer đổi payload, consumer vỡ im lặng. Tránh: hợp đồng sự kiện có phiên bản —
  ARC-INT-012 trong [`integration-patterns.md`](integration-patterns.md).
- **Đọc bản vẽ đích thành bản dựng hôm nay.** Spec ghi PostgreSQL + Temporal + OPA trong khi repo chạy SQLite một
  tiến trình (khung cũ ADR-0003). Tránh: ARC-STYLE-014.
- **Sao chép kiến trúc công ty lớn** (ảnh system design) mà không có đội/tải tương ứng. Tránh: mọi tách dịch vụ phải
  có bằng chứng ở ADR (ARC-STYLE-002).

## Cổng tự động

| Việc kiểm | Công cụ (giấy phép) | Lệnh/cách | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| ADR kiến trúc có đủ mục | `markdownlint-cli2` 0.23.3 (MIT) + script grep heading | `markdownlint-cli2 "docs/adr/*.md"` + `grep -L "Phương án đã cân nhắc\|Considered Options" docs/adr/0*.md` | CI (job docs) | 0 file thiếu heading |
| Luật phụ thuộc giữa module/dịch vụ | dependency-cruiser · import-linter · ArchUnit (xem [`boundaries-and-modularity.md`](boundaries-and-modularity.md)) | theo module đó | pre-commit + CI | 0 vi phạm mức `error` |
| Không bí mật/config cứng trong code | gitleaks + semgrep (xem [`../12-security/secrets-management.md`](../12-security/secrets-management.md)) | theo module đó | pre-commit + CI | 0 phát hiện |
| Số deployable và chủ sở hữu | script tự viết: đếm service trong `docker-compose.yml`/IaC, đối chiếu `CODEOWNERS` và ADR | `python3 scripts/arch-check.py` | CI | mỗi deployable có ADR + owner |
| Stateless thật | test tích hợp 2 bản sao, sticky session tắt | `docker compose up --scale app=2` + E2E luồng chính | CI (nightly nếu chậm) | E2E xanh |
| Chu trình gọi đồng bộ giữa dịch vụ (L) | script dựng đồ thị từ service map/trace | `python3 scripts/arch-check.py --cycles` | CI nightly | 0 vòng đồng bộ |

## Nguồn

- The Twelve-Factor App (I–XII, "Last updated 2017"): <https://12factor.net/> — xác minh 2026-10-13.
- Microservices.io — Database per service / Transactional outbox / Saga: <https://microservices.io/patterns/data/saga.html>,
  <https://microservices.io/patterns/data/transactional-outbox.html> — xác minh 2026-10-13.
- Azure Architecture Center — Saga (choreography/orchestration, cyclic dependency) ms.date 2025-02-25:
  <https://learn.microsoft.com/en-us/azure/architecture/patterns/saga>; Bulkhead (cell-based) ms.date 2026-03-19:
  <https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead> — xác minh 2026-10-13.
- C4 model (4 mức): <https://c4model.com/> — xác minh 2026-10-13.
- Catalog `seeker19110/stored` 13 §6b (phản biện ảnh CRM microservices; các CRM OSS đều monolith), đọc 2026-10-13.
- Khung cũ X-stored ADR-0003 (hai hồ sơ cục bộ/đám mây + điều kiện chuyển), commit `1b80fe4`.
- `research/2026-10-13-old-framework-analysis.md` (thiếu backend/kiến trúc chi tiết ở khung cũ).
