---
title: Mẫu ADR
kind: template
updated: 2026-10-13
---

# Mẫu ADR-NNNN.md

> **Ai viết:** người/AI đề xuất quyết định; người có thẩm quyền chốt. **Giai đoạn:** G2 (chọn stack), G4 (kiến trúc), bất cứ khi nào có quyết định khó đảo ngược.
> **Cổng dùng:** G2 (mỗi phiên bản có nguồn + ngày), `ARC-ADR-*` ở [`../05-architecture/decision-records.md`](../05-architecture/decision-records.md), `/adr`.
> **Luật:** đánh số tăng dần `docs/adr/NNNN-<slug>.md`; **không sửa ADR cũ** — đổi ý thì viết ADR mới và đặt ADR cũ là "Superseded by ADR-NNNN".
> Cấu trúc theo **MADR 4.0.0** (xác minh 2026-10-13) + hai cột trạng thái tách biệt: *Status* (quyết định) và *Implementation status* (code đã làm tới đâu, do máy/PR điền) — để catalog không "trôi" so với mã.

```markdown
---
status: proposed | accepted | deprecated | superseded by ADR-<NNNN>
implementation-status: not-started | in-progress (PR #<n>) | done (commit <SHA>) | drifted (xem ghi chú)
date: <YYYY-MM-DD>
decision-makers: <tên>
consulted: <tên / vai trò>
informed: <tên / vai trò>
---

# ADR-<NNNN>: <Quyết định, viết dạng câu khẳng định ngắn>

## Bối cảnh và vấn đề (Context and Problem Statement)
<2–5 câu: vấn đề gì, ràng buộc gì (thời gian, chi phí, kỹ năng, luật, hệ thống có sẵn). Có thể nêu dạng câu hỏi.>

## Yếu tố quyết định (Decision Drivers)
- <yếu tố 1, vd: phải chạy được offline>
- <yếu tố 2, vd: license OSI, không telemetry mặc định>
- <yếu tố 3, vd: đội đã biết công nghệ này>

## Các phương án đã cân nhắc (Considered Options)
1. <Phương án A>
2. <Phương án B>
3. <Phương án C — giữ nguyên hiện trạng>

## Quyết định (Decision Outcome)
Chọn **<phương án>**, vì <lý do ngắn gắn với yếu tố quyết định>.

Phiên bản/nguồn đã xác minh: <tên → phiên bản → URL → ngày xác minh> (không có → "(chưa xác minh)").

### Hệ quả (Consequences)
- Tốt: <...>
- Xấu / đánh đổi chấp nhận: <...>
- Việc phải làm tiếp: <task T-NNN / issue>

### Xác nhận (Confirmation)
<Làm sao biết quyết định đã được thực thi đúng: lệnh/test/cấu hình kiểm được, vd `rg -n "<thư viện>" package.json`, test kiến trúc, review định kỳ. Cột `implementation-status` cập nhật từ đây.>

## Ưu / nhược từng phương án (Pros and Cons of the Options)
### <Phương án A>
- Tốt: <...>
- Trung lập: <...>
- Xấu: <...>

### <Phương án B>
- ...

## Thông tin thêm (More Information)
- Liên quan: ADR-<NNNN>, spec SPEC-<slug>, RK-<NNN>, threat model #<id>
- Nguồn: <URL chính thống + ngày xác minh>
- Thời điểm xem lại: <ngày/điều kiện, vd "khi phiên bản X EOL">
```
