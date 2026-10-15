---
title: Ranh giới, module hoá, C4, hexagonal, luật phụ thuộc
kind: module
prefix: ARC-MOD
applies_to: [all]
updated: 2026-10-14
---

# Ranh giới, module hoá, C4, hexagonal, luật phụ thuộc

> Cách vẽ và **giữ** ranh giới bên trong một codebase: sơ đồ C4 mức 1–2 làm bản đồ, hexagonal/clean làm luật
> hướng phụ thuộc, và một công cụ máy kiểm (dependency-cruiser / import-linter / ArchUnit) làm hàng rào trong CI.
> Áp cho mọi hồ sơ, kể cả CLI/thư viện/mobile. Kiểu kiến trúc tổng thể ở [`architecture-styles.md`](architecture-styles.md).

## Nguyên tắc

1. **Ranh giới theo miền nghiệp vụ, không theo lớp kỹ thuật.** Thư mục cấp một là `orders/`, `billing/`, `auth/`…;
   bên trong mỗi miền mới chia theo lớp. Đổi một tính năng chạm một thư mục.
2. **Phụ thuộc hướng vào trong (Dependency Rule).** Lõi nghiệp vụ (domain + use case) không import framework, ORM,
   HTTP, SDK; chúng ở lớp ngoài và nói chuyện với lõi qua **port** (interface) và **adapter** (ports & adapters,
   Cockburn 2005; Clean Architecture 2012).
3. **Luật phụ thuộc là code, không phải văn bản.** Mọi luật ("`domain` không import `infra`", "không vòng giữa
   module") viết thành cấu hình của công cụ kiểm và chạy trong CI (P9). Điểm "health" tổng hợp không thay được hàng
   rào cứng (catalog 16 §2b–2d).
4. **C4 mức 1–2 là bắt buộc, mức 3–4 tùy chọn.** System Context (ai dùng, hệ nào tích hợp) và Container (đơn vị
   chạy/lưu trữ) đủ để người mới và AI agent định vị; Component/Code sinh từ mã khi cần, không vẽ tay.
5. **Module có API công khai hẹp.** Một điểm xuất (`index.ts`, `__init__.py`, package public API); phần còn lại là
   nội bộ. Import xuyên vào nội bộ module khác là vi phạm.
6. **Sơ đồ là text trong repo.** Mermaid/Structurizr DSL/PlantUML commit cùng code, render trong CI; không ảnh vẽ
   tay làm nguồn sự thật (P5).

## Quyết định

| Câu hỏi | Chọn | Khi nào không |
|---|---|---|
| Cấu trúc thư mục | **Theo miền** (`src/<domain>/{domain,application,infra,api}`) | Thư viện/SDK nhỏ một miền: chia theo lớp là đủ |
| Mức "hexagonal" áp dụng | **S**: tách domain khỏi framework ở mức hàm thuần + repository interface · **M/L**: port/adapter tường minh, lõi không import infra | Script/cron dùng một lần |
| Công cụ kiểm luật phụ thuộc | JS/TS: **dependency-cruiser** 18.6.0 (MIT) · Python: **import-linter** 2.15 (BSD-2) · Java/Kotlin: **ArchUnit** 1.5.1 (Apache-2.0) · Go: `depguard` qua golangci-lint 2.14.0 (GPL-3.0 — chỉ là công cụ dev, không link vào sản phẩm) · .NET: NetArchTest.Rules 1.3.2 (chưa xác minh giấy phép) | Dự án < ~2 module: chỉ cần ESLint `no-restricted-imports`/`ruff` rule tương đương |
| Sơ đồ C4 bằng gì | **Mermaid** (`C4Context`/`C4Container`) render bằng `@mermaid-js/mermaid-cli` 12.0.0 (MIT) khi cần ảnh · **Structurizr DSL** + `structurizr-cli` 2025.11.09 (Apache-2.0) khi nhiều view từ một model | Hệ 1 container: một đoạn text mô tả + sơ đồ mức 1 là đủ |
| Kiểm vòng phụ thuộc | Bật `circular` (dependency-cruiser) / `acyclic siblings` (import-linter) / `slices().should().beFreeOfCycles()` (ArchUnit) | Không có ngoại lệ — vòng luôn là lỗi |
| Monorepo nhiều package | Luật phụ thuộc giữa package khai báo ở gốc (một file cấu hình), package chỉ import qua tên package | Xem hồ sơ `monorepo` |

## Checklist

- [ ] `ARC-MOD-001` **MUST@L** Repo có sơ đồ C4 mức 1 (System Context) và mức 2 (Container) dưới dạng text, render được. → Kiểm: `docs/architecture/c4-context.*` và `c4-container.*` tồn tại; lệnh render (mermaid-cli/structurizr-cli) exit 0 trong CI. · Nguồn: C4 model
- [ ] `ARC-MOD-002` **MUST@L** Sơ đồ Container liệt kê đúng các đơn vị chạy/lưu trữ đang có trong IaC/compose (không thừa, không thiếu). → Kiểm: script so khớp tên container trong sơ đồ với service trong `docker-compose.yml`/IaC; CI đỏ khi lệch. · Nguồn: evidence-and-sources luật 5 (grep cổng đang chạy)
- [ ] `ARC-MOD-003` **MUST** Lõi nghiệp vụ không import framework web, ORM, HTTP client, SDK đám mây. → Kiểm: luật `forbidden` của dependency-cruiser/import-linter/ArchUnit từ `domain|application` tới `infra|api|framework` ở mức `error`, chạy trong CI. · Nguồn: Clean Architecture (Dependency Rule) · Hexagonal Architecture
- [ ] `ARC-MOD-004` **MUST** Không có vòng phụ thuộc giữa các module/miền. → Kiểm: luật `circular: true` (dependency-cruiser) / contract `acyclic siblings` (import-linter) / `beFreeOfCycles()` (ArchUnit) ở mức lỗi, CI exit ≠ 0 khi vi phạm. · Nguồn: tài liệu công cụ (xem Nguồn)
- [ ] `ARC-MOD-005` **MUST** Mỗi module chỉ được import từ điểm xuất công khai của module khác, không import đường dẫn nội bộ. → Kiểm: luật `forbidden` `from: <module A> to: <module B>/(?!index)` hoặc contract `protected`; ESLint `no-restricted-imports` cho đường dẫn `**/internal/**`. · Nguồn: import-linter contract types
- [ ] `ARC-MOD-006` **MUST@L** Cấu hình luật phụ thuộc nằm trong repo và được bảo vệ: sửa file luật cần review riêng (CODEOWNERS) và hook cảnh báo. → Kiểm: `.dependency-cruiser.*`/`.importlinter`/`ArchTest` có dòng trong `CODEOWNERS`; hook `ask`/`deny` khi sửa (xem [`../11-autonomous-loop/harness-files.md`](../11-autonomous-loop/harness-files.md)). · Nguồn: catalog 23 §4.3 (`protect-config.sh`)
- [ ] `ARC-MOD-007` **MUST@L** Mọi truy cập tài nguyên ngoài (CSDL, HTTP, hàng đợi, file, đồng hồ, random) đi qua port có interface, để test lõi không cần hạ tầng. → Kiểm: test đơn vị của `domain|application` chạy không mở socket/CSDL (test runner cấm network, vd `pytest-socket`/`nock`); thời gian lấy qua `Clock` tiêm vào. · Nguồn: Hexagonal Architecture (drive app bằng test như bằng người)
- [ ] `ARC-MOD-008` **MUST@M** Thư mục cấp một của source chia theo miền nghiệp vụ; tên miền trùng với bounded context trong `PROJECT.md`/spec. → Kiểm: danh sách thư mục `src/*` ⊆ danh sách miền trong `docs/architecture/domains.md`; script so khớp trong CI. · Nguồn: [`../17-product-project/specification.md`](../17-product-project/specification.md)
- [ ] `ARC-MOD-009` **SHOULD** Mỗi module có `README.md` nêu trách nhiệm, API công khai, module nó được phép phụ thuộc. → Kiểm: `find src -maxdepth 2 -name README.md` phủ 100% module; nội dung có 3 heading đó. · Nguồn: [`../01-baseline/documentation-minimum.md`](../01-baseline/documentation-minimum.md)
- [ ] `ARC-MOD-010` **SHOULD** Luật phụ thuộc mô tả **lớp** (api → application → domain ← infra) bằng contract `layers`/`layeredArchitecture()`, không chỉ liệt kê cặp cấm. → Kiểm: file cấu hình có khai báo lớp theo thứ tự; test kiến trúc đỏ khi thêm import ngược chiều (thử bằng mutation thủ công một lần, ghi vào PR). · Nguồn: import-linter `layers` · ArchUnit `layeredArchitecture()`
- [ ] `ARC-MOD-011` **SHOULD** Kiểm luật phụ thuộc chạy ở pre-commit (chỉ file đổi) và CI (toàn bộ). → Kiểm: `.pre-commit-config.yaml`/`lint-staged` có lệnh depcruise/lint-imports; workflow CI có job tương ứng. · Nguồn: [`../10-workflow/ci-cd-pipeline.md`](../10-workflow/ci-cd-pipeline.md)
- [ ] `ARC-MOD-012` **SHOULD** Sinh sơ đồ phụ thuộc thực tế từ mã (dependency-cruiser `--output-type dot`, `pydeps`, ArchUnit report) và đính kèm PR thay đổi kiến trúc. → Kiểm: artifact CI `deps.svg` tồn tại cho PR có nhãn `architecture`. · Nguồn: catalog 16 §2d (code knowledge graph trước vòng sửa lớn)
- [ ] `ARC-MOD-013` **SHOULD** Hợp đồng giữa module (DTO/event) định nghĩa một nơi và sinh kiểu ra các phía (schema → type), không sao chép tay. → Kiểm: kiểu ở phía consumer được sinh từ file schema (OpenAPI/JSON Schema/protobuf) qua lệnh trong CI; diff sinh = 0. · Nguồn: P5 một nguồn sự thật
- [ ] `ARC-MOD-014` **SHOULD** Trước vòng refactor lớn, dựng bản đồ mã (code map/graph) có nhãn EXTRACTED/INFERRED để agent/người không đoán cấu trúc. → Kiểm: `docs/architecture/CODEMAP.md` hoặc graph file sinh bằng công cụ, ngày sinh ≤ 30 ngày. · Nguồn: catalog 16 §2b–2d · [`../18-cross-cutting/docs-for-ai-agents.md`](../18-cross-cutting/docs-for-ai-agents.md)
- [ ] `ARC-MOD-015` **MAY** Sơ đồ C4 mức 3 (Component) sinh tự động cho module phức tạp nhất, không vẽ tay. → Kiểm: lệnh sinh trong `package.json`/`Makefile`; file sinh bị gitignore hoặc có cổng drift.
- [ ] `ARC-MOD-016` **MAY** Dùng ngôn ngữ chung (ubiquitous language): thuật ngữ miền trong code trùng tài liệu/spec; có glossary. → Kiểm: `docs/GLOSSARY.md`; lint tên (ví dụ cấm cả `customer` và `client` cho cùng khái niệm) nếu đội muốn.
- [ ] `ARC-MOD-017` **MAY** Mobile/desktop: tách lớp UI khỏi lớp nghiệp vụ bằng cùng luật (ViewModel/BLoC/Presenter không import widget/UIKit). → Kiểm: luật phụ thuộc tương đương của stack (vd `dart_code_linter`/Swift module boundaries) hoặc cấu trúc package.

## Bẫy thường gặp

- **Hexagonal "trang trí".** Có `ports/` nhưng domain vẫn import ORM entity; test lõi vẫn cần CSDL. Tránh: ARC-MOD-003/007 với luật máy kiểm.
- **Sơ đồ đẹp, mã khác.** C4 vẽ 3 container, compose có 6. Tránh: ARC-MOD-002 so khớp tự động.
- **Chấm điểm thay cho hàng rào.** Dashboard "architecture health 82%" không chặn được một import sai; chỉ luật
  `error` trong CI mới chặn (catalog 16 §2b). Tránh: ARC-MOD-004/011.
- **Nới luật để xanh.** Thêm `pathNot`/`ignore_imports` cho qua CI. Tránh: ARC-MOD-006 — file luật có owner và hook.
- **Chia thư mục theo lớp toàn cục** (`controllers/`, `services/`, `models/`) → mỗi tính năng rải 3 nơi, ranh giới
  miền biến mất. Tránh: ARC-MOD-008.
- **Module "shared/utils" phình to** thành nơi mọi thứ phụ thuộc và phụ thuộc mọi thứ → vòng. Tránh: `shared` chỉ
  chứa thuần (không import miền); luật cấm `shared → <domain>`.
- **Hợp đồng sao chép tay** giữa frontend/backend/worker → trôi im lặng. Tránh: ARC-MOD-013.
- **AI agent đoán cấu trúc** rồi tạo module trùng tên/khái niệm. Tránh: ARC-MOD-014 + luật 1 trong
  [`../00-method/evidence-and-sources.md`](../00-method/evidence-and-sources.md).

## Cổng tự động

| Việc kiểm | Công cụ (phiên bản · giấy phép, xác minh 2026-10-13) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Luật phụ thuộc JS/TS (lớp, cấm, vòng) | dependency-cruiser 18.6.0 · MIT | `npx depcruise src --config .dependency-cruiser.cjs --output-type err` | pre-commit (lint-staged) + CI | 0 vi phạm `error`; `warn` không tăng |
| Luật phụ thuộc Python | import-linter 2.15 · BSD-2-Clause | `lint-imports` (cấu hình `.importlinter`: contracts `layers`, `forbidden`, `independence`, `acyclic siblings`) | pre-commit + CI | mọi contract KEPT |
| Luật phụ thuộc Java/Kotlin | ArchUnit 1.5.1 · Apache-2.0 | test JUnit `layeredArchitecture()`, `slices()...beFreeOfCycles()` | CI (test job) | test xanh |
| Luật import Go | golangci-lint 2.14.0 (`depguard`) · GPL-3.0 (công cụ dev) | `golangci-lint run` | pre-commit + CI | 0 lỗi |
| Luật .NET | NetArchTest.Rules 1.3.2 (giấy phép chưa xác minh) | test xUnit/NUnit | CI | test xanh |
| Render sơ đồ C4 | mermaid-cli 12.0.0 · MIT / structurizr-cli 2025.11.09 · Apache-2.0 | `mmdc -i docs/architecture/c4-container.mmd -o /tmp/out.svg` · `structurizr-cli validate -w workspace.dsl` | CI (docs job) | exit 0 |
| Sơ đồ ↔ IaC khớp | script tự viết (so tên container) | `python3 scripts/arch-check.py --c4` | CI | 0 lệch |
| Test lõi không chạm mạng | `pytest-socket` / `nock`+`disableNetConnect` / JUnit rule tương đương (phiên bản theo lockfile) | chạy cùng unit test | CI | 0 kết nối ngoài |
| Export/dead code (hỗ trợ giữ API hẹp) | xem [`../14-testing-quality/static-analysis-and-code-quality.md`](../14-testing-quality/static-analysis-and-code-quality.md) | theo module đó | CI | theo module đó |

## Nguồn

- C4 model — 4 mức trừu tượng: <https://c4model.com/> — xác minh 2026-10-13.
- Alistair Cockburn, Hexagonal Architecture (2005-09-04): <https://alistair.cockburn.us/hexagonal-architecture/> — xác minh 2026-10-13.
- Robert C. Martin, The Clean Architecture (2012-08-13, Dependency Rule): <https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html> — xác minh 2026-10-13.
- dependency-cruiser rules reference (forbidden/allowed/required, `circular`, severity, exit code): <https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md>; npm 18.6.0 MIT: <https://registry.npmjs.org/dependency-cruiser/latest> — xác minh 2026-10-13.
- import-linter (contracts forbidden/protected/layers/independence/acyclic siblings): <https://import-linter.readthedocs.io/en/stable/>; PyPI 2.15 BSD-2: <https://pypi.org/pypi/import-linter/json> — xác minh 2026-10-13.
- ArchUnit user guide 1.5.1 (layeredArchitecture, slices cycles): <https://www.archunit.org/userguide/html/000_Index.html>; Maven Central 1.5.1 (2026-09-25) — xác minh 2026-10-13.
- mermaid-cli 12.0.0 MIT: <https://registry.npmjs.org/@mermaid-js/mermaid-cli/latest>; structurizr-cli 2025.11.09 Apache-2.0: <https://formulae.brew.sh/api/formula/structurizr-cli.json>; golangci-lint 2.14.0 GPL-3.0: <https://formulae.brew.sh/api/formula/golangci-lint.json>; NetArchTest.Rules 1.3.2: <https://api.nuget.org/v3-flatcontainer/netarchtest.rules/index.json> — xác minh 2026-10-13.
- Catalog `seeker19110/stored` 16 §2b–2d (chặn kiến trúc xấu bằng dependency-cruiser/import-linter, không bằng điểm health; code graph EXTRACTED/INFERRED), 23 §4.3 (`protect-config.sh`), đọc 2026-10-13.
