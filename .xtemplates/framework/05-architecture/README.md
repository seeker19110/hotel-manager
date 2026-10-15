---
title: Kiến trúc
kind: index
updated: 2026-10-13
---

# 05 — Kiến trúc

> Năm module trả lời "chia hệ thống thế nào và giữ nó đứng vững ra sao": chọn kiểu kiến trúc có bằng chứng, giữ ranh
> giới bằng luật máy kiểm, tích hợp không mất/không nhân đôi, chịu lỗi và mở rộng, và ghi lại mọi quyết định khó đảo
> bằng ADR. Ghép vào blueprint qua hồ sơ (`02-profiles/`); `architecture-styles`, `boundaries-and-modularity`,
> `decision-records` áp cho mọi hồ sơ, hai module còn lại cho hồ sơ có server/tích hợp.

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`architecture-styles.md`](architecture-styles.md) | Cây quyết định monolith-first → modular monolith → tách dịch vụ khi có bằng chứng; serverless, event-driven, strangler; 12-factor | G2–G4 khi chọn kiến trúc; brownfield khi cân nhắc tách/gộp dịch vụ; trước khi viết ADR kiến trúc |
| [`boundaries-and-modularity.md`](boundaries-and-modularity.md) | C4 mức 1–2, cấu trúc theo miền, hexagonal/clean, luật phụ thuộc kiểm bằng dependency-cruiser / import-linter / ArchUnit | G4 (thiết kế) và G5 (dựng nền: cài hàng rào); khi refactor lớn hoặc AI agent sắp sửa nhiều module |
| [`integration-patterns.md`](integration-patterns.md) | Idempotency key, transactional outbox, saga, hợp đồng sự kiện có phiên bản, webhook ký + chống replay, intent/lease cho tác động của agent | Khi hệ gọi/nhận từ dịch vụ khác, bên thứ ba, hàng đợi, hoặc agent có tác động đối ngoại |
| [`resilience-and-scalability.md`](resilience-and-scalability.md) | Timeout, retry có ngân sách + jitter, circuit breaker, bulkhead, backpressure, stateless, cache tầng, giấy phép Redis/Valkey | G4–G7 cho hồ sơ có server; trước kiểm tải và GO/NO-GO; khi có sự cố sập dây chuyền |
| [`decision-records.md`](decision-records.md) | ADR theo MADR 4.0.0, bất biến, tách Status và Implementation status, chỉ mục sinh tự động, điều kiện đọc lại | Mỗi khi chốt quyết định khó đảo (G2 stack, G4 thiết kế, đổi schema/hợp đồng/bảo mật); khi AI agent đề xuất thay đổi kiến trúc |
