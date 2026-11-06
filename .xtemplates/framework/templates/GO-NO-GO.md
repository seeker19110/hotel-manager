---
title: Mẫu GO-NO-GO
kind: template
updated: 2026-11-05
---

# Mẫu GO-NO-GO.md — báo cáo phát hành

> **Ai viết:** AI/người kiểm chạy ở chế độ **report-only** (không deploy, không sửa); **người có thẩm quyền ký** quyết định cuối. **Giai đoạn:** G7 Verify & Release, trước mỗi phát hành production; cũng dùng cho nghiệm thu bàn giao.
> **Cổng dùng:** G7 (`xt.py blueprint-status --strict` = 0 MUST mở, 0 BLOCKER FAIL), `PM-HANDOVER-006`. `release-check` (hàng `go_no_go`) nhận file khi dòng tiêu đề `# ` hoặc đuôi tên file (`-v<VERSION>.md`) ghi đúng phiên bản — không đọc phiên bản ở chỗ khác trong file.
> **Luật "Evidence or FAIL":** mỗi mục ghi PASS / FAIL / N/A kèm bằng chứng cụ thể (file:dòng, giá trị cấu hình, output lệnh, link CI); "trông ổn", "framework lo rồi" = FAIL; N/A phải có lý do một dòng. Quét artefact thật (kể cả lịch sử git), không chỉ working tree. Mỗi bằng chứng gắn **nhãn** (`QA-STRAT-012`): `real-path` (chạy thật trên đường thật) · `faithful-fixture` (fixture/adapter giả trung thực, replay) · `asserted-not-measured` (chưa đo — không được tính PASS cho BLOCKER).
> **Mức:** `BLOCKER` — FAIL thì NO-GO; `SHOULD` — được GO nếu có ticket + chủ + hạn; `NICE` — ghi nhận. Thứ tự output cố định: đếm → bảng FAIL → kết luận → chữ ký.

```markdown
# GO/NO-GO — <Tên dự án> · phát hành v<VERSION> · <YYYY-MM-DD>

> Commit: `<SHA>` · Blueprint: `xt.py blueprint-status BLUEPRINT.md --strict --run` → exit <0/1> (MUST mở: <n>, lệnh kiểm đỏ: <n>, MUST tick không có lệnh kiểm: <n>) · CI: <link, xanh/đỏ>
> Người kiểm: <tên/agent> (report-only) · Phạm vi: <web/mobile/API — bỏ phần không áp dụng, ghi lý do>

## 1. Đếm
> Phần máy: `xt.py release-check --json` (blueprint `--strict --run` · sổ audit `--strict` · kiểm lại cuối · cây git · `attack`/`perf` · cổng production `migration_check`/`acceptance`/`rollback` (ADR-0062) · `go_no_go`: file này nhắc `v<VERSION>` và mục 5 đã ký — chưa ký là BLOCKER chờ người · đề xuất "Khi chạy thật") → dán `verdict` và từng hàng FAIL vào mục 3; NO-GO của máy là NO-GO. Người vẫn ký mục 5. `promotion` (schema 3, ADR-0068): `approved` chỉ khi không FAIL/việc người, mục 5 ký GO (không chữ NO-GO) còn hạn `release_approval_days` và — khi khai `release_artifacts` — file này nhắc 12 ký tự đầu của `subject.digest`.
| Mức | PASS | FAIL | N/A |
|---|---|---|---|
| BLOCKER | | | |
| SHOULD | | | |
| NICE | | | |

## 2. Danh mục kiểm (mỗi dòng có bằng chứng)
> Hai cột tách bạch: **máy đã chạy** = lệnh + exit/output (agent/CI điền); **người đã đọc** = tên + ngày của người đã mở bằng chứng và đọc — máy không điền; để trống = chưa ai đọc (`unchecked_must` của `release-check` chỉ đếm MUST đã tick mà không có lệnh kiểm, không thay chữ ký này).

| # | Mức | Mục | Máy đã chạy: kết quả | Nhãn bằng chứng | Máy đã chạy: bằng chứng (file:dòng / lệnh → output / link) | Người đã đọc (tên · ngày) |
|---|---|---|---|---|---|---|
| 1 | BLOCKER | Build tái lập từ clone sạch, không lỗi type/lint, không cờ giấu lỗi | PASS/FAIL/N/A | real-path/faithful-fixture/asserted | CI job `<tên>` run #<n>; `rg -n "ignoreBuildErrors|continue-on-error" ` → 0 | |
| 2 | BLOCKER | Toàn bộ test xanh (unit/integration/E2E luồng chính) | | | run #<n>: <X/Y> | |
| 3 | BLOCKER | Blueprint: 0 MUST mở; `[~]` ghi `Không áp dụng: <điều kiện>` hoặc `Miễn:` kèm `Duyệt:` của chủ dự án cho MUST (`LOOP-STOP-024`) | | | `xt.py blueprint-status --strict` exit 0 | |
| 4 | BLOCKER | Không secret trong repo và lịch sử git | | | `gitleaks detect --redact` → 0 | |
| 5 | BLOCKER | Phụ thuộc: 0 lỗ hổng mức cao chưa xử lý; license trong allowlist | | | `<npm audit / pip-audit / osv-scanner>` output; `license-checker` | |
| 6 | BLOCKER | Kiểm quyền phía server cho mọi thao tác nhạy cảm; test "vượt quyền" xanh | | | `tests/auth/*` run #<n> | |
| 7 | BLOCKER | Threat model: mọi mối đe doạ mức Cao có biện pháp + bằng chứng | | | docs/THREAT-MODEL.md bảng 4, cột trạng thái | |
| 8 | BLOCKER | Migration có đường lùi; rollback deploy đã diễn tập | | | RUNBOOK mục 1; log diễn tập <ngày> | |
| 9 | BLOCKER | Backup bật và đã khôi phục thử | | | log khôi phục <ngày>, thời gian <phút> | |
| 10 | BLOCKER | Giám sát + cảnh báo đã thử kích hoạt, tới đúng kênh | | | ảnh/log cảnh báo thử <ngày> | |
| 10a | BLOCKER (M/L) · SHOULD (S); chỉ hồ sơ có `OPS-SLO` | SLO dạng file qua CI validate, dịch vụ hướng người dùng (`OPS-SLO-001`); thiếu file SLO = FAIL | | | `docs/ops/SLO.md` + lệnh validate → exit | |
| 10b | BLOCKER (L) · SHOULD (S/M); chỉ hồ sơ có `OPS-SLO` | Error budget hiện tại ghi số (% còn, burn 28/30 ngày, ngày đo) + chính sách error budget; budget âm thì đóng băng tính năng hoặc ngoại lệ có người ký (`OPS-SLO-002`/`OPS-SLO-003`) | | | budget <x %> đo <ngày>; `docs/ops/ERROR-BUDGET-POLICY.md` | |
| 11 | BLOCKER | Dữ liệu cá nhân: DPIA (nếu áp dụng), đồng ý trước khi thu thập, chính sách riêng tư/điều khoản công bố | | | docs/DPIA.md trạng thái; E2E không request analytics trước đồng ý | |
| 12 | BLOCKER | Hiệu năng đạt ngưỡng hồ sơ (CWV / p95 / thời gian chạy) đo thật | | | Lighthouse CI / k6 báo cáo <link> | |
| 13 | BLOCKER | Tiếp cận: 0 vi phạm nghiêm trọng (axe/WCAG AA) trên luồng chính (hồ sơ có UI) | | | báo cáo axe run #<n> | |
| 14 | SHOULD | Release notes cho người dùng + CHANGELOG cập nhật | | | docs/RELEASE-NOTES-<v>.md | |
| 15 | SHOULD | Runbook được người không xây chạy thử | | | docs/handover/runbook-test-<ngày>.md | |
| 16 | SHOULD | Sự kiện đo cho tính năng mới có schema, dashboard baseline ghi | | | analytics/events.schema.json; METRICS.md | |
| 17 | SHOULD | Tài liệu khớp code (README, PROJECT, ADR không lỗi thời) | | | review <ngày> | |
| 18 | BLOCKER | Mọi đề xuất "Khi chạy thật" (dịch vụ thay phần tự host) đã được chủ dự án quyết: chuyển (khoá/tài khoản đã cấu hình qua secret store) hoặc giữ tự host (có người vận hành, backup) | | | `rg -n "Khi chạy thật" docs/autopilot/DECISIONS.md` → từng D-NNN có quyết định ghi ở mục 4 | |
| 19 | NICE | Tối ưu mã nguồn: dead code/dependency thừa đã rà | | | knip/depcheck output | |
| 20 | BLOCKER (M/L) · SHOULD (S) | **Người** đã dùng thử luồng chính trên bản ứng viên và đọc SPEC (ca biên) + `THREAT-MODEL.md` — xác nhận spec, UX, bảo mật một lần tại đây, không ở giữa `/complete` (ADR-0048); máy không điền được | — | real-path | <bản/URL đã thử, ngày> | <tên · ngày — bắt buộc> |
| 21 | <mức> | <mục đặc thù hồ sơ/ngành> | | | | |

## 2b. Bằng chứng chưa chứng minh (bắt buộc ghi, kể cả khi GO)
Những gì cổng xanh **không** chứng minh — để người ký biết mình đang chấp nhận gì:
| Phạm vi | Vì sao chưa chứng minh (adapter giả, chưa có thiết bị/dữ liệu/quy mô thật, chỉ `asserted`) | Kiểm thật khi nào / ai |
|---|---|---|
| <vd: thanh toán qua cổng thật> | <chỉ chạy adapter giả + contract test (`faithful-fixture`)> | <trước khi bật cho khách thật — chủ dự án> |

## 2c. Chế độ delta (bản chỉ tối ưu — ADR-0048)
Bản phát hành **chỉ tối ưu**: chỉ task của `/optimize`, diff không chạm manifest/lockfile/migration/schema/hạ tầng (`git diff --stat`), không đổi hành vi, `docs/autopilot/PERF-LOG.md` có dòng giữ, bộ test tương đương xanh. Giữ dòng 1, 2, 4, 5, 12, 20, §2b (lab đo — field chưa) và mục 1; thay phần còn lại bằng bảng trước/sau từ `PERF-LOG.md` (chỉ số · nguồn `perf`/`FIELD-<ngày>` · trước · sau · `perf compare`); dòng khác ghi "không đổi so với GO/NO-GO <ngày>". `release-check` vẫn chạy đủ; người vẫn ký mục 5. Chạm mục nào ở trên, thêm cache/lưu tạm dữ liệu cá nhân (dòng 11), hoặc đổi hành vi → bảng đầy đủ.

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
