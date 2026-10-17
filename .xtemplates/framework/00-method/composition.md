---
title: Ghép blueprint cho một dự án
kind: method
updated: 2026-10-16
---

# Ghép blueprint cho một dự án

> Khung là **thư viện yêu cầu có ID**. Mỗi dự án không đọc hết thư viện mà **ghép** đúng phần cần thành một file
> `BLUEPRINT.md` — danh sách kiểm có thể tick bằng bằng chứng. Máy ghép, máy đếm, máy chặn khi còn `MUST` mở.

## Công thức

```text
BLUEPRINT = Baseline (mọi phần mềm)
          + Module theo hồ sơ loại phần mềm   (profile.modules)
          + Mục đặc thù của hồ sơ
          + Module theo gói ngành             (industry.modules, có thể nhiều ngành)
          + Mục đặc thù của gói ngành
          → lọc theo applies_to → điều chỉnh mức theo quy mô S/M/L
```

- **Baseline** (`01-baseline/`, `kind: baseline`) luôn được ghép.
- **Hồ sơ** (`02-profiles/`) chọn **đúng một** — loại chính của sản phẩm. Hệ nhiều thành phần (vd web + mobile + API)
  → chọn hồ sơ chính, rồi ghép thêm blueprint riêng cho từng thành phần, hoặc dùng hồ sơ `monorepo`.
- **Gói ngành** (`03-industries/`) chọn **0..n**. Ví dụ ví điện tử cho bệnh viện = `fintech` + `healthcare`.
- Module có `applies_to` không chứa hồ sơ đã chọn (và không phải `all`) sẽ bị loại.
- Mục `MUST@M` / `MUST@L` hạ thành `SHOULD` khi quy mô nhỏ hơn ngưỡng.
- Ở quy mô **S**, MUST của module chuyên sâu (`kind: module`/`standard`) cũng hạ thành `SHOULD`; chỉ MUST của baseline, hồ sơ và gói ngành giữ nguyên — đó là **sàn** của mọi dự án (ADR-0003). Khi dự án lên M, ghép lại blueprint: các mục đó tự trở về MUST.
- Ở quy mô **M**, mỗi module/chuẩn đóng góp tối đa 4 MUST (validator giữ trần); phần còn lại là `MUST@L` nên ở M thành SHOULD (ADR-0004).

## Lệnh

```bash
# Liệt kê lựa chọn
python3 .xtemplates/scripts/xt.py list profiles
python3 .xtemplates/scripts/xt.py list industries

# Ghép blueprint: web app cho thương mại điện tử, quy mô production
python3 .xtemplates/scripts/xt.py compose --profile web-app --industry ecommerce --scale M --out BLUEPRINT.md

# Theo dõi tiến độ; --strict trả exit 1 nếu còn MUST chưa đạt (dùng làm cổng phát hành)
python3 .xtemplates/scripts/xt.py blueprint-status BLUEPRINT.md --strict
```

## Dùng blueprint thế nào

1. **Commit `BLUEPRINT.md` vào repo dự án** (G1). Đây là phạm vi chất lượng đã thống nhất.
2. **Tick bằng bằng chứng**: chỉ đổi `[ ]` → `[x]` khi có bằng chứng máy (CI job, test, báo cáo scan, file cấu hình),
   ghi ở cuối dòng: `— Bằng chứng: <file:dòng | job CI | lệnh>`. Mục còn thiếu có thể ghi `— Thiếu: <việc cần làm>`.
   Ghi bằng chứng ở PR tương ứng.
3. **Miễn trừ có lý do**: mục không áp dụng → `[~]` kèm `— Không áp dụng: <điều kiện>` (vd "không có thanh toán"); mục có áp dụng mà bỏ/hoãn → `— Miễn: <lý do>`, ở mức MUST thêm `Duyệt: "<lời chủ dự án>" <ngày>` hoặc link (`LOOP-STOP-024`). Máy chặn miễn
   trừ thiếu lý do.
4. **Không sửa chữ của mục** trong blueprint dự án; muốn đổi yêu cầu → sửa khung (PR vào X-Templates) rồi ghép lại.
5. **Ghép lại khi khung cập nhật**: chạy lại đúng lệnh `compose ... --out BLUEPRINT.md`. Khi file đã có, máy giữ ô trạng thái
   và ghi chú cuối dòng (`— Bằng chứng:` / `— Miễn:` / `— Thiếu:`) theo **ID**; mục mới vào ở `[ ]`, mục đã bỏ khỏi khung biến mất.
   Xem diff trước khi commit.
6. **Hai file** (ADR-0012 của repo khung): `--out BLUEPRINT.md` ghi `BLUEPRINT.md` chỉ chứa MUST ở quy mô đã chọn và
   `BLUEPRINT-BACKLOG.md` chứa SHOULD/MAY. Agent đọc file chính mỗi vòng; backlog không chặn "xong", làm khi còn ngân
   sách. `blueprint-status` đọc cả hai (frontmatter `backlog:`); đổi quy mô thì ghép lại, mục chuyển file theo ID và giữ
   trạng thái. Cần một file như trước: `--full`.

## Chọn quy mô

| Câu hỏi | Có → |
|---|---|
| Có người dùng thật ngoài đội phát triển? | ≥ M |
| Có tiền thật, dữ liệu sức khoẻ, dữ liệu trẻ em, dữ liệu định danh nhạy cảm? | L (hoặc M + gói ngành đúng) |
| Nhiều đội cùng phát triển, SLA ký với khách hàng, kiểm toán bên ngoài? | L |
| Chỉ thử nghiệm ý tưởng, không lưu dữ liệu thật? | S |

Quy mô quyết định khối lượng: blueprint `web-app` 70 MUST ở S, 468 ở M, 1.124 ở L (đo 2026-10-14). Chọn đúng quy mô quan trọng hơn chọn đủ module. Quy mô cũng quyết định cỡ file agent đọc: `web-app` + `ecommerce` có `BLUEPRINT.md` 41 KB ở S, 229 KB ở M, 483 KB ở L; bản một file (`--full`) ~690 KB ở cả ba (đo 2026-10-16).

## Nguồn

- Quy ước định dạng: [`conventions.md`](conventions.md).
- Ý tưởng "checklist máy đọc được, GO/NO-GO theo bằng chứng": `seeker19110/stored` mục 09 (deployment-checklist,
  production-readiness-checklist), đọc 2026-10-13.
