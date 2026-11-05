---
title: Mẫu PLAN
kind: template
updated: 2026-11-01
---

# Mẫu PLAN.md

> **Ai viết:** phiên lập kế hoạch (người + AI) sau G0–G4, trước khi code; phiên chính tự duyệt một lần theo tiêu chí chất lượng cuối và ghi `D-NNN` (cổng duyệt duy nhất của autopilot, ADR-0008); người can thiệp lúc nào cũng được.
> **Giai đoạn:** G4 → G6. **Cổng dùng:** `xt.py loop init --plan docs/autopilot/PLAN.md`, `xt.py loop status`, `PM-PLAN-*`. **Đường dẫn:** `docs/autopilot/PLAN.md`; đợt sau là file mới `docs/autopilot/PLAN-<đợt>.md` — bằng chứng `.autopilot/` không theo git, máy/clone mới chỉ phải chạy lại Gate của PLAN đang làm (`loop init` cảnh báo task `[x]` thiếu bằng chứng).
> **Cú pháp bắt buộc cho máy:** mỗi task một dòng `- [ ] \`T-001\` <việc> — Gate: \`<lệnh>\`` — ID `T-` + ≥3 chữ số, tăng dần; đợt kế không dùng lại ID đợt trước cho việc khác (việc chờ người chép nguyên dòng cùng ID — `loop init` mang theo khi spec khớp, ID trùng khác việc thì báo và bỏ); Gate là lệnh chạy trong repo, exit 0 = đạt. Dòng không đúng dạng này máy bỏ qua.
> **Dependency và phạm vi ghi (máy đọc):** ghi chú trong ngoặc của dòng task `(sau: T-001, T-002; files: src/a.ts, tests/)` — `sau:` = task TRONG file này phải `[x]`/`[~]` trước (ID không có trong file thì bỏ qua; `loop record` từ chối chạy task khi dependency còn mở, exit 2; chu trình `sau:` hiện ở `loop status`); `files:` = đường dẫn/thư mục task ghi, cách nhau dấu phẩy (thư mục chứa nhau tính là giao nhau). `loop next [--json]` liệt kê task sẵn sàng + cặp giao nhau `files:` (không giao song song) + task chưa khai `files:`. Các mục khác trong ngoặc (`S-001`, `cần: …`) máy bỏ qua; nhóm ngoặc chứa dấu `;` mà không có `sau:`/`files:` vẫn hợp lệ.
> **Trạng thái:** `[ ]` chưa · `[x]` xong (chỉ khi `.autopilot/evidence/T-NNN.json` có `exit_code: 0` và `cmd` đúng Gate) · `[~]` bỏ (ghi `— Bỏ: <lý do>`, thiếu thì `loop status` ra `verify`).
> **Cấu hình và tầng (ADR-0061, ADR-0029):** mặc định `topo: self` (phiên chính tự làm, `executor: null`); `(topo: review)` xuyên module/chạm bảo mật — reviewer độc lập trước PR; `(topo: parallel)` chỉ khi module độc lập file (`files:` không giao, đợt ≤ 4) — giao `executor`, task khó/bất định/rủi ro cao/phạm vi rộng (giao ước xuyên module, auth/phân quyền/tenant, migration dữ liệu thật, đồng thời/retry, lỗi không ổn định) ghi thêm `(exec: deep)` → `executor-deep`; `(topo: audit)` audit một lượt rồi sửa batch. Tầng đỏ 2 lần → máy tự chuyển cấp. Tên tầng, không tên model.
> **Mốc:** mỗi mục `### Lát N — …` là một mốc; `loop status` báo `milestone_done` khi mọi task của mục trước đã đóng → audit delta (`xt.py audit plan --status …`) trước khi làm task đầu của mục kế; pha build (`milestone_audit: g7`) không audit theo mốc mà ở cuối đợt (`done` → `/audit delta`, ADR-0033/0046/0047 của khung); khi chưa có `PROJECT.md`, 4 dòng Khung (vấn đề · người dùng · 1 chỉ số · không làm) đặt ngay dưới dòng Duyệt.
> **Giai đoạn sản phẩm (ADR-0058 của khung):** dự án có `docs/autopilot/STAGE.json` thì PLAN khai đúng giai đoạn + chu kỳ đang mở; khai khác/thiếu → `loop init`/`next`/`record` exit 2 (giai đoạn sau khoá tới khi người `stage approve`).
> Máy đọc: dòng task và mục "Ủy quyền production" (`xt.py grant-check`). "Ngân sách (4 con số)" theo [`LOOP-DESIGN-001`](../11-autonomous-loop/loop-design.md) là số truyền cho cờ `loop init` (`--max-iterations`, `--hours`) và `XT_RECORD_TIMEOUT`; "Điểm dừng bắt buộc" và "Hạn" để người đọc — điểm dừng thật đi qua `loop defer`/`loop block` lúc chạy.

```markdown
# docs/autopilot/PLAN.md — <Tên dự án> · <mốc/lát>

> Giai đoạn sản phẩm: <1|2|3> (C-<NNN>) — chỉ khi có `docs/autopilot/STAGE.json`; lấy từ `xt.py stage status`
> Duyệt: D-<NNN> (phiên chính tự duyệt) hoặc <tên> ngày <YYYY-MM-DD> · Spec gốc: docs/specs/SPEC-<slug>.md (F-<NNN>) · Blueprint: BLUEPRINT.md

## Mục tiêu của kế hoạch này
<1–2 câu: lát dọc nào chạy được khi xong; chỉ số nào đo được>

## Ngân sách (4 con số)
- Số vòng tối đa: <N> (`--max-iterations`; bỏ trống với `--single-session` = max(40, 8 × task chưa làm))
- Ngân sách: <token hoặc tiền> 
- Timeout mỗi lệnh Gate: <giây> (`XT_RECORD_TIMEOUT`)
- Ngày hết hạn: <YYYY-MM-DDThh:mm:ssZ> (`--hours`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | <ngày> | <hợp đồng/luật/sự kiện> | cắt Could → Should, không hạ cổng |
| Hạn mong muốn | <ngày> | nội bộ | re-plan |

## Ủy quyền production (người duyệt một lần ở đây; máy kiểm bằng `xt.py grant-check`, ADR-0022)
> Mặc định chỉ sandbox, không tiền live, không xoá cứng, không xuất PII, không gửi tin thật. Nâng lên ví dụ:
> `- grant: payments | mode=sandbox,live | max_per_txn=50 | refund=false`. Quy ước: `max_<khoá>` = trần số;
> `true` = được cả hai; `false` = chỉ nhận `false`; `a,b` = chỉ nhận giá trị trong danh sách. Việc ngoài ủy quyền →
> `xt.py loop defer`. **Đổi dòng `- grant:` hoặc khoá `merge_hard_exceptions` trong xt.yaml chỉ qua PR do người
> merge** — người merge PR duyệt kế hoạch là lời chủ dự án chấp nhận rủi ro duy nhất.
- grant: payments | mode=sandbox | max_per_txn=0 | refund=false
- grant: data_delete | hard_delete=false | max_rows=100
- grant: data_export | pii=false | max_rows=10000
- grant: outbound_messages | live=false | max_per_hour=0
- grant: auth_crypto | custom_crypto=false
- grant: secrets | read_values=false

## Điểm dừng bắt buộc về hành động (việc cần người — `xt.py loop defer`/`loop block`; ADR-0018, ADR-0019 của khung)
- Xoá/đổi/xuất dữ liệu người dùng thật, migration phá vỡ trên production, drop cột/bảng
- Tiền thật, thanh toán thật, đăng ký dịch vụ trả phí/nhập khoá thật, gửi tin tới người dùng thật
- Merge PR ngoại lệ cứng (`merge-check` trả `hard`: tiền, dữ liệu người dùng thật, auth, mật mã, bí mật) khi `merge_hard_exceptions: human` (ADR-0020)
- (Deploy/publish, sửa cấu hình cổng/CI/hook kèm lý do, thêm phụ thuộc **không** dừng: guard cho chạy; lệnh không đảo ngược guard chặn)
- (Spec hở, mâu thuẫn với code, chọn công nghệ/thiết kế **không** dừng: phiên chính tự quyết, `xt.py loop decide` → D-NNN)
- (Còn việc khác làm được thì **không** `block`: `xt.py loop defer --task <ID> --reason "..."`, gom cho người cuối phiên)
- <điểm dừng riêng của dự án>

## Thứ tự & lý do
1. Lát 1 — walking skeleton (rủi ro: RK-<NNN>) — lý do: <...>
2. Lát 2 — <tên> — lý do: <...>

## Task

### Lát 1 — Walking skeleton (F-<NNN>)
- [ ] `T-001` Dựng khung repo + CI + điền lệnh thật ở `xt.yaml` (lint/test rỗng làm cổng đỏ — ADR-0011 của khung) (F-000) — Gate: `.xtemplates/scripts/dev-task.sh gate`
- [ ] `T-002` Luồng mỏng nhất UI → API → DB cho <luồng A> (F-<NNN>, S-001; topo: parallel; exec: deep) — Gate: `npm test -- --run tests/slice-a.test.ts`
- [ ] `T-003` Deploy staging + smoke (F-000) — Gate: `scripts/smoke.sh https://staging.<domain>`

### Lát 2 — <tên lát> (F-<NNN>)
- [ ] `T-004` <việc ≤1 ngày> (S-<NNN>; sau: T-002) — Gate: `<lệnh>`
- [ ] `T-005` <việc> (RK-<NNN>: spike có hộp thời gian 1 ngày) — Gate: `<lệnh>`

## Phụ thuộc ngoài
| Việc | Bên ngoài | Ngày cam kết | Kế hoạch B |
|---|---|---|---|

## Ước lượng
| Task | P50 | P90 |
|---|---|---|
| T-001 | <0,5 ngày> | <1 ngày> |
Tổng: P50 <...> · P85 <...> (không cộng P50 làm ngày hứa)
```
