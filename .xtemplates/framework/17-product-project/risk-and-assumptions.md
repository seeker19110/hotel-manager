---
title: Rủi ro & giả định: sổ rủi ro, spike, kế hoạch B
kind: module
prefix: PM-RISK
applies_to: [all]
updated: 2026-10-14
---

# Rủi ro & giả định: sổ rủi ro, spike, kế hoạch B

> Mọi dự án đứng trên các giả định; module này biến giả định thành **sổ rủi ro có chủ, có biện pháp, có hạn**,
> kiểm chứng giả định nguy hiểm nhất bằng **spike có hộp thời gian**, và chuẩn bị **kế hoạch B** cho rủi ro không
> loại được — kể cả rủi ro từ phụ thuộc bên thứ ba, license và pháp lý. Threat model (rủi ro bảo mật) ở
> [`../12-security/threat-modeling.md`](../12-security/threat-modeling.md); module này chỉ trỏ tới.

## Nguyên tắc

1. **Giả định chưa kiểm = rủi ro.** Mỗi giả định trong `PROJECT.md` có một dòng trong sổ rủi ro cho tới khi được chứng minh.
2. **Kiểm cái đáng sợ nhất trước.** Xếp theo (xác suất × ảnh hưởng); giả định đứng đầu được spike ngay trong lát đầu tiên, không để tới G6.
3. **Spike là thí nghiệm, không phải sản phẩm.** Có câu hỏi cụ thể, hộp thời gian, tiêu chí trả lời được/không; code spike không merge vào nhánh chính — kết quả đi vào ADR hoặc spec.
4. **Mỗi rủi ro có một chủ và một dấu hiệu kích hoạt (trigger).** Không có chủ thì không ai nhìn; không có trigger thì không biết khi nào bật kế hoạch B.
5. **Phụ thuộc bên ngoài là rủi ro mặc định**: license, vòng đời (EOL), telemetry, lock-in, SLA, repo bị archive — tra trước khi cài ([`../00-method/evidence-and-sources.md`](../00-method/evidence-and-sources.md) luật 7).
6. **Rủi ro pháp lý thuộc G0–G2**, không phải G7: dữ liệu cá nhân, ngành bị quản lý, AI — xem [`../16-compliance-privacy/README.md`](../16-compliance-privacy/README.md).
7. **Sổ rủi ro sống**: rà tại mỗi cổng; rủi ro đã xảy ra chuyển thành sự cố/bài học ([`../15-operations/incident-response.md`](../15-operations/incident-response.md)), và tạo hàng rào mới (P12).

## Quyết định

| Loại chưa chắc | Công cụ | Đầu ra | Không dùng khi |
|---|---|---|---|
| Kỹ thuật: "thư viện X làm được việc Y với dữ liệu của ta không?" | **Spike** 0,5–2 ngày, nhánh `spike/…`, code bỏ đi | Câu trả lời có/không + số đo → ADR | Câu trả lời tra được trong tài liệu chính thức — tra, không spike |
| Thị trường: "người dùng có cần Y không?" | Phỏng vấn / prototype không code / landing page đo | Số liệu → `PROJECT.md` | Đã có dữ liệu sử dụng thật |
| Kiến trúc: hai phương án đánh đổi lớn | Spike so sánh có cùng tiêu chí + **ADR** | ADR có "Pros and Cons of the Options" | Chỉ một phương án hợp ràng buộc |
| Phụ thuộc bên thứ ba | Bảng thẩm định: license OSI? EOL? telemetry? archived? SLA? xuất dữ liệu được? | Dòng trong sổ rủi ro + kế hoạch thoát | — |
| Pháp lý / tuân thủ | Danh sách luật áp dụng (số hiệu + ngày hiệu lực) + DPIA nếu có dữ liệu cá nhân | Mục "Khung pháp lý" + [`../templates/DPIA.md`](../templates/DPIA.md) | Không xử lý dữ liệu cá nhân và không thuộc ngành quản lý — ghi rõ "không áp dụng" có lý do |

**Cách ứng xử với rủi ro** (chọn một, ghi vào sổ): *tránh* (đổi cách làm) · *giảm* (biện pháp + trigger) · *chuyển* (bảo hiểm, nhà cung cấp có SLA) · *chấp nhận* (ghi tên người chấp nhận + ngày).

## Checklist

- [ ] `PM-RISK-001` **MUST** Có sổ rủi ro (`docs/RISKS.md` hoặc mục trong `PROJECT.md`) với cột: ID `RK-NNN` · mô tả · xác suất · ảnh hưởng · chủ · cách ứng xử · biện pháp · trigger · trạng thái · ngày rà. → Kiểm: `rg -n "^\| RK-[0-9]{3}" docs/RISKS.md PROJECT.md` ≥1; mỗi dòng đủ cột.
- [ ] `PM-RISK-002` **MUST@L** Mỗi giả định trong `PROJECT.md` ánh xạ tới một `RK-NNN` hoặc được đánh dấu "đã kiểm chứng" kèm bằng chứng (link spike/dữ liệu). → Kiểm: bảng giả định có cột "RK / bằng chứng" không rỗng.
- [ ] `PM-RISK-003` **MUST** Rủi ro xếp đầu (xác suất × ảnh hưởng cao nhất) có spike hoặc biện pháp bắt đầu trong lát dọc đầu tiên. → Kiểm: `PLAN.md` có task tham chiếu `RK-NNN` đứng đầu trong nhóm task đầu.
- [ ] `PM-RISK-004` **MUST@L** Mỗi spike có: câu hỏi một dòng, hộp thời gian, tiêu chí trả lời, kết quả ghi lại (ADR/spec/`PROGRESS.md`); code spike không merge vào nhánh chính. → Kiểm: issue/ghi chú spike đủ 4 mục; `git log main --grep="spike"` không có commit merge nhánh `spike/`.
- [ ] `PM-RISK-005` **MUST@L** Rủi ro mức cao có kế hoạch B ghi rõ: trigger cụ thể, hành động, ai quyết, chi phí ước lượng. → Kiểm: cột "Kế hoạch B" không rỗng cho mọi dòng mức cao.
- [ ] `PM-RISK-006` **MUST** Mỗi phụ thuộc bên thứ ba quan trọng (SaaS, API, thư viện lõi, model AI) có dòng thẩm định: license (OSI hay không), ngày EOL/phiên bản hỗ trợ, telemetry mặc định, cách xuất dữ liệu/thoát. → Kiểm: bảng "Phụ thuộc" trong `docs/RISKS.md`; license tự động ở [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md); EOL tra `https://endoflife.date/api/<product>.json`.
- [ ] `PM-RISK-007` **MUST** Danh sách luật áp dụng (số hiệu đầy đủ + ngày hiệu lực + URL + "kiểm tra văn bản sửa đổi") lập ở G2; dự án có dữ liệu cá nhân có DPIA theo [`../templates/DPIA.md`](../templates/DPIA.md). → Kiểm: mục "Khung pháp lý" trong `PROJECT.md`; `docs/DPIA.md` tồn tại khi `PM-REQ-009` = có.
- [ ] `PM-RISK-008` **MUST@L** Sổ rủi ro được rà tại mỗi cổng G1–G7 (ngày rà cập nhật); rủi ro đã xảy ra chuyển thành sự cố và tạo ≥1 hàng rào mới. → Kiểm: cột "ngày rà" ≥ ngày cổng gần nhất; post-mortem liên kết `RK-NNN`.
- [ ] `PM-RISK-009` **SHOULD** Rủi ro bảo mật không ghi lặp trong sổ này mà trỏ tới threat model; sổ chỉ giữ dòng tổng "xem THREAT-MODEL #id". → Kiểm: dòng rủi ro bảo mật có link `docs/THREAT-MODEL.md`.
- [ ] `PM-RISK-010` **SHOULD** Rủi ro con người: bus factor ≥2 cho mỗi thành phần sống còn (có người thứ hai đọc được code và chạy được runbook). → Kiểm: bảng "Thành phần → người biết" trong `docs/RISKS.md` không có dòng chỉ 1 tên khi dự án ≥ M.
- [ ] `PM-RISK-011` **SHOULD** Pre-mortem trước cổng G1: "giả sử dự án thất bại sau 6 tháng, vì sao?" — mỗi lý do thành một dòng sổ rủi ro. → Kiểm: mục "Pre-mortem" có ngày và ≥3 dòng được chuyển thành `RK-NNN`.
- [ ] `PM-RISK-012` **SHOULD** Rủi ro chi phí vận hành (hạ tầng, API trả theo lượt, model AI) có ước lượng theo khoảng và ngưỡng cảnh báo; chi tiết ở [`../15-operations/cost-management.md`](../15-operations/cost-management.md). → Kiểm: dòng `RK` chi phí có số P50/P90 và link cảnh báo ngân sách.
- [ ] `PM-RISK-013` **SHOULD** Trước khi cài công cụ/skill/plugin từ ngoài: đọc script cài và hook, kiểm repo còn hoạt động (không archive/đổi tên), ghim phiên bản. → Kiểm: lockfile/ghim SHA; ghi chú "đã đọc `install.sh` ngày …" trong PR thêm phụ thuộc.
- [ ] `PM-RISK-014` **SHOULD** Rủi ro "benchmark tự công bố" của nhà cung cấp: không dùng làm căn cứ chọn khi chưa tái lập trên dữ liệu của mình. → Kiểm: ADR chọn công nghệ có mục "số đo của ta" hoặc ghi "chưa tái lập".
- [ ] `PM-RISK-015` **MAY** Mô phỏng Monte Carlo cho lịch dựa trên throughput lịch sử (xem `PM-PLAN`) để ra xác suất kịp hạn thay vì một ngày duy nhất. → Kiểm: biểu đồ/ bảng P50/P85 trong `PLAN.md`.
- [ ] `PM-RISK-016` **MAY** Diễn tập kế hoạch B cho rủi ro cao nhất (vd nhà cung cấp API ngừng dịch vụ) ít nhất một lần trước G7. → Kiểm: ghi chú diễn tập có ngày + kết quả.

## Bẫy thường gặp

| Bẫy | Dấu hiệu | Cách tránh |
|---|---|---|
| Sổ rủi ro viết một lần rồi quên | Ngày rà = ngày lập | Rà tại mỗi cổng (`PM-RISK-008`); CI nhắc khi ngày rà cũ hơn 30 ngày |
| Spike không hộp thời gian | Spike thành tính năng nửa vời trên nhánh chính | Nhánh `spike/`, hạn cứng, kết quả là văn bản, code bỏ đi |
| Rủi ro không có chủ | "Cả đội chịu trách nhiệm" | Một tên cho mỗi dòng; dự án một người thì tên vẫn ghi |
| Kế hoạch B không có trigger | Biết có rủi ro nhưng không biết khi nào bật | Trigger đo được: số lỗi, ngày, thông báo EOL |
| Tin "free/open" theo trang chủ | License không OSI, telemetry bật mặc định | Ba câu hỏi trước khi tin "free" (catalog 05); đọc LICENSE và `install.sh` |
| Phụ thuộc repo đã archive | Vendor từ repo không còn bảo trì, ADR ghi URL cũ | Kiểm trạng thái repo khi thêm và định kỳ (catalog 23 §8: `gsd-build` archive, URL đổi) |
| Pháp lý "làm sau ra mắt" | DPIA, điều khoản, đồng ý thu thập dữ liệu xuất hiện ở G7 | `PM-RISK-007` ở G2; tuân thủ là Must trong MoSCoW |
| Benchmark của nhà cung cấp làm căn cứ | Chọn model/DB vì bảng so sánh của họ | Luật 11 `evidence-and-sources.md`: tái lập hoặc A/B trên dữ liệu của mình |
| Rủi ro bảo mật ghi hai nơi lệch nhau | Sổ rủi ro và threat model khác mức | Một nhà: threat model; sổ chỉ trỏ |
| Kế hoạch B chưa từng thử | Nhà cung cấp ngừng dịch vụ, mới biết dữ liệu không xuất được | Diễn tập kế hoạch B cho rủi ro cao nhất trước G7 (`PM-RISK-016`); kiểm "xuất dữ liệu" khi thẩm định |

## Cổng tự động

| Việc | Công cụ / lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| Sổ rủi ro đủ cột, ngày rà mới | Script đọc bảng `docs/RISKS.md` (cột bắt buộc, ngày rà ≤ 30 ngày khi dự án ≥ M) | CI hằng tuần | Thiếu cột/cũ → cảnh báo; tại cổng → đỏ |
| License phụ thuộc | `license-checker --onlyAllow "MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC"` (npm, MIT) · `pip-licenses` (MIT) · `go-licenses check ./...` (Apache-2.0) · `cargo deny check licenses` (MIT/Apache-2.0) | CI | 0 license ngoài allowlist; ngoại lệ ghi ADR |
| EOL của runtime/CSDL | `curl -s https://endoflife.date/api/<product>.json` so với phiên bản trong lockfile/Dockerfile | CI hằng tháng | Phiên bản hết hỗ trợ → đỏ |
| Repo phụ thuộc còn sống | `gh api repos/<owner>/<repo> --jq '.archived'` cho phụ thuộc vendor | CI hằng tháng | `true` → mở issue |
| Spike không vào nhánh chính | Ruleset/branch protection: nhánh `spike/*` không được merge; `git log main --merges --grep="spike/"` | CI | 0 merge |
| Phụ thuộc có lỗ hổng/ghim | Xem [`../12-security/supply-chain.md`](../12-security/supply-chain.md) | CI | Theo module đó |

## Nguồn

- Spike solution (XP): khái niệm từ Extreme Programming — (chưa xác minh: không truy cập được <http://www.extremeprogramming.org/rules/spike.html> ngày 2026-10-13, HTTP 503).
- ISO 31000 Risk management — (chưa xác minh: <https://www.iso.org/iso-31000-risk-management.html> trả 403 ngày 2026-10-13); cấu trúc sổ rủi ro ở đây là quy ước của khung, không trích chuẩn.
- MADR 4.0.0 (ADR có "Pros and Cons of the Options", "Confirmation"): <https://adr.github.io/madr/> — xác minh 2026-10-13.
- Kanban Guide 2025.5 — SLE là dự báo có xác suất dựa trên cycle time lịch sử: <https://kanbanguides.org/english/> — xác minh 2026-10-13.
- endoflife.date API: <https://endoflife.date/docs/api> — xác minh qua `research/2026-10-13-stored-catalog-extraction.md` (dùng trong BRIEF §1).
- Khung cũ X-stored `01-process-and-standards.md` GĐ0 "sổ rủi ro: giả định nguy hiểm nhất + cách kiểm chứng", commit `1b80fe4`; `seeker19110/stored` mục 05 (ba câu hỏi trước khi tin "free"), mục 23 §8 (phụ thuộc archive) — đọc 2026-10-13.
