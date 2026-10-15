---
title: Mẫu PLAN
kind: template
updated: 2026-10-14
---

# Mẫu PLAN.md

> **Ai viết:** phiên lập kế hoạch (người + AI) sau G0–G4, trước khi code; người duyệt một lần (cổng duyệt duy nhất của autopilot).
> **Giai đoạn:** G4 → G6. **Cổng dùng:** `xt.py loop init --plan docs/autopilot/PLAN.md`, `xt.py loop status`, `PM-PLAN-*`. **Đường dẫn:** `docs/autopilot/PLAN.md`.
> **Cú pháp bắt buộc cho máy:** mỗi task một dòng `- [ ] \`T-001\` <việc> — Gate: \`<lệnh>\`` — ID `T-` + ≥3 chữ số, tăng dần; Gate là lệnh chạy trong repo, exit 0 = đạt. Dòng không đúng dạng này máy bỏ qua.
> **Trạng thái:** `[ ]` chưa · `[x]` xong (chỉ khi `.autopilot/evidence/T-NNN.json` có `exit_code: 0` và `cmd` đúng Gate) · `[~]` bỏ (ghi lý do).
> Ba mục "Điểm dừng bắt buộc", "Ngân sách (4 con số)", "Hạn" là bắt buộc. 4 con số theo [`LOOP-DESIGN-001`](../11-autonomous-loop/loop-design.md): trần vòng · ngân sách tiền/token · timeout mỗi lệnh kiểm · hạn chót.

```markdown
# docs/autopilot/PLAN.md — <Tên dự án> · <mốc/lát>

> Duyệt bởi <tên> ngày <YYYY-MM-DD> · Spec gốc: docs/specs/SPEC-<slug>.md (F-<NNN>) · Blueprint: BLUEPRINT.md

## Mục tiêu của kế hoạch này
<1–2 câu: lát dọc nào chạy được khi xong; chỉ số nào đo được>

## Ngân sách (4 con số)
- Số vòng tối đa: <N> (`--max-iterations`)
- Ngân sách: <token hoặc tiền> 
- Timeout mỗi lệnh Gate: <giây> (`XT_RECORD_TIMEOUT`)
- Ngày hết hạn: <YYYY-MM-DDThh:mm:ssZ> (`--hours`)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn thật | <ngày> | <hợp đồng/luật/sự kiện> | cắt Could → Should, không hạ cổng |
| Hạn mong muốn | <ngày> | nội bộ | re-plan |

## Điểm dừng bắt buộc (dừng và hỏi người — `xt.py loop block --reason "..."`)
- Xoá/đổi dữ liệu thật, migration phá vỡ, drop cột/bảng
- Tiền thật, thanh toán, gửi thông báo ra ngoài, deploy production
- Secret, quyền, ruleset, cấu hình cổng/CI/hook
- Spec hở hoặc mâu thuẫn với code hiện có
- <điểm dừng riêng của dự án>

## Thứ tự & lý do
1. Lát 1 — walking skeleton (rủi ro: RK-<NNN>) — lý do: <...>
2. Lát 2 — <tên> — lý do: <...>

## Task

### Lát 1 — Walking skeleton (F-<NNN>)
- [ ] `T-001` Dựng khung repo + CI chạy lint/test rỗng (F-000) — Gate: `scripts/dev-task.sh gate`
- [ ] `T-002` Luồng mỏng nhất UI → API → DB cho <luồng A> (F-<NNN>, S-001) — Gate: `npm test -- --run tests/slice-a.test.ts`
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
