---
name: audit
description: Audit toàn diện dự án (hoặc chính repo khung) theo blueprint + 13 nhóm (kiến trúc, bảo mật, chất lượng mã, test, hiệu năng, a11y/UX, phụ thuộc, CI/CD, tài liệu, dữ liệu, cấu hình, thống nhất chéo tính năng, harness agent) với máy đỡ — `xt.py audit plan` dò phạm vi/công cụ/bằng chứng cũ, `xt.py audit check` kiểm sổ; xác minh đối kháng mọi 🔴/🟠; quét lại theo diff; DỪNG CHỜ DUYỆT trước khi sửa. Dùng khi người dùng muốn rà lỗi toàn diện, kiểm tra toàn bộ, hoàn thiện dự án, nhận dự án có sẵn, trước phát hành, hoặc gõ /audit.
argument-hint: "[full|delta|group:<MÃ>|resume]"
---

# /audit — bằng chứng trước, sửa sau khi duyệt

Phương pháp đầy đủ (nhóm, mức, schema phát hiện, Definition of Complete): `<FW>/00-method/audit.md`.
`<FW>` = `.xtemplates/framework` ở dự án đích, `framework` ở repo khung. `<XT>` = `python3 .xtemplates/scripts/xt.py` (hoặc `python3 scripts/xt.py`).
Sổ máy đọc: `docs/ops/AUDIT-STATUS.md` (mẫu `<FW>/templates/AUDIT-STATUS.md`); báo cáo: `docs/ops/AUDIT-REPORT-<ngày>.md` (mẫu `<FW>/templates/AUDIT-REPORT.md`).

## 0. Chọn chế độ
- Chưa có `AUDIT-STATUS.md` hoặc người dùng nói `full` → quét toàn bộ.
- Có sổ → `delta` mặc định: chỉ nhóm mà `<XT> audit plan` liệt kê ở "Quét lại" (chưa quét / SHA không còn tổ tiên HEAD / có file đổi).
- `group:<MÃ>` → một nhóm (vd `group:SEC`). `resume` → tiếp nhóm đang `chưa quét`.

## 1. Plan — đọc repo thật, không audit "khung trống"
Chạy `<XT> audit plan` (thêm `--json` khi cần xử lý máy). Từ output:
- Ghi nhóm `N/A`/`rút gọn` kèm lý do vào sổ; **không** quét nhóm N/A, không bịa phát hiện cho mã không tồn tại.
- Công cụ **thiếu** của nhóm áp dụng: cài được nhanh (pip/npm/binary chính chủ, phiên bản ghim) thì cài và chạy; không được → bằng chứng nhóm đó là `chưa biết:` + cần gì để đo.
- Mục "Bằng chứng/miễn trừ blueprint trỏ file đã đổi" → mở từng mục, xác minh lại; sai → phát hiện nhóm 13 (HAR).
- Nhóm 13 (harness): chạy `<XT> doctor --json` trước — mỗi lỗi ✗ là một phát hiện có sẵn đường tái hiện (không `--fix` trong lúc audit: sửa chờ duyệt).
- Repo khung (`REPO KHUNG`): trọng tâm nhóm 9 (quy ước, ID, link, nguồn có ngày, tài liệu lệch mã) và 13 (hook, install, lệnh `xt.py`).

## 2. Blueprint
`<XT> blueprint-status BLUEPRINT.md --json`: MUST mở kiểm được ngay → phát hiện; miễn trừ nghi sai → phát hiện. Không tick blueprint trong lúc audit.

## 3. Quét theo nhóm — lệnh thật, song song khi độc lập
- Chia nhóm áp dụng thành 2–4 cụm độc lập về file (gợi ý: {SEC, CFG, DEP, CI} · {ARCH, CODE, TEST, PERF} · {DOC, HAR, XFEAT} · {A11Y, DATA}).
- Mỗi cụm giao một subagent **read-only** (`reviewer` cho mã/bảo mật, `Explore` cho tài liệu), prompt gồm: nhóm, nhà yêu cầu ở bảng §3 của `audit.md`, lệnh/công cụ có sẵn, thư mục scratch để tái hiện, yêu cầu **mỗi phát hiện có file:dòng hoặc lệnh + output**, phân biệt đo được/suy luận/chưa biết, không sửa file.
- Phiên chính vẫn tự chạy cổng chuẩn (`xt.yaml`/`dev-task.sh gate`), coverage, gitleaks toàn lịch sử (nếu cài được), và đo những gì subagent không làm.
- Subagent không lồng subagent. Gộp kết quả, bỏ trùng, đánh ID `AUD-<MÃ>-NNN` (không tái sử dụng số cũ trong sổ).

## 4. Xác minh đối kháng (bắt buộc với 🔴/🟠)
Gửi danh sách 🔴/🟠 cho một `reviewer` **khác** subagent đã tìm ra (model khác nếu được) để tái hiện độc lập.
Không tái hiện được → hạ thành `suy luận:` (và hạ mức nếu cần) hoặc `bác bỏ` kèm lý do. Ghi người/lần xác minh vào báo cáo.

## 5. Ghi sổ + báo cáo
- Cập nhật `docs/ops/AUDIT-STATUS.md`: nhóm đã quét (SHA = `git rev-parse HEAD` lúc quét, ngày), bảng phát hiện đúng schema.
- Viết `docs/ops/AUDIT-REPORT-<ngày>.md`: tóm tắt đếm, phạm vi (output rút gọn `audit plan`), lệnh đã chạy + exit, chi tiết 🔴/🟠 (tái hiện từng bước), kế hoạch sửa theo đợt, nợ 🟢 có chủ.
- `<XT> audit check docs/ops/AUDIT-STATUS.md` phải exit 0. Commit `docs(audit): …` (không sửa mã trong commit này).

## 6. DỪNG CHỜ DUYỆT
Trình ≤ 20 dòng: số phát hiện theo mức, 🔴 từng dòng, kế hoạch đợt (mỗi đợt ≤ 1 PR, 🔴 trước, bug có test tái hiện đỏ trước khi sửa).
**Không sửa trước khi người duyệt** — trừ khi đang autopilot đã duyệt trước và phát hiện thuộc phạm vi PLAN.
Đang autopilot: phiên chính tự duyệt kế hoạch sửa theo tiêu chí chất lượng cuối (ADR-0008, ghi `loop decide`) rồi làm tiếp; phần cần người (điểm dừng về hành động) → `<XT> loop defer`, chỉ `loop block` khi mọi việc còn lại phụ thuộc nó (ADR-0009).

## 7. Hội tụ (sau duyệt)
Mỗi đợt: test/Gate đỏ → sửa → `/gate` → PR → cập nhật phát hiện `đã sửa` (#PR) → `<XT> audit plan` → quét lại nhóm bị chạm.
Lặp tới khi `<XT> audit check docs/ops/AUDIT-STATUS.md --strict` exit 0 (Definition of Complete). Nợ 🟢 giữ lại: `chấp nhận` có `chủ:` + `hạn:`.

## Không bao giờ
Khai "an toàn/đạt" khi công cụ không chạy được · gộp suy luận thành đo được · sửa lặng lẽ trong lúc audit · hạ ngưỡng/nới cấu hình để phát hiện biến mất · xoá dòng phát hiện (bác bỏ thì giữ dòng + lý do).
