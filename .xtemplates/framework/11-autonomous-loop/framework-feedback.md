---
title: Phản hồi về khung từ dự án đích
kind: module
prefix: LOOP-FB
applies_to: [all]
updated: 2026-10-16
---

# Phản hồi về khung từ dự án đích

> Mỗi dự án cài khung là một lần thử khung trên thực tế. Module này quy định cách dự án đích **ghi lại lỗi do khung
> gây ra và cách đã khắc phục** (`xt.py feedback`), và cách repo khung **kéo về, gộp, sửa** (ADR-0010). Áp dụng cho mọi
> dự án đích và cho repo khung.

## Nguyên tắc

1. **Lỗi của khung khác lỗi của dự án.** Chỉ ghi phản hồi khi nguyên nhân nằm ở khung: công cụ `xt.py`/`install.py`
   sai, hook chặn nhầm hoặc để lọt, mục checklist sai/mơ hồ/không áp dụng được, tài liệu thiếu. Bug nghiệp vụ của dự án
   không phải phản hồi.
2. **Ghi lúc vừa sửa xong, cùng commit với bản sửa.** Lúc đó ngữ cảnh còn nguyên: triệu chứng, bước tái hiện, cách khắc phục.
3. **Triệu chứng và cách sửa, không dữ liệu.** Phản hồi đi về repo khung **public**: không mã nguồn, không dữ liệu người
   dùng, không tên khách hàng, không bí mật. `xt.py feedback` gộp một dòng và lọc bí mật bằng `redact`, nhưng người viết
   vẫn chịu trách nhiệm nội dung.
4. **Máy gom tín hiệu có sẵn.** MUST bị miễn trong blueprint và lý do autopilot bị chặn là dữ liệu khung cần; `feedback
   collect` gom chúng, không trùng.
5. **Khung kéo về, không để dự án đẩy sang.** Dự án đích không cần token ghi vào repo khác; repo khung đọc
   `docs/xtemplates-feedback/` của các dự án trong `docs/ops/TARGETS.md` và mở **PR nháp** — người duyệt trước khi công khai.
6. **Đổi khung khi có bằng chứng.** Một nhóm phản hồi (cùng loại + ID) đủ ngưỡng sửa khi ≥ 2 dự án cùng báo hoặc có bước
   tái hiện; sửa kèm test và CHANGELOG như mọi thay đổi khung.

## Quyết định

| Loại (`--kind`) | Khi nào | `--id` |
|---|---|---|
| `cong-cu` | `xt.py`/`install.py`/`dev-task.sh` crash, sai kết quả, thiếu tính năng chặn việc | tên lệnh, vd `xt.py loop record` |
| `hook-chan-nham` | Hook `deny`/`ask` một lệnh hoặc file vô hại | tên hook, vd `pre-bash-guard` |
| `hook-lot` | Hook để lọt hành động lẽ ra phải chặn/hỏi | tên hook |
| `muc-sai` | Mục checklist sai, mơ hồ, *Kiểm* không chạy được, mức không hợp quy mô | ID mục, vd `SEC-AUTH-001` |
| `tai-lieu` | Tài liệu/mẫu/skill thiếu hoặc dẫn sai | đường dẫn file |
| `mien-tru` | (máy gom) MUST bị miễn trong `BLUEPRINT.md` | ID mục |
| `bi-chan` | (máy gom) autopilot `blocked` | task hoặc `loop` |

Luồng: dự án đích `xt.py feedback add` / `xt.py feedback collect` → `docs/xtemplates-feedback/FB-NNN.md` (commit trong
repo dự án) → Routine của repo khung hằng tuần clone các repo trong `docs/ops/TARGETS.md`, chạy
`xt.py feedback aggregate --from <dự-án>=<thư-mục> …` → PR nháp `docs/ops/feedback/REPORT-<ngày>.md` vào repo khung →
người duyệt → PR sửa khung theo từng nhóm đủ ngưỡng. Người báo tay: issue template "Phản hồi từ dự án đích".

## Checklist

- [ ] `LOOP-FB-001` **SHOULD** Lỗi do khung (công cụ, hook, mục checklist, tài liệu) gặp trong dự án được ghi bằng `xt.py feedback add` ngay khi sửa xong, cùng commit với bản sửa: triệu chứng, cách khắc phục, bước tái hiện tối thiểu nếu có. → Kiểm: `docs/xtemplates-feedback/FB-*.md` có commit trùng commit sửa; `xt.py feedback list` liệt kê. · Nguồn: ADR-0010
- [ ] `LOOP-FB-002` **SHOULD** Trước khi bàn giao phiên hoặc phát hành, chạy `xt.py feedback collect` để gom MUST bị miễn và lý do autopilot bị chặn (không tạo trùng). → Kiểm: lệnh exit 0 trong báo cáo cuối; mỗi `[~]` MUST trong blueprint có FB `mien-tru` tương ứng. · Nguồn: ADR-0010
- [ ] `LOOP-FB-003` **MUST** Phản hồi không chứa bí mật, dữ liệu người dùng, tên khách hàng hay mã nguồn của dự án — chỉ triệu chứng, bước tái hiện tối thiểu, cách khắc phục; ghi qua `xt.py feedback` (gộp một dòng, `redact`) và người xem lại trước commit. → Kiểm: `gitleaks detect` sạch trên `docs/xtemplates-feedback/`; review PR có mục này. · Nguồn: ADR-0010, `CMP-VN-004`
- [ ] `LOOP-FB-004` **SHOULD** Dự án đích muốn khung kéo phản hồi về thì đăng ký repo (`owner/repo`) trong `docs/ops/TARGETS.md` của repo khung, hoặc báo tay qua issue template "Phản hồi từ dự án đích". → Kiểm: repo có trong `TARGETS.md` hoặc có issue nhãn `feedback`. · Nguồn: ADR-0010
- [ ] `LOOP-FB-005` **SHOULD** Routine hằng tuần đọc `.xtemplates/VERSION` (nhãn `<VERSION> (<git sha>)`) của mỗi đích trong `docs/ops/TARGETS.md` và ghi vào REPORT bảng **"đích × bản khung × số tuần chậm"** (so với bản khung hiện hành); đích chậm hơn 1 minor hoặc quá 4 tuần thì nêu rõ trong REPORT kèm đề xuất chạy lại `install.py`. Không cần đổi mã `xt.py`. → Kiểm: `docs/ops/feedback/REPORT-<ngày>.md` có bảng này, mỗi repo trong `TARGETS.md` một dòng. · Nguồn: `seeker19110/stored` 23 §4.2, §8 (X-Scanner adopt trước #287 nên thiếu `auto-complete-guard.sh`: drift khung ↔ đích; đọc 2026-10-16)

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Dán log/stacktrace nguyên văn vào phản hồi | Lộ đường dẫn, tên khách hàng, token lên repo public | Rút gọn thành triệu chứng + tái hiện tối thiểu; `redact` chỉ là lưới thứ hai |
| Ghi bug nghiệp vụ của dự án thành phản hồi khung | Repo khung ngập nhiễu, nhóm thật bị chìm | Hỏi: "khung đúng thì lỗi này có xảy ra không?" — có thì không phải lỗi khung |
| Để dự án đích tự mở issue/PR vào repo khung bằng token | Token ghi chéo repo, rủi ro lộ quyền; trùng lặp | Khung kéo về (Routine), dự án chỉ commit trong repo mình |
| Sửa khung theo một phản hồi đơn lẻ không tái hiện được | Khung đổi theo một ca đặc thù | Ngưỡng: ≥ 2 dự án hoặc có tái hiện |
| Miễn MUST rồi quên | Khung không biết mục nào hay bị miễn | `feedback collect` trước bàn giao/phát hành |
| Đích cài khung một lần rồi trôi (thiếu hook/mục mới) | Phản hồi về lỗi đã sửa ở bản mới; đích thiếu cổng mà không ai biết | Bảng "đích × bản khung × số tuần chậm" trong REPORT (`LOOP-FB-005`); đích chậm chạy lại `install.py` |

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| Ghi phản hồi | `xt.py feedback add --kind … --id … --symptom … --fix …` | Agent/người khi sửa lỗi do khung | exit 2 khi thiếu triệu chứng/cách sửa hoặc loại lạ |
| Gom tín hiệu máy | `xt.py feedback collect [--blueprint BLUEPRINT.md]` | Trước `/handover`, cuối autopilot | không tạo trùng (khoá `Nguồn: collect:…`) |
| Gộp ở repo khung | `xt.py feedback aggregate --from <dự-án>=<thư-mục> … [--json]` | Routine hằng tuần của repo khung | ✅ khi ≥ 2 dự án hoặc có tái hiện |
| Quét bí mật | `gitleaks detect` | CI của dự án đích và repo khung | 0 phát hiện |
| Drift bản khung | Routine đọc `.xtemplates/VERSION` từng đích trong `docs/ops/TARGETS.md` (không cần mã mới) | Routine hằng tuần của repo khung | Chậm > 1 minor hoặc > 4 tuần = nêu trong REPORT |

## Nguồn

- ADR-0010 (`docs/adr/0010-feedback-from-target-projects.md` của repo khung) — chủ repo yêu cầu 2026-10-15.
- `scripts/xt.py` (`feedback_entries`, `write_feedback`, `feedback_aggregate`, `redact`) và `tests/test_xt_cli.py` `FeedbackTest` — đọc 2026-10-15.
- Catalog `seeker19110/stored` 23 §4.2, §8 (X-Scanner: adoption pin SHA; thiếu `auto-complete-guard.sh` do adopt trước #287 — drift khung ↔ đích) — đọc 2026-10-16.
