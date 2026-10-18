---
name: blueprint
description: Ghép hoặc cập nhật BLUEPRINT.md cho dự án từ khung X-Templates (hồ sơ + gói ngành + quy mô), audit hiện trạng theo blueprint và báo tiến độ MUST/SHOULD. Dùng ở G1, khi khung cập nhật, hoặc khi người dùng hỏi "dự án còn thiếu gì".
argument-hint: "[compose|status|audit] [--profile p --industry i --scale M]"
---

# /blueprint — checklist có ID cho dự án

`<FW>` = `.xtemplates/framework` trong dự án đích, hoặc `framework` trong repo khung. `<XT>` = `python3 .xtemplates/scripts/xt.py` (hoặc `python3 scripts/xt.py`).

## compose (G1)
1. `<XT> list profiles` / `<XT> list industries` → chọn **một** hồ sơ chính, 0..n ngành, quy mô theo bảng `<FW>/00-method/composition.md`.
2. `<XT> compose --profile <p> [--industry <i>]... --scale <S|M|L> [--add <module-glob>]... --out BLUEPRINT.md`
   - `--add` khi dự án có nhu cầu ngoài hồ sơ (vd web app có tính năng AI → `--add "13-ai-engineering/*"`).
   - `--include-may` nếu muốn thấy cả mục MAY.
3. Commit `BLUEPRINT.md` và `BLUEPRINT-BACKLOG.md` (ADR-0012: file chính chỉ MUST theo quy mô, backlog SHOULD/MAY; `blueprint-status` đọc cả hai). Không sửa chữ của mục; muốn đổi yêu cầu → PR vào khung rồi ghép lại.

## status
`<XT> blueprint-status BLUEPRINT.md [--strict] [--run]` — đếm đạt/miễn/chưa theo mức; `--run` chạy lại lệnh `— Kiểm: `<lệnh>`` của mục đã tick (một cặp backtick, nhiều lệnh gộp bằng `&&`); `--strict` exit 1 khi còn MUST mở, lệnh kiểm đỏ hoặc miễn trừ thiếu lý do. Dùng làm cổng phát hành (G7): `--strict --run`.

## audit (dự án có sẵn, hoặc định kỳ)
1. Với từng mục `[ ]`: **grep cổng đang chạy** (CI, hook, config, test) — không tin README. Có bằng chứng → `[x]` kèm `— Kiểm: `<lệnh>`` chạy lại được (`blueprint-status --run` kiểm), không có lệnh thì `— Bằng chứng: <file:dòng|URL job CI>`; không áp dụng → `[~] — Không áp dụng: <điều kiện>`; có áp dụng mà bỏ/hoãn → `[~] — Miễn: <lý do>` (MUST thêm `Duyệt: "<lời chủ dự án>" <ngày>` hoặc link, `LOOP-STOP-024`); còn lại giữ `[ ]`.
2. Xuất báo cáo: bảng mục MUST mở → đề xuất task (mỗi task có Gate máy kiểm) → đưa vào PLAN.md.
3. Phân loại bằng chứng: *đo được* / *suy luận* / *chưa biết* — không trình bày suy luận như đo được.

## Ghép lại khi khung cập nhật
Chạy lại đúng lệnh `<XT> compose ... --out BLUEPRINT.md`: máy giữ trạng thái + ghi chú `— Kiểm/Bằng chứng/Miễn/Không áp dụng/Thiếu:` theo **ID**, mục mới vào ở `[ ]`. Đổi quy mô thì mục chuyển giữa hai file theo ID, giữ trạng thái. Xem `git diff BLUEPRINT.md BLUEPRINT-BACKLOG.md` trước khi commit.
