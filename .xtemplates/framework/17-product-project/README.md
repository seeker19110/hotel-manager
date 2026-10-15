---
title: Sản phẩm & dự án
kind: index
updated: 2026-10-13
---

# 17 — Sản phẩm & dự án

> Mảng "làm **đúng việc**" trước khi "làm việc **đúng**": từ ý tưởng tới `PROJECT.md` có chỉ số đo được (G0), cắt MVP
> và chống phình phạm vi (G1), đặc tả là hợp đồng có truy vết (G3), sổ rủi ro và spike (G0–G2), kế hoạch máy đọc
> được với WIP và hạn thật (G4–G6), đo lường sản phẩm tôn trọng quyền riêng tư (G7–G8), bàn giao và kết thúc có bằng
> chứng (G7–G8). Áp cho mọi hồ sơ; module đo lường chỉ ghép cho hồ sơ có người dùng cuối. Mẫu file ở
> [`../templates/README.md`](../templates/README.md); phương pháp cổng ở [`../00-method/lifecycle.md`](../00-method/lifecycle.md).

| File | Nội dung | Đọc khi nào |
|---|---|---|
| [`discovery-and-requirements.md`](discovery-and-requirements.md) | Khám phá & yêu cầu: vấn đề, người dùng (JTBD), bằng chứng nhu cầu, chỉ số thành công có baseline, phạm vi "không làm", giả định, ID yêu cầu | G0 khi nhận ý tưởng hoặc đọc repo có sẵn; trước khi chọn công nghệ; khi điền `PROJECT.md` |
| [`specification.md`](specification.md) | Đặc tả: user story INVEST, Given/When/Then có ID, 8 nhóm ca biên, hợp đồng API trước khi chia việc, truy vết R→F→T→PR→bằng chứng, DoR/DoD, "spec hở thì dừng và hỏi" | G3 cho mỗi tính năng MVP; trước khi bắt đầu task; khi review PR `feat:` |
| [`prioritization-and-roadmap.md`](prioritization-and-roadmap.md) | Ưu tiên & lộ trình: MVP, lát dọc/walking skeleton, MoSCoW (Must ≤ 60%), RICE, `SCOPE.md` + `.out-of-scope/`, lộ trình theo kết quả | G1 khi cắt MVP; mỗi mốc; khi có yêu cầu ngoài kế hoạch hoặc trễ hạn |
| [`risk-and-assumptions.md`](risk-and-assumptions.md) | Rủi ro & giả định: sổ rủi ro có chủ/trigger, spike có hộp thời gian, kế hoạch B, thẩm định bên thứ ba (license/EOL/telemetry), rủi ro pháp lý | G0–G2 khi lập giả định; trước khi thêm phụ thuộc lớn; tại mỗi cổng khi rà lại |
| [`planning-and-estimation.md`](planning-and-estimation.md) | Kế hoạch & ước lượng: `PLAN.md` task ≤1 ngày có Gate máy kiểm, WIP, hạn thật vs mong muốn, ước lượng theo khoảng/throughput, ngân sách 4 con số, `PROGRESS.md` ≤ 8 KB | G4 trước khi code; trước `xt.py loop init`; khi trượt ước lượng hoặc cuối mỗi phiên |
| [`metrics-and-analytics.md`](metrics-and-analytics.md) | Đo lường sản phẩm: sự kiện có schema, một điểm `track()`, funnel, North Star, không tracking khi chưa có đồng ý, không PII, A/B có kiểm định | G3–G6 khi định nghĩa sự kiện cho tính năng; G7 trước phát hành (baseline); G8 khi đọc dashboard |
| [`handover-and-stakeholders.md`](handover-and-stakeholders.md) | Bàn giao & các bên: bản đồ các bên, gói tài liệu, runbook do người mới chạy thử, chuyển giao tài khoản/secret an toàn, hỗ trợ theo SEV, đóng dự án, retrospective | G7–G8; khi đổi người/đội/nhà cung cấp; khi kết thúc dự án |
