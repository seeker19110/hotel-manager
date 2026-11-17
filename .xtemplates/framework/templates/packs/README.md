---
title: Gói sản phẩm (packs) — hợp đồng
kind: index
updated: 2026-11-05
---

# Gói sản phẩm có phiên bản (ADR-0068 lát B/C)

> Gói = lớp trên profile/industry: mã khởi đầu + lock + bộ nghiệm thu + CI cho **một stack đã kiểm**. Phiên bản gói =
> `VERSION` của khung (ADR-0068 câu 1); gói ở repo khung tới khi có ≥ 2 gói hoặc owner khác chủ khung. Cài:
> `python3 scripts/install.py <dự-án> --pack <id>` (xem trước: thêm `--plan`). Gói không kéo dependency vào CLI stdlib.

| Gói | Stack | Nghiệm thu | Ghi chú |
|---|---|---|---|
| [`web-api-ts`](web-api-ts/README.md) | Node 24 · pnpm 12 · TypeScript · Postgres 17 (RLS) · kysely · vitest · biome | `.github/workflows/pack-web-api.yml` của khung | API nhiều tenant + worker; không UI |

## Cấu trúc một gói

| Đường | Vai trò | Khi cài |
|---|---|---|
| `pack.json` | `schema: 1`, `id` (= tên thư mục), `owner`, `support_until`, `compat`, `profiles`, `controls` (ID khung), `xt_yaml` (lệnh chuẩn) | đọc, không chép |
| `starter/` | mã khởi đầu + lock + bộ nghiệm thu | **chỉ repo sạch** (không có `package.json`, gói chưa ghi ở manifest): chép không đè (`.gitignore` sẵn có chỉ được nối dòng còn thiếu); sau đó là của dự án, không bao giờ cập nhật |
| `managed/` | file gói sở hữu (CI nghiệm thu…) | như file harness: chưa sửa → cập nhật tại chỗ; đã sửa → `<file>.xtemplates-new` + drift trong `--plan`. **Dự án đang chạy (brownfield):** file chưa có chỉ thành đề xuất `<file>.xtemplates-new` (thêm workflow là đổi hành vi — hotel-manager đòi mọi job PR là required check); đổi tên để nhận, sau đó nâng theo hash |

Cây `starter/`/`managed/` **không** chép vào `.xtemplates/framework` của dự án đích (installer đọc từ khung nguồn) — test
và `package.json` của gói không bị công cụ của dự án (vitest, workspace) nhặt nhầm.
| `mutants.json` | ca sai cố ý (`find`/`replace` đúng một chỗ, `expect_fail` = tên test phải đỏ) | không chép; CI khung chạy bằng `tests/pack_mutants.py` |

- `xt_yaml` chỉ áp vào `xt.yaml` khi starter được chép (repo sạch), và chỉ khoá vắng/rỗng — khoá dự án đã điền giữ nguyên,
  `--plan` hiện ở `kept` (`own` + `pack`); brownfield/nâng bản: `--plan` liệt kê là `suggested`.
- Manifest dự án (`.xtemplates/manifest.json`) ghi `packs.<id>`: phiên bản, danh sách starter đã chép, managed.
- **Nâng N → N+1:** cài lại bằng khung mới. **Lùi:** cài lại bằng bản khung cũ (managed chưa sửa về bản cũ); mã starter là
  của dự án — lùi bằng git.
- Gói mới: thư mục mới đúng bảng trên, bộ nghiệm thu chạy được từ repo sạch trong CI, mỗi lớp bảo vệ quan trọng có ≥ 1 ca
  trong `mutants.json`, thêm dòng vào bảng đầu file và `CHANGELOG.md`.
