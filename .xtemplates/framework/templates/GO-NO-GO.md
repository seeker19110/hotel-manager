---
title: Mẫu GO-NO-GO
kind: template
updated: 2026-10-16
---

# Mẫu GO-NO-GO.md — báo cáo phát hành

> **Ai viết:** AI/người kiểm chạy ở chế độ **report-only** (không deploy, không sửa); **người có thẩm quyền ký** quyết định cuối. **Giai đoạn:** G7 Verify & Release, trước mỗi phát hành production; cũng dùng cho nghiệm thu bàn giao.
> **Cổng dùng:** G7 (`xt.py blueprint-status --strict` = 0 MUST mở, 0 BLOCKER FAIL), `PM-HANDOVER-006`.
> **Luật "Evidence or FAIL":** mỗi mục ghi PASS / FAIL / N/A kèm bằng chứng cụ thể (file:dòng, giá trị cấu hình, output lệnh, link CI); "trông ổn", "framework lo rồi" = FAIL; N/A phải có lý do một dòng. Quét artefact thật (kể cả lịch sử git), không chỉ working tree. Mỗi bằng chứng gắn **nhãn** (`QA-STRAT-012`): `real-path` (chạy thật trên đường thật) · `faithful-fixture` (fixture/adapter giả trung thực, replay) · `asserted-not-measured` (chưa đo — không được tính PASS cho BLOCKER).
> **Mức:** `BLOCKER` — FAIL thì NO-GO; `SHOULD` — được GO nếu có ticket + chủ + hạn; `NICE` — ghi nhận. Thứ tự output cố định: đếm → bảng FAIL → kết luận → chữ ký.

```markdown
# GO/NO-GO — <Tên dự án> · phát hành <phiên bản/tag> · <YYYY-MM-DD>

> Commit: `<SHA>` · Blueprint: `xt.py blueprint-status BLUEPRINT.md --strict` → exit <0/1> (MUST mở: <n>) · CI: <link, xanh/đỏ>
> Người kiểm: <tên/agent> (report-only) · Phạm vi: <web/mobile/API — bỏ phần không áp dụng, ghi lý do>

## 1. Đếm
| Mức | PASS | FAIL | N/A |
|---|---|---|---|
| BLOCKER | | | |
| SHOULD | | | |
| NICE | | | |

## 2. Danh mục kiểm (mỗi dòng có bằng chứng)
| # | Mức | Mục | Kết quả | Nhãn bằng chứng | Bằng chứng (file:dòng / lệnh → output / link) |
|---|---|---|---|---|---|
| 1 | BLOCKER | Build tái lập từ clone sạch, không lỗi type/lint, không cờ giấu lỗi | PASS/FAIL/N/A | real-path/faithful-fixture/asserted | CI job `<tên>` run #<n>; `rg -n "ignoreBuildErrors|continue-on-error" ` → 0 |
| 2 | BLOCKER | Toàn bộ test xanh (unit/integration/E2E luồng chính) | | | run #<n>: <X/Y> |
| 3 | BLOCKER | Blueprint: 0 MUST mở; `[~]` ghi `Không áp dụng: <điều kiện>` hoặc `Miễn:` kèm `Duyệt:` của chủ dự án cho MUST (`LOOP-STOP-024`) | | | `xt.py blueprint-status --strict` exit 0 |
| 4 | BLOCKER | Không secret trong repo và lịch sử git | | | `gitleaks detect --redact` → 0 |
| 5 | BLOCKER | Phụ thuộc: 0 lỗ hổng mức cao chưa xử lý; license trong allowlist | | | `<npm audit / pip-audit / osv-scanner>` output; `license-checker` |
| 6 | BLOCKER | Kiểm quyền phía server cho mọi thao tác nhạy cảm; test "vượt quyền" xanh | | | `tests/auth/*` run #<n> |
| 7 | BLOCKER | Threat model: mọi mối đe doạ mức Cao có biện pháp + bằng chứng | | | docs/THREAT-MODEL.md bảng 4, cột trạng thái |
| 8 | BLOCKER | Migration có đường lùi; rollback deploy đã diễn tập | | | RUNBOOK mục 1; log diễn tập <ngày> |
| 9 | BLOCKER | Backup bật và đã khôi phục thử | | | log khôi phục <ngày>, thời gian <phút> |
| 10 | BLOCKER | Giám sát + cảnh báo đã thử kích hoạt, tới đúng kênh | | | ảnh/log cảnh báo thử <ngày> |
| 11 | BLOCKER | Dữ liệu cá nhân: DPIA (nếu áp dụng), đồng ý trước khi thu thập, chính sách riêng tư/điều khoản công bố | | | docs/DPIA.md trạng thái; E2E không request analytics trước đồng ý |
| 12 | BLOCKER | Hiệu năng đạt ngưỡng hồ sơ (CWV / p95 / thời gian chạy) đo thật | | | Lighthouse CI / k6 báo cáo <link> |
| 13 | BLOCKER | Tiếp cận: 0 vi phạm nghiêm trọng (axe/WCAG AA) trên luồng chính (hồ sơ có UI) | | | báo cáo axe run #<n> |
| 14 | SHOULD | Release notes cho người dùng + CHANGELOG cập nhật | | | docs/RELEASE-NOTES-<v>.md |
| 15 | SHOULD | Runbook được người không xây chạy thử | | | docs/handover/runbook-test-<ngày>.md |
| 16 | SHOULD | Sự kiện đo cho tính năng mới có schema, dashboard baseline ghi | | | analytics/events.schema.json; METRICS.md |
| 17 | SHOULD | Tài liệu khớp code (README, PROJECT, ADR không lỗi thời) | | | review <ngày> |
| 18 | BLOCKER | Mọi đề xuất "Khi chạy thật" (dịch vụ thay phần tự host) đã được chủ dự án quyết: chuyển (khoá/tài khoản đã cấu hình qua secret store) hoặc giữ tự host (có người vận hành, backup) | | | `rg -n "Khi chạy thật" docs/autopilot/DECISIONS.md` → từng D-NNN có quyết định ghi ở mục 4 |
| 19 | NICE | Tối ưu mã nguồn: dead code/dependency thừa đã rà | | | knip/depcheck output |
| 20 | <mức> | <mục đặc thù hồ sơ/ngành> | | | |

## 2b. Bằng chứng chưa chứng minh (bắt buộc ghi, kể cả khi GO)
Những gì cổng xanh **không** chứng minh — để người ký biết mình đang chấp nhận gì:
| Phạm vi | Vì sao chưa chứng minh (adapter giả, chưa có thiết bị/dữ liệu/quy mô thật, chỉ `asserted`) | Kiểm thật khi nào / ai |
|---|---|---|
| <vd: thanh toán qua cổng thật> | <chỉ chạy adapter giả + contract test (`faithful-fixture`)> | <trước khi bật cho khách thật — chủ dự án> |

## 3. Bảng FAIL
| # | Mức | Mục | Bằng chứng | Cách sửa đề xuất | Ticket / chủ / hạn (chỉ SHOULD) |
|---|---|---|---|---|---|

## 4. Kết luận
**GO / NO-GO** — NO-GO nếu bất kỳ BLOCKER = FAIL. Điều kiện kèm theo (SHOULD FAIL có ticket): <...>
Rủi ro còn lại được chấp nhận: <mục — người chấp nhận — ngày>

## 5. Ký (con người, không phải agent)
| Vai trò | Tên | Quyết định | Ngày |
|---|---|---|---|
| Chủ sản phẩm | | GO / NO-GO | |
| Kỹ thuật / vận hành | | | |
| Bảo mật / pháp lý (quy mô L hoặc ngành quản lý) | | | |
```
