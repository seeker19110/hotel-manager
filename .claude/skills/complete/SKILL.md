---
name: complete
description: Pha HARDEN — hoàn thiện dự án khi /autopilot hết việc và đề xuất /complete (hoặc người muốn phát hành): PR đặt delivery_phase: harden, PLAN-harden từ sổ audit (🔴/🟠, MUST blueprint còn mở, sàn Gate M/L, thiết kế đầy đủ, refactor, hiệu năng, tấn công thử) chạy vòng lặp có bằng chứng tới hết việc, rồi cổng ký: audit delta, trả nợ review theo lô, release-check GO + GO-NO-GO.md — lặp tới GO. Dùng khi người dùng muốn "hoàn thiện", "audit và sửa", "chuẩn bị phát hành" hoặc gõ /complete.
argument-hint: "[full|delta] [phiên bản phát hành]"
---

# /complete — pha harden: vét việc, rà ở cổng ký, phát hành

Giao thức vòng lặp: `<FW>/11-autonomous-loop/README.md`; audit: `/audit` (`<FW>/00-method/audit.md`); cổng G7: `<XT> release-check`. Thứ tự bước: ADR-0046, ADR-0080. `<FW>` = `.xtemplates/framework` (dự án đích) hoặc `framework` (repo khung); `<XT>` = `python3 .xtemplates/scripts/xt.py` (hoặc `python3 scripts/xt.py`). Sàn an toàn như `/autopilot` — không nới.

## Bước 0 — chuẩn bị
1. Tên phiên `<Tên repo> — <tên nhánh>`; `<XT> doctor --fix`; chế độ quyền Auto.
2. Đọc `delivery_phase` trong `xt.yaml`; `<XT> blueprint-status BLUEPRINT.md --strict --json` (MUST mở); `<XT> loop status` (vòng build còn `continue` → quay lại `/autopilot`; vòng harden `budget`/gắn phiên khác → `loop attach` hoặc PLAN kế + `loop init` — **không làm lát ngoài vòng sống**); có sổ giai đoạn (`<XT> stage status`, ADR-0058): giai đoạn ≥ 2 (1: máy khoá — dừng, báo), PLAN khai đúng `<XT> stage status`.

## Bước 1 — vào pha harden (một PR, một lần)
Còn `build` → PR đặt `delivery_phase: harden`, `compose --scale` đích (ADR-0081), khoá sàn M/L (`format_check`, `coverage`, kiểm kiểu, `e2e` — `<XT> floor` liệt kê) và `attack`/`perf` (ADR-0042; chưa có công cụ → để rỗng kèm lý do) trong `xt.yaml`. PR đụng `xt.yaml` luôn tính harden (D-137). `pr next` áp chính sách của nhánh đích theo `LOOP-STOP-022` và ADR-0079.

## Bước 2 — sổ việc
Có `docs/ops/AUDIT-STATUS.md` → dùng sổ đang có, **không audit lại ở đây**; chưa có → `/audit full` (xác minh đối kháng 🔴/🟠 → sổ, D-NNN).

## Bước 3 — PLAN-harden (tự duyệt)
`docs/autopilot/PLAN-harden-<ngày>.md` theo mẫu `<FW>/templates/PLAN.md`, mỗi task một Gate máy, thứ tự: (a) 🔴 rồi 🟠 và nợ review mở của sổ — bug có test tái hiện đỏ trước khi sửa; (b) MUST blueprint còn mở — tick kèm `— Kiểm:`/`— Bằng chứng:`, `[~] — Không áp dụng:`, MUST muốn miễn → `loop defer` (người duyệt, `LOOP-STOP-024`); (c) sàn Gate M/L đỏ (`<XT> floor --run`); (d) thiết kế đầy đủ theo quy mô (`lifecycle.md` G2–G4: C4, `API-CONTRACT.md`, `THREAT-MODEL.md`, SPEC ca biên); (e) refactor nhóm CODE/ARCH có Gate (test giữ hành vi); (f) hiệu năng: hàng `perf` đỏ → task theo `optimization-loop.md` (chỉ khi có số; `/optimize` riêng — ADR-0048); (g) từng hàng FAIL của `<XT> release-check --json` (lần 1) thành task. (a)(b): `work[].line` của `<XT> loop next-step --objective harden-to-signoff --prs <JSON>` — duyệt rồi dán. Tóm tắt ≤ 30 dòng đầu PLAN → `<XT> loop decide --question "Duyệt PLAN-harden …"` → làm tiếp không chờ.

## Bước 4 — vét việc (vòng lặp luật harden)
`<XT> loop init --plan docs/autopilot/PLAN-harden-<ngày>.md --blueprint BLUEPRINT.md --single-session [--hours <H>]`, rồi mỗi vòng như `/autopilot` bước 5–6. Khác pha build: mỗi lát một PR **≤ 150 dòng** (vượt → tách lát); đẩy theo `/gate` bước 4; `merge-watch` nền rồi **làm task kế ngay** — chờ CI/merge không phải lý do ngừng lượt. **Không audit, không gọi reviewer ở nhịp này** (`milestone_audit: signoff`, `topo: review`/`audit`: dồn về bước 5); reviewer chỉ khi `<XT> pr next` trả `review` (nhánh đích `merge_review: required`) — ghi `<XT> pr reviewed` như máy in (không kết luận → `--inconclusive`); `debt` → 🔴 sửa, 🟠/🟢 nợ (ADR-0062). Việc cần người → `loop defer`.

## Bước 5 — cổng ký và phát hành (G7)
Stop hook `done` (sau `<XT> loop verify --all`), PR của đợt đã merge →
1. `/audit delta` từ SHA quét gần nhất (xác minh đối kháng 🔴/🟠).
2. Nợ review (`review_debt`, ADR-0057) trả **theo lô trên diff tích luỹ** từ SHA đó: cụm theo file/module (≤ ~150 dòng), `reviewer-alt` chỉ đọc chạy song song (`LOOP-ORCH-005`); phát hiện có đường tái hiện → sổ. Lượt thứ hai trở đi chỉ rà diff của bản sửa; "có từ trước" ngoài diff → sổ (sửa · `chấp nhận` có hạn + D-NNN · `bác bỏ`).
3. `<XT> release-check --json > F` (F, gói: `$TMPDIR`) → `<XT> loop next-step --objective harden-to-signoff --prs … --release F`: `replan` (FAIL) → PLAN-harden kế, tự duyệt, `loop init` → bước 4; `blocked`/`budget` → dừng, báo; khác → theo `reason`, gọi lại; `signoff-package` → lưu gói (`--package` kiểm hiệu lực) → `GO-NO-GO.md` theo mẫu `<FW>/templates/GO-NO-GO.md` (máy điền phần máy; **người ký** dòng 20 — một lần, ADR-0048; `release_signoff: agent` → sau merge `<XT> release-sign --note …`, ADR-0074) trong PR lát cuối → có sổ giai đoạn: `<XT> stage submit --evidence "<bằng chứng>"` → `<XT> loop stats`, `<XT> feedback collect` → báo cáo ≤ 20 dòng: làm · bằng chứng · D-NNN · còn treo · đề xuất. Sau phát hành giữ `harden` (ADR-0037).

## Không bao giờ
Nới guard/điểm dừng/cổng để xanh · tự đổi pha về `build` · bỏ xác minh đối kháng 🔴/🟠 · ký khi còn nợ mở · khai "phát hành được" khi `release-check` NO-GO hoặc §5 chưa ký.
