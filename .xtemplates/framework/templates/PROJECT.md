---
title: Mẫu PROJECT
kind: template
updated: 2026-10-15
---

# Mẫu PROJECT.md

> **Ai viết:** người chủ sản phẩm cùng AI (G0–G1), cập nhật khi đổi phạm vi. **Giai đoạn:** G0 Frame (mục 1–3, 8) → G1 Classify (mục 0) → G2 Research (mục 6–7).
> **Cổng dùng:** G0 (≥1 chỉ số đo được, "không làm" ghi rõ), G1 (`xt.py compose` chạy được), `PM-REQ-*`, `PM-PRIO-*`.
> **Cách điền:** thay `<...>`; không có thì ghi "không áp dụng — lý do", không xoá mục. ID `R-NNN`/`F-NNN`/`RK-NNN` không tái sử dụng.
> Đây là nguồn sự thật về *cái gì cần xây*; quyết định kỹ thuật ở ADR, kế hoạch ở `PLAN.md`.

```markdown
# PROJECT.md — <Tên dự án>

> Cổng G0: duyệt bởi <tên> ngày <YYYY-MM-DD> · Cổng G1: <tên> ngày <YYYY-MM-DD> · Phiên bản tài liệu: <n>

## 0. Loại dự án & hồ sơ
- Hồ sơ (`xt.py list profiles`): <web-app | api-service | mobile-app | ...>
- Gói ngành (0..n): <ecommerce, fintech, ... | không>
- Quy mô: <S | M | L> — lý do: <người dùng thật? tiền thật? dữ liệu nhạy cảm?>
- Blueprint: `python3 .xtemplates/scripts/xt.py compose --profile <p> [--industry <i>] --scale <S|M|L> --out BLUEPRINT.md`

## 1. Vấn đề & người dùng
- Vấn đề (1–2 câu, không chứa giải pháp): <ai, trong tình huống nào, đau ở đâu>
- Người dùng mục tiêu: <nhóm cụ thể, không "mọi người">
- JTBD: Khi <tình huống>, tôi muốn <động cơ>, để <kết quả>.
- Hiện trạng (cách đang xoay sở): <quy trình hiện tại, thời gian/lỗi đo được>
- Bằng chứng nhu cầu: <link ghi chú phỏng vấn / ticket / số liệu + ngày>
- Giải pháp thay thế / đối thủ: | Tên | URL (ngày xem) | Họ thiếu gì | Mình khác gì |

## 2. Chỉ số thành công
| ID | Chỉ số (công thức: tử số / mẫu số / cửa sổ) | Baseline (ngày) | Mục tiêu | Hạn | Sự kiện đo |
|---|---|---|---|---|---|
| M-01 | <North Star> | <số hoặc "chưa đo — đo ngày ...">| <số> | <ngày> | <tên sự kiện> |
| M-02 | <chỉ số đầu vào> | | | | |

## 3. Phạm vi MVP (MoSCoW)
| ID | Tính năng | Mức | Spec | Ước lượng P50–P90 | Ghi chú |
|---|---|---|---|---|---|
| F-001 | <tính năng> | Must | docs/specs/SPEC-<slug>.md | <0,5–2 ngày> | |
| F-002 | <tính năng> | Should | | | |
Tổng nỗ lực Must / tổng: <x%> (≤ 60%).

### Không làm (Won't — lúc này)
- <Mục> — lý do: <...> (file `.out-of-scope/<slug>.md` nếu có)

## 4. Luồng người dùng chính (bắt buộc có E2E)
1. <Luồng A — R-001>: <bước 1> → <bước 2> → <kết quả>
2. <Luồng B — R-002>: ...

## 5. Yêu cầu phi chức năng
| Nhóm | Ngưỡng | Nguồn ngưỡng | Cách đo |
|---|---|---|---|
| Hiệu năng | <CWV / p95 / thời gian chạy> | <link> | <Lighthouse CI / k6 / benchmark> |
| Bảo mật | <mức ASVS / cổng blueprint> | | |
| Tiếp cận | <WCAG 2.2 AA> | | |
| Nền tảng/thiết bị | <trình duyệt, OS, kích thước màn hình> | | |

## 6. Dữ liệu & pháp lý
- Có dữ liệu cá nhân? <có/không> — loại: <cơ bản / nhạy cảm: ...>
- Có tiền thật / thanh toán? <có/không>
- Luật áp dụng: | Văn bản (số hiệu đầy đủ) | Hiệu lực | URL | Ghi chú "kiểm tra văn bản sửa đổi" |
- DPIA: <docs/DPIA.md | không áp dụng — lý do>

## 7. Stack & kiến trúc (tóm tắt — chi tiết ở ADR)
| Thành phần | Lựa chọn | Phiên bản (ngày xác minh) | ADR |
|---|---|---|---|
| <ngôn ngữ/runtime> | | | docs/adr/0001-... |

## 8. Giả định, rủi ro, ràng buộc
| Giả định | Cách kiểm chứng | Hạn | RK / bằng chứng |
|---|---|---|---|
| <giả định nguy hiểm nhất> | <spike/phỏng vấn/dữ liệu> | <ngày> | RK-001 |
- Ràng buộc cứng: <ngân sách, nền tảng bắt buộc, tích hợp bắt buộc>
- Hạn thật (có hậu quả ngoài): <ngày — hậu quả> · Hạn mong muốn: <ngày>

## 9. Các bên
| Vai trò | Tên | Quyết định gì | Kênh | Người thay thế |
|---|---|---|---|---|

## 10. Câu hỏi mở
- [ ] <câu hỏi> — [chặn]/[không chặn] — Đã quyết: D-<NNN> (phiên chính) hoặc <người> (<ngày>) — <câu trả lời>
```
