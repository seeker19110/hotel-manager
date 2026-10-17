---
title: Kế hoạch & ước lượng: chia nhỏ, cổng, WIP, deadline thật
kind: module
prefix: PM-PLAN
applies_to: [all]
updated: 2026-10-16
---

# Kế hoạch & ước lượng: chia nhỏ, cổng, WIP, deadline thật

> Kế hoạch là **file máy đọc được** (`PLAN.md`) gồm các task ≤1 ngày, mỗi task có **Gate** là một lệnh máy kiểm;
> WIP được giới hạn; hạn thật tách khỏi hạn mong muốn; ước lượng là **khoảng**, không phải một con số hứa.
> Mẫu: [`../templates/PLAN.md`](../templates/PLAN.md), [`../templates/PROGRESS.md`](../templates/PROGRESS.md).
> Cách autopilot đọc PLAN/PROGRESS ở [`../11-autonomous-loop/harness-files.md`](../11-autonomous-loop/harness-files.md);
> WIP ở cấp đội/PR ở [`../10-workflow/team-and-wip.md`](../10-workflow/team-and-wip.md).

## Nguyên tắc

1. **Task hoàn chỉnh, nhỏ, kiểm được.** Mỗi task ≤1 ngày việc, kết thúc bằng một lệnh trả exit 0 (Gate); task không có Gate là chưa định nghĩa xong.
2. **Kế hoạch cho máy đọc.** `PLAN.md` theo đúng cú pháp `- [ ] \`T-001\` <việc> — Gate: \`<lệnh>\`` để `xt.py` tính verdict từ bằng chứng, không từ lời khai (P1).
3. **Giới hạn WIP.** Bắt đầu việc mới là quyết định kéo (pull) khi có năng lực rỗi; một người làm thì WIP ≤ 2, PR mở toàn repo ≤ 3 kể cả bot (catalog 23 §2.5).
4. **Hạn thật ≠ hạn mong muốn.** Hạn thật có hậu quả bên ngoài (hợp đồng, luật, sự kiện); hạn mong muốn là mục tiêu nội bộ. Chỉ hạn thật mới được phép cắt phạm vi để giữ.
5. **Ước lượng là khoảng có xác suất** (P50/P90), hoặc dự báo từ throughput lịch sử; con số đơn chỉ là P50 và phải ghi là P50.
6. **Điểm dừng bắt buộc ghi trước**: thao tác không đảo ngược, tiền thật, dữ liệu người dùng thật, publish/deploy, đổi cấu hình cổng — liệt kê trong PLAN để vòng lặp tự dừng; mâu thuẫn spec và duyệt PLAN do phiên chính tự quyết, ghi D-NNN (ADR-0008) ([`../11-autonomous-loop/stop-points-and-escalation.md`](../11-autonomous-loop/stop-points-and-escalation.md)).
7. **Ngân sách bốn con số** cho mọi vòng lặp/đợt: số vòng tối đa, ngân sách (token/tiền), timeout mỗi lệnh, ngày hết hạn (catalog 21 §10).
8. **PROGRESS là bàn giao cho phiên sau**: ≤8 KB, 4 mục, SHA là tổ tiên của HEAD; cũ hơn thì không tin.

## Quyết định

| Tình huống | Cách ước lượng | Ghi vào PLAN | Không dùng khi |
|---|---|---|---|
| Chưa có lịch sử, việc mới | Khoảng P50/P90 theo task (vd "0,5–2 ngày"); tổng theo khoảng, không cộng P50 | Cột "Ước lượng (P50–P90)" | Có ≥20 task hoàn thành gần đây — dùng throughput |
| Có lịch sử ≥ vài tuần task đồng cỡ | Throughput (task/tuần) + SLE theo Kanban Guide ("85% task xong trong ≤ N ngày") | Dòng "Throughput … · SLE …" | Kích thước task thay đổi mạnh — chia lại cho đồng cỡ |
| Task đã ≤1 ngày và đồng cỡ | Không ước lượng từng task; đếm số task còn lại ÷ throughput | Số task còn lại | — |
| Hạn thật cố định | Lập ngược từ hạn: cắt Could/Should tới khi P85 kịp hạn | Mục "Hạn thật" + "cut line" | Hạn chỉ là mong muốn — ghi đúng loại hạn |
| Nhiều việc chờ người ngoài | Ghi phụ thuộc + ngày cam kết của bên kia + kế hoạch B | Cột "Phụ thuộc" | — |

**Mặc định:** chia task ≤1 ngày với Gate → đếm task + throughput → báo P50/P85 → cắt phạm vi thay vì ép hạn.

## Checklist

- [ ] `PM-PLAN-001` **MUST** `PLAN.md` tồn tại, mỗi task một dòng đúng cú pháp `- [ ] \`T-NNN\` <việc> — Gate: \`<lệnh>\``; ID tăng dần, không trùng. → Kiểm: `python3 -c "import sys;sys.path.insert(0,'scripts');import xt,pathlib;t=xt.parse_plan(pathlib.Path('PLAN.md'));assert t and all(x['gate'] for x in t)"` thoát 0.
- [ ] `PM-PLAN-002` **MUST@L** Mỗi task ≤1 ngày việc; task lớn hơn phải chia trước khi bắt đầu. → Kiểm: cột ước lượng P90 ≤ 1 ngày cho mọi task mở; review PLAN tại cổng.
- [ ] `PM-PLAN-003` **MUST** Gate của task là lệnh chạy được trong repo, trả exit 0 khi đạt (test, lint, build, script kiểm, smoke). → Kiểm: `xt.py loop record --task T-NNN -- <gate>` tạo `.autopilot/evidence/T-NNN.json` với `exit_code: 0`; Gate dạng "đã review" không được chấp nhận.
- [ ] `PM-PLAN-004` **MUST@L** Mỗi task trỏ về spec/yêu cầu (`F-NNN`/`S-NNN`/`RK-NNN`); không có task mồ côi. → Kiểm: `rg -n "T-[0-9]{3}" PLAN.md | rg -v "F-|S-|RK-|chore"` rỗng.
- [ ] `PM-PLAN-005` **MUST** `PLAN.md` có mục "Điểm dừng bắt buộc" liệt kê thao tác cần người duyệt (xoá dữ liệu, migration phá vỡ, tiền thật, secret, dữ liệu người dùng thật, publish/deploy); mâu thuẫn spec không thuộc danh sách — phiên chính tự quyết (ADR-0008). → Kiểm: `rg -n "^## Điểm dừng bắt buộc" PLAN.md` và ≥4 dòng dưới mục.
- [ ] `PM-PLAN-006` **MUST** `docs/autopilot/PLAN.md` có mục "Ngân sách (4 con số)" theo [`LOOP-DESIGN-001`](../11-autonomous-loop/loop-design.md): số vòng tối đa, ngân sách token/tiền, timeout mỗi lệnh kiểm, ngày hết hạn. → Kiểm: `rg -n "^## Ngân sách" docs/autopilot/PLAN.md`; `xt.py loop init --plan docs/autopilot/PLAN.md --max-iterations N --hours H` dùng đúng số đó.
- [ ] `PM-PLAN-007` **MUST@L** WIP giới hạn và ghi số: task "đang làm" ≤ 2 cho một người; PR mở toàn repo ≤ 3 (kể cả bot/draft); vượt thì không bắt đầu việc mới. → Kiểm: `gh pr list --state open --json number | jq length` ≤ 3; `PROGRESS.md` mục "Đang làm" ≤ 2 dòng.
- [ ] `PM-PLAN-008` **MUST@L** Hạn thật và hạn mong muốn ghi riêng, mỗi hạn thật nêu hậu quả bên ngoài; trễ hạn thật xử lý bằng cắt phạm vi (xem `PM-PRIO-007`). → Kiểm: mục "Hạn" trong `PLAN.md` có hai bảng; hạn thật có cột "hậu quả".
- [ ] `PM-PLAN-009` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`LOOP-HARNESS-004`](../11-autonomous-loop/harness-files.md)/[`005`](../11-autonomous-loop/harness-files.md) (định dạng và độ tươi `PROGRESS.md`: ≤ 8 KB, 4 mục, SHA tổ tiên HEAD).
- [ ] `PM-PLAN-010` **SHOULD** Ước lượng ghi dạng khoảng P50–P90; tổng lịch báo bằng P50/P85, không cộng P50 các task thành một ngày hứa. → Kiểm: bảng ước lượng có hai cột; `PROGRESS.md` ghi "P50 … / P85 …".
- [ ] `PM-PLAN-011` **SHOULD** Có throughput và cycle time đo thật (từ ngày bắt đầu/kết thúc task hoặc PR) sau 2 tuần đầu; dự báo cập nhật từ số đo, không từ cảm giác. → Kiểm: bảng "Dòng chảy" trong `PROGRESS.md` hoặc `docs/metrics/flow.csv` cập nhật hằng tuần.
- [ ] `PM-PLAN-012` **SHOULD** Phụ thuộc giữa task ghi rõ (`sau: T-NNN`) và việc chờ bên ngoài có ngày cam kết + kế hoạch B. → Kiểm: `rg -n "sau: T-" PLAN.md` cho task có phụ thuộc; cột "Phụ thuộc ngoài".
- [ ] `PM-PLAN-013` **SHOULD** Mốc (milestone) trùng với cổng G1–G8; không có mốc "demo sếp" nằm ngoài cổng mà không có đầu ra file. → Kiểm: bảng mốc có cột "Cổng" và "Đầu ra (file)".
- [ ] `PM-PLAN-014` **SHOULD** Khi ba task liên tiếp trượt ước lượng cùng hướng → lập lại kế hoạch (chia lại, cắt phạm vi) thay vì tăng giờ làm. → Kiểm: `PROGRESS.md` mục Quyết định ghi "re-plan ngày …" khi điều kiện xảy ra.
- [ ] `PM-PLAN-015` **SHOULD** Có vùng đệm rõ ràng (Could của MoSCoW ≈ 20% nỗ lực) thay vì cộng "hệ số an toàn" ngầm vào từng task. → Kiểm: bảng MoSCoW có phần Could ≥ 15% nỗ lực hoặc lý do.
- [ ] `PM-PLAN-016` **SHOULD** Mỗi task kết thúc bằng commit nhỏ + cập nhật `PROGRESS.md` trong cùng PR, để đứt phiên vẫn tiếp tục được. → Kiểm: PR có diff `PROGRESS.md`; hook SessionStart đọc được mục "Đang làm".
- [ ] `PM-PLAN-017` **MAY** Dự báo xác suất kịp hạn bằng Monte Carlo từ throughput lịch sử (script đơn giản, không cần công cụ trả phí). → Kiểm: `docs/metrics/forecast.md` có P50/P85/P95 và ngày chạy.
- [ ] `PM-PLAN-018` **MAY** Nhãn `route:` cho task (độ phức tạp × độ đóng của spec) để điều phối worker/agent phù hợp; chi tiết ở [`../11-autonomous-loop/orchestration-and-subagents.md`](../11-autonomous-loop/orchestration-and-subagents.md). → Kiểm: task có `route:` hợp lệ theo bảng của module đó.

## Bẫy thường gặp

| Bẫy | Dấu hiệu | Cách tránh |
|---|---|---|
| Task "làm tính năng X" 5 ngày | Không biết tiến độ tới khi xong | Chia ≤1 ngày theo lát dọc; mỗi task một Gate |
| Gate là lời khai | "Gate: đã test tay" | Gate phải là lệnh; `xt.py loop record` ghi exit code |
| Cộng P50 thành ngày hứa | "Tổng 23 ngày → giao ngày X" | Báo P50/P85; tổng khoảng không phải tổng P50 |
| WIP không giới hạn | 7 PR mở, 5 nhánh dở, mọi PR đỏ vì bot | Cap PR mở ≤ 3 kể cả Dependabot; gom nhóm dependency (catalog 23 §2.5) |
| Hạn mong muốn hoá hạn thật | Hạ chất lượng để kịp "demo nội bộ" | Hai bảng hạn; chỉ hạn thật có hậu quả mới được cắt phạm vi |
| PROGRESS phình, lẫn lịch sử dự án khác | 376 dòng, SHA không thuộc repo (khung cũ) | ≤8 KB, 4 mục, SHA tổ tiên HEAD; lịch sử sang CHANGELOG |
| Vòng lặp không trần | Agent chạy tới hết token | Ngân sách 4 con số; `max_iterations`, `deadline` trong `xt.py loop init` |
| Re-plan bằng tăng giờ | Trượt liên tiếp, lịch vẫn giữ | `PM-PLAN-014`: trượt 3 lần → chia lại/cắt phạm vi |
| Task không trỏ spec | PR "nhân tiện sửa" | `PM-PLAN-004`; PR template bắt `Spec:` |

## Cổng tự động

| Việc | Công cụ / lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| PLAN parse được, mọi task có Gate | `xt.py loop status --json` (sau `loop init`) hoặc lệnh parse ở `PM-PLAN-001` | pre-commit khi sửa `PLAN.md` + CI | 0 task thiếu Gate |
| Bằng chứng khớp Gate | `xt.py loop status` → verdict không phải `verify` | Stop hook / CI | Task tick mà không có bằng chứng → `verify` |
| WIP PR | `gh pr list --state open --json number --jq length` | CI (`pr-policy`) | ≤ 3, kể cả bot/draft |
| PROGRESS kích thước + SHA | `xt.py progress-check` | pre-commit + CI | ≤ 8192 byte; SHA là tổ tiên |
| Mục bắt buộc của PLAN | `rg -n "^## (Điểm dừng bắt buộc|Ngân sách|Hạn)" PLAN.md` | CI | Đủ 3 mục |
| Dòng chảy (throughput, cycle time) | Script đọc `gh pr list --state merged --json createdAt,mergedAt` → CSV | CI hằng tuần | Báo cáo, không chặn |

## Nguồn

- Kanban Guide 2025.5 — kiểm soát WIP, bốn chỉ số dòng chảy (WIP, throughput, work item age, cycle time), SLE có xác suất: <https://kanbanguides.org/english/> — xác minh 2026-10-13.
- SMART cho task (Specific, Measurable, Achievable, Relevant, Time-boxed) — Bill Wake (2003): <https://xp123.com/articles/invest-in-good-stories-and-smart-tasks/> — xác minh 2026-10-13.
- MoSCoW Could ≈ 20% làm vùng đệm — DSDM: <https://www.agilebusiness.org/dsdm-project-framework/moscow-prioritisation.html> — xác minh 2026-10-13.
- Cú pháp task/Gate và verdict máy: `scripts/xt.py` (`TASK_RE`, `GATE_RE`, `loop_verdict`) của khung này; [`../00-method/evidence-and-sources.md`](../00-method/evidence-and-sources.md) §2.
- Ngân sách 4 con số, PROGRESS ≤ 8 KB 4 mục, WIP cap 3 PR, SHA tổ tiên HEAD: `seeker19110/stored` mục 21 §8–§10, mục 23 §2.1, §2.5 — qua `research/2026-10-13-stored-catalog-extraction.md`, đọc 2026-10-13.
- Khung cũ X-stored `PROGRESS.md` (376 dòng, lẫn nhật ký repo khác) — ví dụ bẫy, `research/2026-10-13-old-framework-analysis.md` §3b.
