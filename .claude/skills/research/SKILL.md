---
name: research
description: Nghiên cứu trước khi đề xuất (research-first) — xác minh phiên bản, chuẩn, luật, trạng thái repo từ NGUỒN SỐNG và ghi ngày; chọn công nghệ với lý do và phương án thay thế. Dùng ở G2, khi chọn thư viện/dịch vụ mới, khi người dùng hỏi "nên dùng gì", hoặc gõ /research.
argument-hint: "<chủ đề hoặc danh sách công nghệ cần xác minh>"
---

# /research — nghiên cứu trước, đề xuất sau

`<FW>` = `.xtemplates/framework` trong dự án đích, hoặc `framework` trong repo khung. `<XT>` = `python3 .xtemplates/scripts/xt.py` (hoặc `python3 scripts/xt.py`).

Luật: `<FW>/00-method/evidence-and-sources.md` (13 luật). Không chọn theo trí nhớ. Không xác minh được → ghi **(chưa xác minh)**.

## Quy trình
1. **Đặt câu hỏi đúng:** cần gì (năng lực), ràng buộc (giấy phép, chi phí, đội, hạ tầng, pháp lý), quy mô S/M/L, hồ sơ dự án.
2. **Đọc khung trước:** hồ sơ (`<FW>/02-profiles/<slug>.md`) đã có stack mặc định + phiên bản + ngày, chỉ là điểm xuất phát: **luôn xác minh lại trước khi dùng và ghi ngày** (`<FW>/00-method/conventions.md` §6); cái hồ sơ chưa có thì tra mới.
3. **Xác minh sống** (giao subagent `researcher` khi nhiều mục):
   - Phiên bản: `https://registry.npmjs.org/<pkg>/latest`, `https://pypi.org/pypi/<pkg>/json`, `https://endoflife.date/api/<product>.json` (không phải sản phẩm nào cũng có; 404 → tra trang release chính thức), trang release chính thức, `git ls-remote --tags`.
   - Trạng thái repo: archive? đổi tên? license đổi? telemetry mặc định? Đọc `install.sh`/hook trước khi khuyên cài.
   - Chuẩn/luật: trang chuẩn (owasp.org, w3.org, ietf.org), văn bản luật (vanban.chinhphu.vn, eur-lex), số hiệu đầy đủ + ngày hiệu lực.
   - Giấy phép: OSI? SSPL/BSL/ELv2/AGPL → cảnh báo. "Free" hỏi 3 câu: được xuất bản không, dùng thương mại không, xuất dữ liệu ra được không.
   - **Đánh giá nguồn bên thứ ba** (repo/skill/gói; mục "Đánh giá" của PR: `<FW>/12-security/supply-chain.md` `SEC-SUPPLY-027`):
     - "Chính chủ" qua hai phép thử: ai viết (`git log --format='%an %s'`), đúng spec không (chạy linter/validator của spec — phiên chính, trong sandbox; `researcher` chỉ đọc, không chạy mã repo lạ). Một tên nhiều repo → liệt kê hết, nói rõ đã chọn repo nào.
     - License: `git log --follow -- LICENSE*` và cả license tầng dưới (engine/binary tải lúc chạy).
     - Con số tự công bố (số test, cổng, benchmark) → đếm (đọc) hoặc chạy lại trong sandbox, ghi "tuyên bố → tự đo" (chưa chạy: "tuyên bố → chưa tự đo"). Đọc `docs/gaps.md`/known-issues trước README.
     - Huy hiệu `img.shields.io/badge/...` là chữ tĩnh, không phải số đo. Link cùng tham số `?fpr=`/`?pc=`/`?ref=` = danh mục affiliate. Ảnh chụp không phải bằng chứng bền: ghi commit SHA đã đọc.
4. **So sánh theo tiêu chí có trọng số** (đúng › an toàn › ít hơn › kiểm được › nhanh — P3): trưởng thành, cộng đồng/bảo trì, giấy phép, chi phí vận hành, khớp đội, lock-in, bảo mật đã biết. Benchmark tự công bố không phải bằng chứng.
5. **Đề xuất:** mặc định + lý do + 1–2 thay thế + điều kiện đổi; ghi ADR (`/adr`) nếu là quyết định lớn.

## Đầu ra (bảng)
| Thành phần | Chọn | Phiên bản | Nguồn + ngày xác minh | Thay thế | Lý do/điều kiện |
|---|---|---|---|---|---|

Kèm mục **Chưa xác minh** và **Rủi ro giấy phép/trạng thái**.
