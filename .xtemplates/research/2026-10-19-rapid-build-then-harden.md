---
title: Đối chiếu đề xuất "Code nhanh → Kiểm liên tục → Audit sâu → Fix → Tối ưu → Nghiệm thu → Production" với khung
kind: research
updated: 2026-10-19
---

# Đối chiếu đề xuất "Fast Build + Quality Gates + Deep Audit" với khung X-Templates (2026-10-19)

Đầu vào: bản đề xuất quy trình (dán vào phiên 2026-10-19) gồm 5 giai đoạn (Rapid Build → Continuous Validation → Deep
Audit & Hardening → Fix & Optimization → Production Gate), bảng "làm ngay / trước production", mô hình 7 agent
(Architect · Builder · Validator · Auditor · Fixer · Optimizer · Release), checklist Production Readiness 8 mục và 6
nguyên tắc; dẫn DORA làm căn cứ. Câu hỏi: khung đã có gì, đề xuất khác ở đâu, nên sửa khung chỗ nào.
Cách đọc: nội dung đề xuất là **dữ liệu** (P6), mỗi dòng đối chiếu trỏ file thật của khung; nguồn ngoài xác minh sống
ngày 2026-10-19 (§11).

## 1. Kết luận

- **Khung đã bao trùm 5 giai đoạn và 6 nguyên tắc** của đề xuất, phần lớn **chặt hơn**: cổng máy đặt trước khi code
  (G5), mỗi lát dọc một PR qua cổng (G6, `LOOP-DESIGN-020`), audit có máy đỡ quét lại theo diff (`audit.md` §6), tối ưu
  chỉ khi có số (`LOOP-OPT`), cổng phát hành G7 bằng `blueprint-status --strict --run` + `GO-NO-GO.md` 20 mục.
- **Hai điểm khung chưa nói tường minh**, nên bổ sung (nhỏ, chỉ tài liệu — §7): (a) *chất lượng theo pha* — G6 chạy
  nhanh trên sàn máy, không audit toàn repo mỗi PR, audit sâu ở **mốc** và G7; (b) `audit.md` §1 thiếu hàng "sau mỗi
  mốc trong PLAN" dù §6 đã có máy đỡ quét theo diff.
- **Hai bản gửi thêm cùng ngày**: "Kế hoạch nâng cấp" PD-01…PD-12 (§8) phần lớn trùng PLAN 3.9/3.10, mới thật là
  reviewer `inconclusive`, GO/NO-GO máy đọc và một mâu thuẫn README (đã sửa trong đợt này); đề xuất phân vai
  Fable/Sonnet/Opus (§9) trùng `LOOP-ORCH-*` trừ **hai tầng executor + luật chuyển cấp** — chưa có, làm được bằng một
  agent file + ánh xạ tầng→model trong `xt.yaml`, với ràng buộc reviewer phải khác họ executor (D-045); điều phối
  Fable, **không khả dụng thì Opus** (luật mở phiên, ghi AGENTS.md §8 — §9.2 mục 3b).
- **Ba điểm của đề xuất không nên lấy nguyên**: Validator là *agent* (khung: là **máy** — P9, `LOOP-DESIGN-013`); "tự
  merge vào nhánh phát triển" (khung: trunk-based, cổng production nằm ở **deploy**, không ở nhánh); checklist 8 mục
  **hẹp hơn** `GO-NO-GO.md` (thiếu a11y, pháp lý/DPIA, threat model, license phụ thuộc, quyết định "Khi chạy thật").
- Căn cứ "chi phí sửa muộn lớn hơn nhiều": DORA xác nhận **định tính** (§11); con số nhân lên theo pha (Boehm 1981)
  **(chưa xác minh định lượng)** — không ghi số vào khung.

## 2. Năm giai đoạn ↔ vòng đời G0–G8 và autopilot

| Giai đoạn đề xuất | Khung | Cột | Ghi chú |
|---|---|---|---|
| 1 Rapid Build — "code nhanh, đủ tính năng và luồng nghiệp vụ" | G5 Scaffold (CI + cổng commit chạy **trước** tính năng, [`lifecycle.md`](../framework/00-method/lifecycle.md)) → G6 Build theo **lát dọc**, mỗi lát một PR mở ngay khi Gate xanh (`LOOP-DESIGN-020`, ADR-0014); PLAN mẫu bắt đầu bằng walking skeleton ([`templates/PLAN.md`](../framework/templates/PLAN.md)) | **có và chặt hơn** | Khung không cho "đủ tính năng rồi mới kiểm": mỗi lát phải qua Gate + PR trước lát sau. Đề xuất cũng nói kiểm theo từng phần, nên không mâu thuẫn — chỉ cần nói rõ "nhanh" nghĩa là *không audit toàn repo mỗi lát*, không phải *bỏ cổng lát* |
| 2 Continuous Validation — lint/typecheck/test/build/bảo mật cơ bản theo từng phần | Năm cổng chuẩn trong `xt.yaml`, `dev-task.sh gate` trước commit, CI lặp lại required check ([`quality-gates.md`](../framework/01-baseline/quality-gates.md) `BASE-GATE-001…008`); `gitleaks`, `dep-audit` là required check; Gate từng task qua `loop record` (`LOOP-DESIGN-003`); Gate rỗng/`Ran 0 tests` là đỏ (ADR-0011, REC-01) | **có và sâu hơn** | — |
| 3 Deep Audit & Hardening — kiến trúc, bảo mật, dữ liệu, nghiệp vụ, chịu lỗi | 13 nhóm có máy đỡ (`xt.py audit plan/check`), xác minh đối kháng 🔴/🟠 bằng reviewer khác model, `audit check --strict` = Definition of Complete ([`audit.md`](../framework/00-method/audit.md), ADR-0005) | **có và sâu hơn** | Thiếu hàng "sau mỗi mốc" ở bảng *Khi nào audit* (§7a) |
| 4 Fix & Optimization — sửa theo mức, refactor chọn lọc, tối ưu tốc độ/tài nguyên/UI | Audit §5 bước 6–7: sửa theo đợt ≤ 1 PR, 🔴 trước, bug có test tái hiện trước khi sửa; tối ưu chỉ khi có mục tiêu số, bộ đo khoá, máy quyết giữ/hoàn tác ([`optimization-loop.md`](../framework/11-autonomous-loop/optimization-loop.md)); cổng UI `contrast`/`verify-render` | **có và sâu hơn** | Khung còn chặn gian lận số đo (`perf guard`) — đề xuất không có |
| 5 Production Gate — staging, E2E, tải, rollback, giám sát | G7: `blueprint-status --strict --run` 0 MUST mở + [`GO-NO-GO.md`](../framework/templates/GO-NO-GO.md) 20 mục (BLOCKER/SHOULD/NICE, nhãn bằng chứng, người ký); staging/preview ([`environments-and-config.md`](../framework/10-workflow/environments-and-config.md)), smoke sau deploy `WF-REL-007`/`QA-STRAT-011`, load test trên staging `QA-PERF-007`, backup đã khôi phục thử (G8 + GO-NO-GO #9) | **có và sâu hơn** | — |
| "Kiểm thử nghiệm thu" (acceptance) | G3 tiêu chí chấp nhận Given/When/Then; `GO-NO-GO.md` dùng cho nghiệm thu bàn giao (`PM-HANDOVER-006`) | **có** | — |

## 3. Bảng "làm ngay / trước production" ↔ khung

| Hạng mục | Đề xuất: khi code nhanh → trước production | Khung | Cột |
|---|---|---|---|
| Tính năng chính | hoàn thiện sớm → kiểm thử toàn bộ | Lát dọc có Gate; G7 E2E luồng chính | có |
| Kiến trúc | thiết kế nền đúng → audit, refactor | G4 Design (C4, schema, hợp đồng API, threat model) trước G6; audit nhóm ARCH | có |
| UI/UX | đủ dùng → hoàn thiện | `UX-*` theo quy mô; cổng `contrast`/`verify-render`; `LOOP-DESIGN-021` đo/chưa đo | có |
| Unit test | logic quan trọng → mở rộng theo rủi ro | [`test-strategy.md`](../framework/14-testing-quality/test-strategy.md) theo rủi ro; coverage **ratchet** không phải ngưỡng giả (`BASE-GATE-013`) | có |
| Bảo mật | nền tảng bắt buộc → pentest/audit sâu | `security-minimum` MUST ở mọi quy mô; threat model ≥ M; audit SEC; review bảo mật độc lập ở L | có |
| Hiệu năng | tránh lỗi rõ → đo và tối ưu | `XC-PERF-001` mục tiêu số; `LOOP-OPT` không số thì không tối ưu | có |
| Database | schema + migration chuẩn → toàn vẹn, backup/restore | `09-database` migration có đường lùi; backup khôi phục thử là cổng G8 và GO-NO-GO #9 | có |
| CI/CD | chạy từ đầu → chặn release | G5 "CI xanh trên commit rỗng tính năng"; required check; environment gate cho prod ([`ci-cd-pipeline.md`](../framework/10-workflow/ci-cd-pipeline.md)) | có |
| "Không trì hoãn: phân quyền, secret, thiết kế dữ liệu, xác thực, rollback" | — | `BASE-SEC`/`BASE-CFG`/`BASE-DATA` là MUST sàn ở quy mô S (ADR-0003); auth/mật mã/bí mật là ngoại lệ cứng khi merge (ADR-0016) | có và chặt hơn |

## 4. Bảy agent ↔ cơ chế khung

| Agent đề xuất | Cơ chế khung | Cột | Ghi chú |
|---|---|---|---|
| Architect (ban đầu) | Phiên chính ở G0–G4, tự duyệt PLAN (ADR-0008) | có | Khung **không** tách Architect thành subagent: quyết định kiến trúc cần toàn cảnh ([`orchestration-and-subagents.md`](../framework/11-autonomous-loop/orchestration-and-subagents.md)) |
| Builder (liên tục) | `executor` theo spec kín + Gate; phiên chính làm việc < 10 phút | có | — |
| Validator (mỗi thay đổi) | **Máy**: `dev-task.sh gate`, CI, `loop record`, Stop hook đọc bằng chứng | có, **khác bản chất** | P9/`LOOP-DESIGN-013`: người chấm là lệnh, không phải model. Agent "Validator" chỉ sinh lời khai |
| Auditor (sau mỗi milestone) | `/audit` + `reviewer` khác model xác minh đối kháng | có | Thiếu nhịp "mỗi mốc" ở tài liệu (§7a) |
| Fixer (sau audit) | Audit §5 bước 6–7 (sửa theo đợt, test tái hiện trước); `self-healing-ci.md` cho CI đỏ | có | — |
| Optimizer (khi ổn định) | `LOOP-OPT` trước G7, chỉ khi có số | có | — |
| Release Agent (cuối) | `GO-NO-GO.md` viết ở chế độ report-only; **người ký**; "agent may act up to the production gate and cannot pass it" (nguồn `LOOP-DESIGN-019`) | có | — |
| "Không chạy cả bảy cùng lúc; một Builder chính; tránh sửa cùng chỗ" | Một điều phối viên, ≤ 5 subagent, song song chỉ khi độc lập về file, không lồng (`LOOP-ORCH`) | có và cụ thể hơn | — |

## 5. Checklist Production Readiness 8 mục ↔ `GO-NO-GO.md`

| Mục đề xuất | GO-NO-GO / cổng khung |
|---|---|
| Tính năng bắt buộc hoạt động đúng | #2 test xanh (unit/integration/E2E luồng chính), #3 blueprint 0 MUST mở |
| CI, build, typecheck, test đạt | #1 build tái lập, không cờ giấu lỗi; `BASE-GATE-007` required check |
| Không còn Critical/High chưa xử lý/chấp nhận | #5 phụ thuộc 0 lỗ hổng cao; `audit check --strict` (0 🔴/🟠 mở, `chấp nhận` có chủ + hạn) |
| Xác thực, phân quyền, secrets, dữ liệu | #4 không secret trong lịch sử git, #6 kiểm quyền server + test vượt quyền, #7 threat model, #11 dữ liệu cá nhân |
| E2E luồng nghiệp vụ quan trọng | #2; `QA-E2E-*` |
| Hiệu năng theo yêu cầu thực | #12 đo thật (Lighthouse CI / k6) |
| Backup, restore, rollback đã thử | #8 migration có đường lùi + rollback diễn tập, #9 backup khôi phục thử |
| Staging đạt + logging/monitoring | #10 cảnh báo thử kích hoạt tới đúng kênh; smoke sau deploy `WF-REL-007`; `WF-ENV-*` |
| *(không có trong đề xuất)* | #13 a11y, #11 DPIA/đồng ý, #5 license allowlist, #18 quyết định "Khi chạy thật" của chủ dự án, §2b "bằng chứng chưa chứng minh", ký bởi người |

Ghi chú của đề xuất "checklist tự đánh giá, mỗi mục cần bằng chứng" trùng luật **Evidence or FAIL** của GO-NO-GO
(nhãn `real-path` / `faithful-fixture` / `asserted-not-measured`; `asserted` không được tính PASS cho BLOCKER).

## 6. Sáu nguyên tắc ↔ khung

| Nguyên tắc đề xuất | Khung | Cột |
|---|---|---|
| Dev ưu tiên tốc độ, production ưu tiên tin cậy | P3 là thứ tự **đánh đổi** (đúng › an toàn › ít hơn › kiểm được › nhanh), S/M/L là theo **quy mô**; chưa có câu nào nói chất lượng **theo pha** của cùng một dự án | **có ngầm, chưa tường minh** (§7b) |
| Không làm đẹp/tối ưu quá sớm | `LOOP-OPT` bước 1 "không số thì không tối ưu"; UI "đủ tốt" theo MUST quy mô | có |
| Không audit toàn repo sau mỗi sửa nhỏ | `audit.md` §1 định kỳ (quý / ~50 PR), §6 quét lại theo diff từ SHA đã quét | có |
| Không bỏ qua lỗi nền tảng (dữ liệu, bảo mật) | 🔴 chặn phát hành; `BASE-SEC`/`BASE-DATA` MUST sàn; ngoại lệ cứng khi merge | có |
| Audit theo thay đổi và mốc, toàn diện trước release | §6 theo thay đổi; G7 `--strict`; **"mốc" chưa có trong bảng §1** | có một phần (§7a) |
| Không ép coverage 100 % máy móc; ưu tiên vùng rủi ro | [`coverage-and-mutation.md`](../framework/14-testing-quality/coverage-and-mutation.md) bẫy "mục tiêu 100 % toàn repo"; ratchet + mutation vùng quan trọng. Repo khung tự đặt 100 % dòng + nhánh cho `xt.py` là lựa chọn riêng của công cụ stdlib (PROGRESS "Giữ cổng"), không phải mặc định cho dự án đích | có |
| Tự merge vào nhánh phát triển khi CI đạt, cổng riêng trước production | Khung **trunk-based** ([`git-and-branching.md`](../framework/10-workflow/git-and-branching.md)): merge theo làn vào `main` ở L3 (ADR-0024/0025), cổng production là **environment gate khi deploy** + G7, không phải nhánh `develop` (nhánh `develop` dài chỉ khi phát hành nhiều bản song song, ghi ADR) | có, **khác mô hình nhánh** |

## 7. Việc nên làm với khung (đề xuất, chưa làm trong đợt này)

> Cập nhật cùng ngày: (a), (b) ở đây, §8 mục reviewer `inconclusive` + GO/NO-GO máy đọc, và §9.2 mục 1–5 đã triển khai
> trong cùng nhánh — ADR-0029, D-075…D-078 (xem CHANGELOG Unreleased). Còn chờ số: `delivery_phase`, PD-05, PD-09.

- **(a) `framework/00-method/audit.md` §1** thêm hàng: *Sau mỗi mốc trong `PLAN.md` (nhóm lát, bản phát hành con) khi
  chạy autopilot* — phạm vi: nhóm mà `audit plan --status` suy ra từ diff kể từ SHA mốc trước (§6), không toàn bộ;
  kết quả 🔴/🟠 thành task mới trong PLAN trước khi sang mốc kế. Máy đỡ đã có, chỉ thiếu nhịp trong tài liệu và trong
  giao thức autopilot ([`11-autonomous-loop/README.md`](../framework/11-autonomous-loop/README.md) bước 11, giữa "lát
  xong → PR" và "kết thúc"). `PLAN.md` mẫu hiện có "Lát", chưa có khái niệm "mốc" — có thể định nghĩa mốc = nhóm lát
  ghi ở mục "Thứ tự & lý do", không đổi parser.
- **(b) `framework/00-method/lifecycle.md` "Quy tắc chung của cổng"** thêm một mục: *Chất lượng theo pha* — G5 đặt
  sàn máy (năm cổng + bảo mật/cấu hình/dữ liệu sàn); G6 chạy nhanh **trên** sàn đó (cổng commit, PR mỗi lát, review
  theo làn), không audit toàn repo mỗi PR, không tối ưu không số; audit sâu ở mốc và toàn diện ở G7; chỉ G7 mới đòi
  E2E đầy đủ, tải, diễn tập rollback. Mục này gom các luật đã rải rác ở `audit.md`, `LOOP-OPT`, `LOOP-DESIGN-020`,
  không tạo yêu cầu mới (một chủ đề một nhà: chỉ liên kết).
- **(c) Không lấy**: Validator dạng agent; mô hình nhánh `develop`; checklist 8 mục thay cho `GO-NO-GO.md`; con số
  "chi phí sửa muộn" chưa xác minh.
- Cả (a) và (b) là sửa tài liệu phương pháp (không đổi ID, không đổi công cụ) → một PR nhỏ, cập nhật `updated` và
  `CHANGELOG.md` mục Unreleased; có thể gộp vào đợt 3.9 (`docs/autopilot/PLAN-3.9-automation.md`) hoặc đi riêng.

## 8. Đối chiếu bản "Kế hoạch nâng cấp X-Templates" (PD-01…PD-12, gửi thêm 2026-10-19)

Bản này (38 KB, tự ghi "ĐỀ XUẤT — chưa triển khai", đọc khung ở `7ac3d80`) là phiên bản chi tiết của đề xuất ở §1–§6 và đã
tự nhận ra phần lớn cơ chế khung đã có (mục 2 của bản). Đối chiếu từng lát PD với khung và PLAN 3.9/3.10:

| PD | Nội dung | Khung / PLAN 3.9–3.10 đã có | Đánh giá |
|---|---|---|---|
| PD-01 baseline + corpus hồi quy | `loop stats` (`LOOP-DESIGN-024`), T-1521 `autonomy-bench` (corpus xanh giả), `LOOP-DESIGN-016` baseline DORA | **trùng** T-1521 phần corpus; phần "thời gian từng gate" chưa ai đo — số đo đầu tiên ở §10 |
| PD-02 ADR + hợp đồng chiều (`delivery_phase`, `gate_scope`, `target_environment`, `release_authorization`) | `scale` + `gate_floor` trong `scope` của state (T-1503); `- grant:` production (ADR-0022); môi trường `WF-ENV-*`; GO-NO-GO ký bởi người | `delivery_phase` là **mới**; dù bản nói "không phải vòng đời thứ hai", thêm biến pha vào state là chi phí schema/migration/tài liệu cho mọi dự án đích. Tối thiểu đủ dùng: "mốc" trong PLAN + hàng audit (§7a) + câu "chất lượng theo pha" (§7b); chỉ thêm biến pha khi PD-01 cho thấy cần |
| PD-03 scope + yêu cầu theo thời hạn | T-1503/T-1505/T-1519; MUST sàn S vs `MUST@M` (ADR-0003/0004) | **trùng**; "phải đạt ngay / trước release" hiện phân theo quy mô, chưa theo thời gian — cùng kết luận §6 |
| PD-04 trạng thái loop theo giai đoạn | `done` đã đòi blueprint 0 MUST + mọi `— Kiểm:` xanh (`LOOP-DESIGN-022/023`) → `done` ≈ "sẵn sàng phát hành về chất lượng", chưa phải "được phép deploy" (G7 + người ký) | thiếu đúng một bậc "mốc đã kiểm" — ra từ (§7a); không cần đổi nghĩa `done` |
| PD-05 gate planner theo rủi ro, chạy quan sát trước | `BASE-GATE` quyết định "hook chạy test nhanh liên quan, CI toàn bộ; suite < 30 s thì chạy hết"; T-1504 `not_run`; T-1509 typed decision; `BASE-GATE-011` < 10 phút | hợp lý về nguyên tắc, **đúng là cần số trước** (bản cũng nói vậy). Repo khung: hook commit chạy **full gate** — số đo §10 cho biết có đáng tách không |
| PD-06 evidence có nguồn gốc, vô hiệu hoá | T-1513 evidence v2 (`cmd_sha256`, `scope`, `req_rev`, `files_digest`), `verified.json` dấu vân tay cây (`LOOP-DESIGN-022`) | **trùng**; mở rộng thêm lockfile/toolchain/policy vào `files_digest` là bổ sung nhỏ cho T-1513, không phải lát riêng |
| PD-07 audit theo mốc, nợ có hạn, reviewer `inconclusive` | `audit check` đã chặn `chấp nhận` quá hạn/không chủ; T-1506 N/A xét lại; `pr reviewed` chỉ có `--clean`/`--blocking` | **mới thật, nhỏ**: verdict `inconclusive` (diff bị cắt, hết budget, thiếu file) — hiện reviewer hết ngân sách chỉ có thể im lặng hoặc `--blocking`; "mốc" như §7a |
| PD-08 GO/NO-GO máy đọc | `blueprint-status --json`, `audit check`, `merge-check --json` rời nhau; GO-NO-GO chỉ Markdown | **mới, vừa phải**: một lệnh `release-check --json` gom blueprint + audit + CI head + review + SHA/digest artefact, in bảng FAIL; Markdown và JSON cùng nguồn |
| PD-09 ranh giới phát hành (environment, credentials tách, main không tự deploy) | `WF-ENV`/`ci-cd-pipeline.md` "prod qua environment gate" là checklist dự án đích; `LOOP-DESIGN-019` "agent may act up to the production gate and cannot pass it"; guard **không** chặn deploy (ADR-0018) — lớp đỡ đặt ở GitHub | Khung đã chọn đặt ranh giới ở GitHub environment/ruleset, không ở hook (ADR-0018). Máy kiểm protection cần API mà bản thừa nhận không đọc được → chỉ làm được phần `ci-check` cho workflow deploy (environment có `required_reviewers`, secret prod không ở job PR). Mâu thuẫn tài liệu bản nêu là **đúng**: README bước 4 còn ghi deploy/publish là điểm dừng — sửa trong đợt này (xem CHANGELOG) |
| PD-10 trải nghiệm điều phối, một nguồn chính sách | T-1511/T-1512/T-1517/T-1520 | **trùng** |
| PD-11 installer, manifest, rollback | T-1516/T-1518 | **trùng** |
| PD-12 pilot đối chứng (−25 % thời gian, −20 % token, −50 % chạy lại, 0 xanh giả) | `LOOP-DESIGN-016`; `docs/ops/TARGETS.md` có `hotel-manager` | chỉ có nghĩa sau baseline; bản tự ghi "mục tiêu đề xuất, chưa đo" — giữ nguyên nhãn đó |

Nguồn bản dẫn thêm, xác minh 2026-10-19: DORA *Test automation* ("Developers should be able to get feedback from
automated tests in less than ten minutes"; không ai được khai "dev complete" khi acceptance test chưa xanh — trùng
`BASE-GATE-011` và `LOOP-DESIGN-003`): <https://dora.dev/capabilities/test-automation/>. GitHub *About protected branches*:
"Required status checks must have a `successful`, `skipped`, or `neutral` status" — đúng như bản nói, và T-1504 (đã merge
ở #168) đã coi SKIPPED/NEUTRAL là `not_run` → `human`:
<https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches>.

**Khuyến nghị về bản kế hoạch:** không mở PLAN `PD-*` chạy song song với 3.9/3.10 (bản cũng yêu cầu "không tạo hai nơi
thực thi"). Phần thật sự mới gom thành một PLAN sau T-1522, theo thứ tự: (1) tài liệu §7a/§7b · (2) `pr reviewed
--inconclusive` · (3) `release-check --json` · (4) baseline thời gian cổng + `loop stats` (PD-01 rút gọn) → mới quyết có
làm gate planner (PD-05) hay không. `delivery_phase`, PD-04 và phần enforcement của PD-09 chờ số từ (4).

## 9. Đối chiếu đề xuất phân vai Fable (điều phối) · Sonnet (thực thi mặc định) · Opus (thực thi khó) — gửi thêm 2026-10-19

Đề xuất thứ ba: orchestrator–workers + routing theo tầng model, phiếu giao việc 8 trường, bảng chọn Sonnet/Opus theo
4 khía cạnh (phức tạp · bất định · rủi ro · phạm vi ảnh hưởng), quy tắc chuyển cấp (≤ 2 vòng sửa rồi lên Opus; rủi ro
cao lên ngay; Opus trả về Fable khi cần quyết định phạm vi/kiến trúc), song song mặc định 1 executor, ba mức kiểm
(task · mốc · phát hành), 5 chỉ số. Mục tiêu giữ nguyên: dự án đích code nhanh, sản phẩm vẫn chất lượng cao.

### 9.1 Khung đã có gì

| Đề xuất | Khung | Cột |
|---|---|---|
| Fable = điều phối duy nhất, quyết định lớn; bộ điều phối tất định làm phần đã rõ | Phiên chính là điều phối viên duy nhất (`LOOP-ORCH-001`), tự duyệt điểm quyết định (ADR-0008); harness sở hữu vòng lặp (`LOOP-DESIGN` nguyên tắc 1): `loop status` chọn task kế, Stop hook quyết dừng/tiếp; T-1511 `loop next --json` trả task **sẵn sàng theo DAG + cặp giao nhau file** — chính là "khi A xong, giao B" | **có**; T-1511 là mảnh còn thiếu, đã trong PLAN 3.10 |
| Sonnet thực thi mặc định; reviewer khác model | `.claude/agents/executor.md` `model: sonnet`, `reviewer.md` `model: opus`, `researcher.md` sonnet; `LOOP-ORCH-005`, D-045 (`pr reviewed --clean` đòi reviewer khác họ model) | **có** |
| Opus thực thi việc khó/rủi ro cao | **Chưa có**: chỉ một `executor`; bảng "chọn worker theo hai trục" (`LOOP-ORCH` nguyên tắc 3) chỉ quyết *giao hay không giao*, không quyết *model nào* | **chưa có** (§9.2) |
| Phiếu giao việc 8 trường | Gói handoff `LOOP-ORCH-002`: `goal` · `acceptance_criteria` (= Gate) · `files_in_scope` · `budget` · `depth` · `granted_scopes` · `trust_level` · `report_format`; phụ thuộc = `(sau: …; files: …)` của T-1511; giao ước = `API-CONTRACT.md` chốt trước khi song song (`LOOP-ORCH-007`); ngữ cảnh đúng phạm vi = T-1512 `context --task` | **có 6/8**; thiếu `executor + lý do` và `điều kiện chuyển cấp` |
| Chuyển cấp: ≤ 2 vòng sửa → Opus; rủi ro cao lên ngay; giữ ngân sách; chuyển cả diff/lỗi/giả thuyết đã loại | `LOOP-ORCH-014`/`LOOP-STOP-011`: thất bại 2 lần → **đổi cách hoặc chia nhỏ**, lần 3 → người; `max_same_failure: 3` theo chữ ký lỗi (`LOOP-DESIGN-005`) | **có khung, chưa có "đổi tầng model" là một dạng đổi cách** (§9.2) |
| Opus đưa về Fable khi cần quyết định | Subagent không tự quyết, trả phương án về phiên chính (AGENTS.md §4, `LOOP-ORCH` nguyên tắc 2–3) | **có** |
| Lỗi môi trường phân loại riêng, retry có hạn | T-1515 `loop ci-triage` (hạ tầng/test/lint/…; `rerun_used ≤ 1`) | **có** (PLAN 3.10) |
| Song song: mặc định 1, tăng theo độ độc lập; worktree; chủ sở hữu schema/contract | `LOOP-ORCH-006/007/008/010` (≤ 5, hợp đồng trước, worktree B khi ≥ 2 executor, cùng file thì nối tiếp); nguồn Anthropic "coding ít phần song song hơn research" đã trích | **có** |
| Ba mức kiểm: task · mốc · phát hành | task = Gate + `loop record`; phát hành = G7 + GO-NO-GO; **mốc chưa có** (§7a) | có 2/3 |
| Phát hiện review có vị trí · tác động · tiêu chí · bằng chứng; đề xuất style phân mức | `reviewer.md`: `file:dòng` + mức 🔴/🟠/🟢 + **đường tái hiện**, không có đường tái hiện → "nghi ngờ" | **có** |
| "Đổi model không tự chứng minh đúng" | `LOOP-ORCH-004`: phiên chính chạy lại Gate trước khi tick; D-045 chỉ là điều kiện cần | **có** |
| Sổ công việc phân biệt đã viết · đã kiểm · đã tích hợp · đủ điều kiện phát hành | tick `[x]` chỉ sau evidence; PR merge; `done` + GO-NO-GO — thiếu bậc "mốc" như §8 PD-04 | có 3/4 |
| 5 chỉ số (thời gian tới nghiệm thu, chi phí/task, tỉ lệ làm lại/chuyển cấp, lỗi sau tích hợp, thời gian bị chặn) | `loop stats` (`LOOP-DESIGN-024`): `first_pass_rate`, `needs_3_plus`, vòng đã dùng; `LOOP-ORCH-017` tỉ lệ bác; `LOOP-DESIGN-018` chi phí/task (headless) | **có 3/5**; thiếu tỉ lệ chuyển cấp và thời gian chặn vì phụ thuộc |
| Ví dụ đợt đầu (P, T1–T5, M1) | T1 giao ước trạng thái = T-1513/T-1514; T3 điều phối phụ thuộc/retry/tiếp tục = T-1511/T-1515/T-1517; T4 hiển thị tiến độ = `loop status`/PROGRESS; T5 mẫu = T-1520; **T2 "chọn executor theo quy tắc" là phần mới duy nhất** | trùng 3.10 trừ T2 |

### 9.2 Phần mới thật và cách ghép vào khung (đề xuất, chưa làm)

1. **Hai tầng executor thay vì một.** Subagent của Claude Code ghim `model:` trong frontmatter, nên cần hai file:
   `executor.md` (mặc định, sonnet) và một `executor-deep.md` (opus; cùng `tools`, `maxTurns` cao hơn). Phiên chính chọn
   theo bảng 4 khía cạnh của đề xuất; bảng chính sách khởi đầu (UI/CRUD/bug cục bộ → mặc định; giao ước xuyên module,
   auth/phân quyền/cô lập tenant, migration dữ liệu thật, đồng thời/retry, lỗi không ổn định, chưa đủ thông tin → sâu)
   đưa vào `orchestration-and-subagents.md` "Khi nào tách subagent" — hàng mới, không ID mới.
2. **Ràng buộc kéo theo cần giải trước khi làm (1):** `reviewer.md` đang ghim `model: opus`; task do tầng sâu (opus) làm
   thì reviewer cùng họ → `pr reviewed --clean` bị từ chối (D-045) và `LOOP-ORCH-005` vi phạm. Cần reviewer chọn
   **tương đối với executor** (hai agent reviewer, hoặc phiên chính review khi executor là opus, hoặc `XT_REVIEWER_MODEL`
   như mẫu `xt.yaml` đã gợi ý). Đây là điểm bản đề xuất không nêu.
3. **Tên tầng, không tên model, trong artefact commit.** AGENTS.md §3/LOOP-HARNESS-027 cấm ghi tên model vào artefact
   đẩy lên repo (guard hiện chỉ quét commit/PR; `PLAN.md` là file commit). Ghi trong PLAN bằng tầng: `(exec: deep)`
   (mặc định bỏ trống = tầng mặc định) trong ngoặc mà parser T-1511 đã đọc; ánh xạ tầng → model ở `xt.yaml`
   (`executor_default_model`, `executor_deep_model`) cùng chỗ với `author_model_family`. Khớp chính bản đề xuất: "model ID
   là cấu hình của bước triển khai". Model thật đã dùng ghi vào `.autopilot/runs.jsonl` (gitignore) cho `loop stats`.
3b. **Tầng điều phối có đường lùi: Fable không khả dụng thì phiên chính chạy Opus** (yêu cầu chủ repo 2026-10-19).
   Model của phiên chính không nằm trong `xt.yaml` mà chọn lúc mở phiên (bộ chọn model của phiên cloud, CLI/headless
   `--model`), nên đây là luật vận hành ghi ở AGENTS.md §8 và mẫu `CLAUDE.md` dòng "Model/effort" (hiện để `[ĐIỀN]`):
   `điều phối: fable → opus khi không khả dụng · thực thi mặc định: sonnet · thực thi sâu: opus`. Hệ quả phải ghi kèm:
   khi phiên chính là Opus thì tầng sâu trùng họ với điều phối (chấp nhận được — điều phối không viết code) nhưng
   **reviewer không được là Opus** cho task tầng sâu (D-045) → mục 2 càng bắt buộc; `author_model_family` trong `xt.yaml`
   phản ánh họ thật của phiên đang chạy, không ghi cứng "fable". Không có cơ chế máy phát hiện "Fable không khả dụng" —
   là quyết định của người/launcher khi mở phiên; ghi model thật vào `runs.jsonl` để `loop stats` so hai cấu hình.
4. **Chuyển cấp = một dạng "đổi cách" của `LOOP-ORCH-014`**, không phải luật mới: lần thất bại thứ 2 cùng task → phiên
   chính chọn giữa chia nhỏ task, đổi cách tiếp cận, hoặc **đổi tầng** (deep); rủi ro cao (`risk_tags` ≠ rỗng hoặc đường
   dẫn nhạy cảm của `LOOP-STOP-009`) → tầng sâu ngay từ đầu; gói bàn giao khi chuyển = diff hiện tại + evidence lỗi +
   giả thuyết đã loại (có sẵn trong `.autopilot/evidence/T-NNN.json` 40 dòng cuối); `max_same_failure: 3` giữ nguyên
   (lần chuyển tầng tiêu một lần thử — lần 3 vẫn `blocked`, đúng nguyên tắc "sửa mã vòng 4 gần như luôn là đặc tả sai").
   Ghi `escalated_to` vào `runs.jsonl` → `loop stats` thêm `escalation_rate`; `blocked_by_dependency_s` từ T-1511.
5. **Hai trường thêm vào gói handoff** (`LOOP-ORCH-002`, sửa dòng, không thêm ID): `executor_tier + lý do` và
   `escalation_condition` (mặc định: luật ở mục 4).
6. **Không lấy / không đổi:** (a) "Fable chỉ tham gia đầu mốc, khi cần quyết định, lúc nghiệm thu" — đúng về vai, nhưng
   trong autopilot một phiên (ADR-0009) phiên chính **là** vòng lặp (Stop hook gọi lại nó); bỏ nó ra khỏi vòng đòi
   runner headless ngoài phiên (tầng "Trigger ngoài phiên"/durable runtime của `loop-design.md`) — ngoài phạm vi, và
   chi phí context của phiên chính đã được giới hạn bằng T-1512 + `LOOP-ORCH-011/012` (báo cáo ≤ 25 dòng). (b) Validator
   vẫn là máy (như §4). (c) Ngưỡng "≤ 2 vòng sửa" là tham số khởi đầu, bản tự nói cần đo — dùng `loop stats` trước khi
   siết/nới (`LOOP-DESIGN-024`).

Thứ tự làm, sau T-1522 cùng gói với §8: (1) tài liệu hàng chọn tầng + bảng chính sách + luật chuyển cấp (1 PR, docs) ·
(2) `executor-deep.md` + reviewer tương đối + `install.py` chép (1 PR, harness — làn chuẩn) · (3) `exec:` trong
parser T-1511, ánh xạ `xt.yaml`, `runs.jsonl`/`loop stats` (1 PR, `xt.py` + test) · (4) đợt đại diện 3 task (đơn giản ·
nhiều phụ thuộc · rủi ro cao) đo 5 chỉ số rồi mới chỉnh ngưỡng. Mỗi bước có đường lùi: xoá agent file, bỏ khoá
`xt.yaml` → về một tầng như hiện nay.

Nguồn xác minh 2026-10-19: Anthropic *Building effective agents* — routing ("classifies an input and directs it to a
specialized followup task", ví dụ "sending simpler questions to cheaper models"), orchestrator-workers ("a central LLM
dynamically breaks down tasks, delegates them to worker LLMs, and synthesizes their results", hợp cho thay đổi mã
"span an unknown number of files"), và "finding the simplest solution possible, and only increasing complexity when
needed": <https://www.anthropic.com/engineering/building-effective-agents>. Nguồn về agent chạy dài (tiến từng phần,
lưu tiến độ, không khai xong sớm) và "coding ít phần song song" đã trích ở `loop-design.md`/`orchestration-and-subagents.md`.

## 10. Số đo đầu tiên: cổng commit của repo khung

Đo trong phiên này (container cloud, Python 3.13, cache pip nóng), `time scripts/dev-task.sh gate` trên cây làm việc của
bản nghiên cứu này — ghi ở mục 10 sau khi chạy; đây là **một mẫu**, không phải baseline (`LOOP-DESIGN-016` đòi ≥ nhiều
lần + ngày). Dùng để trả lời câu hỏi của PD-05 "cổng đầy đủ mỗi commit có phải nút thắt không" trước khi thiết kế gate
planner.

| Bước | Thời gian | Ghi chú |
|---|---|---|
| build (`xt.py stats`) + typecheck (`mypy --strict`, 4 file) + lint (validate, link, progress/changelog/ci-check, ruff, shellcheck, json) | ≈ 6 s | tính từ tổng trừ test |
| test (`coverage run -m unittest`, 841 test, coverage dòng + nhánh 100 %) | 188,75 s (`Ran 841 tests in 188.750s`) | ≈ 97 % thời gian cổng |
| **gate tổng** (`scripts/dev-task.sh gate`, exit 0) | **195 s** | một mẫu, 2026-10-19 |
| gate tổng **sau D-079** (mỗi lớp test một tiến trình, 4 luồng, vẫn coverage 100 %) | **68 s** (test 66 s) | cùng ngày, cùng máy |

Đọc số: nút thắt là **suite test ~3 phút chạy trọn mỗi commit** (nhiều test gọi `xt.py`/hook qua subprocess để giữ coverage
100 % cả subprocess — PROGRESS "Giữ cổng"), không phải lint/type. Dưới ngưỡng 10 phút của `BASE-GATE-011`, nên đây là
chi phí lặp chứ chưa phải nút thắt; nếu PD-05 làm, phần đáng làm nhất là **chọn test liên quan ở hook commit** (đúng
quyết định sẵn có của `BASE-GATE`: "hook chạy test nhanh liên quan, CI toàn bộ"), CI vẫn chạy trọn — không cần gate
planner tổng quát. Số để so sau này: `.autopilot/runs.jsonl` + `loop stats` (`LOOP-DESIGN-024`) khi autopilot chạy.

## 11. Nguồn (xác minh 2026-10-19)

- DORA — *DORA's software delivery performance metrics* (5 chỉ số: change lead time, deployment frequency, failed
  deployment recovery time, change fail rate, deployment rework rate; "reducing the batch size of changes" cải thiện cả
  5): <https://dora.dev/guides/dora-metrics-four-keys/>. Trang **không** nói về automated testing hay shift-left
  security — đề xuất dẫn "DORA +2" cho ba ý (chia nhỏ, tự động hoá kiểm thử, bảo mật sớm) thì chỉ ý "chia nhỏ" nằm
  ở trang này; hai ý còn lại ở hai trang dưới.
- DORA — *Working in small batches*: "Any batch of code that takes longer than a week to complete and check is too
  big"; tích hợp về trunk ≥ 1 lần/ngày; gom nhiều batch nhỏ lại trước khi test/release làm **chậm phát hiện lỗi**;
  AI adoption thường tăng bất ổn giao hàng và small batches là "a critical countermeasure":
  <https://dora.dev/capabilities/working-in-small-batches/>.
- DORA — *Pervasive security* (tên mới của "Shifting left on security"; URL cũ `/capabilities/shifting-left-on-security/`
  trả 404 ngày 2026-10-19): kiểm bảo mật sau khi code xong "discovers significant problems, including architectural
  flaws, that are expensive to fix"; số duy nhất là từ State of DevOps 2016 — đội hiệu năng cao "spend 50 percent less
  time remediating security issues": <https://dora.dev/capabilities/pervasive-security/>.
- DORA — *Accelerate State of DevOps 2024*: AI tăng năng suất cá nhân nhưng **giảm** throughput và stability giao hàng
  (định tính, trang không cho số): <https://dora.dev/research/2024/dora-report/>. *2025 report*: "AI's primary role is
  as an amplifier": <https://dora.dev/research/2025/dora-report/>; AI Capabilities Model (7 năng lực — trang tóm tắt
  không liệt kê, số 7 theo [`../framework/10-workflow/team-and-wip.md`](../framework/10-workflow/team-and-wip.md) đã
  xác minh 2026-10-13): <https://dora.dev/research/2025/ai-capabilities-model/>.
- Anthropic — *The AI-native SDLC playbook* (2026-08-21), stage 6: "the agent may act up to the production gate and
  cannot pass it" — theo [`loop-design.md`](../framework/11-autonomous-loop/loop-design.md) nguồn `LOOP-DESIGN-019`
  (xác minh 2026-10-16); không fetch lại đợt này.
- Boehm, *Software Engineering Economics* (1981) — bảng chi phí sửa lỗi tăng theo pha; bị chất vấn về cơ sở dữ liệu ở
  Bossavit, *The Leprechauns of Software Engineering* (2013) **(chưa xác minh — không fetch đợt này; chỉ ghi để không
  đưa con số vào khung)**.
- Khung: [`00-method/lifecycle.md`](../framework/00-method/lifecycle.md), [`principles.md`](../framework/00-method/principles.md),
  [`audit.md`](../framework/00-method/audit.md), [`11-autonomous-loop/README.md`](../framework/11-autonomous-loop/README.md),
  [`loop-design.md`](../framework/11-autonomous-loop/loop-design.md), [`optimization-loop.md`](../framework/11-autonomous-loop/optimization-loop.md),
  [`stop-points-and-escalation.md`](../framework/11-autonomous-loop/stop-points-and-escalation.md),
  [`templates/GO-NO-GO.md`](../framework/templates/GO-NO-GO.md), [`templates/PLAN.md`](../framework/templates/PLAN.md) — đọc tại
  `042b91e` ngày 2026-10-19.
