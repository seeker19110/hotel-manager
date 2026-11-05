---
title: Vòng đời dự án và các cổng
kind: method
updated: 2026-11-01
---

# Vòng đời dự án và các cổng

> Mọi dự án đi qua **9 giai đoạn**, mỗi giai đoạn kết thúc bằng **một cổng** có đầu ra kiểm được. Dự án nhỏ
> đi nhanh qua cổng nhưng không bỏ cổng. Dự án có sẵn (brownfield) bắt đầu ở G0 với "đọc repo" thay cho "ý tưởng".

## Bảng giai đoạn

| GĐ | Tên | Câu hỏi trả lời | Đầu ra bắt buộc | Cổng (máy/người kiểm) |
|---|---|---|---|---|
| G0 | **Khung (Frame)** | Vấn đề gì, cho ai, đo thành công thế nào? | `PROJECT.md` mục Vấn đề + Người dùng + Chỉ số thành công | Có ≥1 chỉ số đo được; phạm vi "không làm" ghi rõ |
| G1 | **Phân loại (Classify)** | Phần mềm loại gì, ngành gì, quy mô nào? | Hồ sơ + gói ngành + quy mô S/M/L; `BLUEPRINT.md` sinh bằng `xt.py compose` | `xt.py compose` chạy được; blueprint commit vào repo |
| G2 | **Nghiên cứu (Research)** | Công nghệ/phiên bản nào, ràng buộc pháp lý gì? | ADR chọn stack; bảng phiên bản kèm ngày xác minh; danh sách luật áp dụng | Mỗi phiên bản có nguồn + ngày; luật ngành có số hiệu |
| G3 | **Đặc tả (Specify)** | Xây chính xác cái gì? | Spec tính năng (luồng, dữ liệu, API, ca biên, tiêu chí chấp nhận dạng Given/When/Then) | Mỗi tính năng MVP có tiêu chí chấp nhận kiểm được |
| G4 | **Thiết kế (Design)** | Kiến trúc, dữ liệu, giao diện, mối đe doạ? | Sơ đồ C4 mức 1–2; schema; hợp đồng API; threat model; wireframe/tokens | Threat model có biện pháp cho mỗi mối đe doạ mức cao |
| G5 | **Dựng nền (Scaffold)** | Hàng rào chất lượng đã chạy chưa? | Repo + CI (lint/type/test/scan) + môi trường + secrets + observability tối thiểu | CI xanh trên commit rỗng tính năng; cổng commit chặn được lỗi |
| G6 | **Xây (Build)** | Tính năng đã chạy đúng chưa? | Code + test theo từng lát dọc (vertical slice); mỗi lát một PR | PR qua cổng merge; blueprint tick theo bằng chứng |
| G7 | **Kiểm & phát hành (Verify & Release)** | Đủ tốt để người thật dùng chưa? | Báo cáo GO/NO-GO; E2E luồng chính; bảo mật; hiệu năng; a11y; tài liệu; kế hoạch rollback | `xt.py release-check` GO (gom `blueprint-status --strict --run`, sổ audit `--strict`, kiểm lại cuối); 0 mục BLOCKER |
| G8 | **Vận hành & tiến hoá (Operate)** | Có chạy ổn và tốt dần lên không? | SLO + cảnh báo; runbook; quy trình sự cố; post-mortem; lịch bảo trì phụ thuộc | Cảnh báo đã thử kích hoạt; backup đã thử khôi phục |

## Quy tắc chung của cổng

1. **Cổng chỉ có đạt/không đạt.** "Gần đạt" là không đạt.
2. **Đầu ra là file trong repo**, không phải đoạn chat. Phiên sau đọc được.
3. **Cổng máy trước**: cái gì kiểm bằng lệnh thì phải có lệnh; người chỉ duyệt phần còn lại.
4. **Quay lui được**: phát hiện sai ở GĐ sau → quay về GĐ gây ra, sửa đầu ra gốc, không vá ở hạ nguồn.
5. **Dự án có sẵn**: G0 = đọc repo (stack thật, cấu trúc, CI, test, nợ kỹ thuật) → G1 sinh blueprint → audit theo [`audit.md`](audit.md)
   blueprint với hiện trạng (mục nào đã đạt có bằng chứng thì tick) → các GĐ sau chỉ làm phần còn thiếu, tăng dần,
   **không áp đặt stack mới**.
6. **Chất lượng theo pha — nhanh ở G6, tin cậy ở G7** (ADR-0029): G5 đặt **sàn máy** (năm cổng + MUST sàn về bảo mật,
   cấu hình, dữ liệu, phân quyền — thứ sai từ đầu thì làm lại cả hệ); G6 chạy **nhanh trên sàn đó**: cổng commit + PR mỗi
   lát + review theo làn, **không** audit toàn repo mỗi PR, **không** tối ưu khi chưa có số ([`../11-autonomous-loop/optimization-loop.md`](../11-autonomous-loop/optimization-loop.md)),
   UI "đủ dùng" theo MUST của quy mô; audit **theo delta ở mỗi mốc** của PLAN ở pha harden — pha build ở cuối mỗi đợt (`done`), ADR-0033/0046/0047 ([`audit.md`](audit.md) §1) và **toàn diện ở G7**
   (`xt.py release-check` gom blueprint `--strict --run`, sổ audit `--strict`, kiểm lại cuối, cây git, tấn công thử và kiểm tải
   — `attack`/`perf` của `xt.yaml`, ADR-0042; cổng production `migration_check`/`rollback`/`acceptance`, ADR-0062 → GO/NO-GO máy đọc;
   người ký `GO-NO-GO.md`). Chỉ G7 mới đòi E2E đầy đủ, kiểm tải, diễn tập rollback/khôi phục. Không phải hạ chuẩn:
   cùng tiêu chí cuối, khác **thời điểm** kiểm. Máy merge theo pha bằng khoá `delivery_phase: build|harden` của `xt.yaml`
   — build hoãn review thành nợ (trừ PR rủi ro cao — ADR-0062), G7 đòi harden và hết nợ (ADR-0031 của repo khung). **Pha build (`/autopilot`, ADR-0046) dùng đầu
   ra mức S cho G0–G4 ở mọi quy mô** (đọc repo, `compose` không tick, PLAN có Gate + Given/When/Then ngắn; `PROJECT.md`/SPEC
   riêng/research chỉ khi thêm phụ thuộc, dịch vụ, luật ngành hoặc nghiệp vụ không tầm thường); mỗi đợt xong (task xanh, MUST
   blueprint còn mở ghi số, không chặn) → audit delta → sửa/đợt kế, lặp tới khi **hết việc** (PLAN hết task, 0 MUST mở ngoài việc chờ người, 0 🔴/🟠) và audit toàn diện sạch, rồi đề xuất `/complete` (ADR-0047); phần đầy đủ theo quy mô thật (C4, hợp đồng API, threat model, SPEC đủ
   ca biên) và G7 thuộc pha hoàn thiện (`/complete`). Sàn an toàn (guard, điểm dừng, Gate máy, CI xanh) không đổi theo pha.
7. **Ba giai đoạn sản phẩm khoá tuần tự (ADR-0058 của repo khung).** Trên cùng chu trình Ý tưởng → Nghiên cứu → Đặc tả →
   Thiết kế → Lập trình → Kiểm thử → Audit → Tối ưu → Production → Vận hành → Tăng trưởng, dự án đi **MVP** (bản thử chủ dự án
   duyệt) → **hoàn thiện** (phạm vi đã duyệt, G7, phát hành) → **tối ưu** (cải tiến có số). Giai đoạn chưa được **người** duyệt
   (`xt.py stage approve`) thì giai đoạn sau khoá bằng máy: PLAN khai `Giai đoạn sản phẩm: N (C-NNN)`, `loop` từ chối giai đoạn
   khoá, `release-check` FAIL ở MVP. Giai đoạn ≠ pha build/harden (chế độ kiểm soát merge). Dùng khi có `docs/autopilot/STAGE.json`
   (`xt.py stage init`); ma trận 11 bước × 3 giai đoạn: `docs/autopilot/upgrades/2026-10-29-three-stage-delivery.md` của repo khung.

## Quy mô S/M/L — làm nhẹ đi chứ không bỏ

| Quy mô | Ví dụ | Khác biệt |
|---|---|---|
| **S** | Prototype, công cụ nội bộ, MVP chưa có người dùng thật | G2–G4 gộp thành một tài liệu ngắn; chỉ **sàn** bắt buộc: MUST của baseline + hồ sơ + gói ngành; MUST của module chuyên sâu và mọi `MUST@M`/`MUST@L` thành SHOULD (ADR-0003) |
| **M** | Production có người dùng thật, đội nhỏ | Đủ 9 GĐ; mọi `MUST` và `MUST@M` bắt buộc — tối đa 4 mỗi module (ADR-0004) |
| **L** | Quy mô lớn, nhiều đội, dữ liệu nhạy cảm, ngành bị quản lý | Thêm `MUST@L`; review bảo mật độc lập; diễn tập DR; tuân thủ có kiểm toán |

## Ánh xạ sang chế độ tự động

Khi chạy **autopilot** (xem [`../11-autonomous-loop/README.md`](../11-autonomous-loop/README.md)): G0–G4 diễn ra trong
pha *lập kế hoạch* và kết thúc bằng **một cổng duyệt duy nhất** — phiên chính tự duyệt `PLAN.md` theo tiêu chí chất
lượng cuối và ghi `D-NNN` (ADR-0008). Sau đó G5–G6 chạy tự động trong vòng lặp có bằng chứng: đợt build xong → audit delta → đợt kế tới khi hết việc (ADR-0047); G7 chạy bằng
`/complete` (pha harden, ADR-0046) cùng vòng lặp đó (hàng `perf` đỏ → task hiệu năng trong PLAN-harden; `/optimize` chỉ sau `done`, ADR-0048) — rồi `release-check` + người ký
`GO-NO-GO.md` (một điểm xác nhận spec/UX/bảo mật); G8: số thật vào `docs/ops/FIELD-<ngày>.json` → `/optimize --field` (có sổ giai đoạn: chỉ giai đoạn 3) → `release-check` + ký delta; điểm quyết định chuyên
môn tự duyệt và ghi lại, chỉ dừng ở các **điểm dừng bắt buộc về hành động** (thao tác không thể hoàn tác, tiền thật, dữ
liệu người dùng thật, đối ngoại/production, nới cổng) — xem [`../11-autonomous-loop/stop-points-and-escalation.md`](../11-autonomous-loop/stop-points-and-escalation.md).

## Nguồn

- Khung cũ X-stored `01-process-and-standards.md` (9 giai đoạn + cổng), commit `1b80fe4`.
- `seeker19110/projects-template` `docs/framework/standard-delivery.md` (9 cổng Frame→Reconcile), đọc 2026-10-13.
- C4 model: <https://c4model.com/> (xác minh 2026-10-13).
