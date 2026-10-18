---
title: Mẫu PLAN
kind: template
updated: 2026-10-18
---

# Mẫu PLAN.md

> **Ai viết:** phiên lập kế hoạch (người + AI) sau G0–G4, trước khi code; phiên chính tự duyệt một lần theo tiêu chí chất lượng cuối và ghi `D-NNN` (cổng duyệt duy nhất của autopilot, ADR-0008); người can thiệp lúc nào cũng được.
> **Giai đoạn:** G4 → G6. **Cổng dùng:** `xt.py loop init --plan docs/autopilot/PLAN.md`, `xt.py loop status`, `PM-PLAN-*`. **Đường dẫn:** `docs/autopilot/PLAN.md`.
> **Cú pháp bắt buộc cho máy:** mỗi task một dòng `- [ ] \`T-001\` <việc> — Gate: \`<lệnh>\`` — ID `T-` + ≥3 chữ số, tăng dần; Gate là lệnh chạy trong repo, exit 0 = đạt. Dòng không đúng dạng này máy bỏ qua.
> **Trạng thái:** `[ ]` chưa · `[x]` xong (chỉ khi `.autopilot/evidence/T-NNN.json` có `exit_code: 0` và `cmd` đúng Gate) · `[~]` bỏ (ghi `— Bỏ: <lý do>`, thiếu thì `loop status` ra `verify`).
> Bốn mục "Ủy quyền production", "Điểm dừng bắt buộc", "Ngân sách (4 con số)", "Hạn" là bắt buộc. 4 con số theo [`LOOP-DESIGN-001`](../11-autonomous-loop/loop-design.md): trần vòng · ngân sách tiền/token · timeout mỗi lệnh kiểm · hạn chót.

```markdown
# docs/autopilot/PLAN.md — <Tên dự án> · <mốc/lát>

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
