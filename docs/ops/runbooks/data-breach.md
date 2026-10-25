---
title: Runbook — vi phạm dữ liệu cá nhân
kind: runbook
updated: 2026-10-25
last_drilled: chưa diễn tập (tabletop đầu tiên: trước khi dùng dữ liệu thật)
owner: (chưa gán — pháp lý + Tech Lead)
---

# Vi phạm dữ liệu cá nhân

> **Không phải tư vấn pháp lý.** Mọi thời hạn, cơ quan nhận và biểu mẫu dưới đây là **(chưa xác minh — cần pháp lý)**: dự án chưa đối chiếu văn bản gốc (`docs/research/2026-10-15-stack-va-phap-ly.md` §B không có mục thông báo vi phạm). Không điền số điều luật cho tới khi pháp lý xác nhận. Điều phối chung: [INCIDENT-RESPONSE](../INCIDENT-RESPONSE.md) (vi phạm dữ liệu = SEV1).

## Khi nào dùng
Có dấu hiệu dữ liệu cá nhân bị truy cập, tiết lộ, mất hoặc thay đổi trái phép: tổ chức này thấy dữ liệu tổ chức khác; lộ số/ảnh giấy tờ (CCCD/hộ chiếu); lộ khoá `HM_PII_KEYS`; lộ bản sao lưu hoặc file xuất; email/thông báo chứa dữ liệu gửi nhầm người; thiết bị nhân viên mất khi phiên còn sống. Nghi ngờ cũng chạy — đồng hồ tính từ lúc **phát hiện**, không phải lúc điều tra xong.

## Bảng thời hạn thông báo
| Đối tượng | Thời hạn | Cơ sở | Trạng thái xác minh |
|---|---|---|---|
| Cơ quan chuyên trách bảo vệ dữ liệu cá nhân (Bộ Công an) | 72 giờ kể từ khi phát hiện, khi vi phạm có thể gây hại | Luật BVDLCN 91/2025/QH15 và NĐ 356/2025/NĐ-CP (Mẫu số 08) theo `.xtemplates/framework/16-compliance-privacy/vietnam-data-law.md`; số điều lệch giữa các bản chép | (chưa xác minh — cần pháp lý) |
| Chủ thể dữ liệu (người thuê, khách, nhân viên) | (chưa xác minh — cần pháp lý) — nội dung và thời hạn do pháp lý xác định | — | (chưa xác minh — cần pháp lý) |
| Khách hàng của nền tảng (tổ chức/chủ cơ sở — bên kiểm soát dữ liệu) | Theo hợp đồng/DPA; đề xuất ≤ 72 giờ — **ghi ngày giờ gửi** | `IND-SAAS-010`: DPA mẫu chưa có | (chưa có DPA — cần pháp lý) |
| Cơ quan/đối tác khác (ngân hàng, nhà cung cấp) | Theo hợp đồng từng bên | — | (chưa có hợp đồng) |

Gửi **thông báo sơ bộ** trong thời hạn rồi bổ sung; không chờ có đủ kết luận.

## Thời hạn theo vùng (CMP-INTL-006)
Áp **thời hạn ngắn nhất** trong các vùng có chủ thể bị ảnh hưởng. Đồng hồ tính từ lúc *phát hiện/xác định* như cột "Mốc".

| Vùng | Cơ quan | Thời hạn | Mốc tính | Cơ sở | Xác minh |
|---|---|---|---|---|---|
| VN | Bộ Công an (cơ quan chuyên trách BVDLCN) | 72 giờ | phát hiện vi phạm có thể gây hại | Luật 91/2025/QH15; NĐ 356/2025/NĐ-CP (Mẫu số 08) | (chưa xác minh — cần pháp lý) |
| EU/EEA | cơ quan giám sát dẫn đầu | 72 giờ | biết (aware) có vi phạm | GDPR Art. 33(1) | (chưa xác minh — cần pháp lý) |
| UK | ICO | 72 giờ | biết có vi phạm | UK GDPR Art. 33 | (chưa xác minh — cần pháp lý) |
| Thái Lan | PDPC | 72 giờ | biết có vi phạm | PDPA 2019 s.37(4) | (chưa xác minh — cần pháp lý) |
| Singapore | PDPC | 3 ngày lịch | **sau khi xác định** vi phạm phải thông báo (đánh giá ≤ 30 ngày) | PDPA 2012 s.26D | (chưa xác minh — cần pháp lý) |

Hiện pilot chỉ có chủ thể ở VN (`docs/privacy/data-map.yaml`, region VN) ⇒ 72 giờ. Mở rộng vùng ⇒ cập nhật bảng và DPA.

## Điều kiện trước
- Đã tuyên bố SEV1 và có IC ([INCIDENT-RESPONSE](../INCIDENT-RESPONSE.md) §3.2).
- Đầu mối pháp lý đã được báo (chưa gán — chủ dự án cung cấp).
- Bảo toàn chứng cứ **trước** khi khởi động lại hoặc xoay khoá (mục 6 của tài liệu sự cố).

## Các bước
1. **Phát hiện và ghi giờ (UTC)**: ai, khi nào, bằng cách nào; mở dòng thời gian (mẫu ở INCIDENT-RESPONSE §7). Đồng hồ pháp lý bắt đầu.
2. **Đánh giá** (≤ 4 giờ): loại dữ liệu (giấy tờ nhạy cảm, SĐT/email/tên, dữ liệu tiền), số chủ thể và tổ chức bị ảnh hưởng, nguyên nhân còn tiếp diễn không, dữ liệu có được mã hoá khi lộ không (số giấy tờ AES-256-GCM; ảnh file riêng tư; bản sao lưu mã hoá). Truy vấn phạm vi từ `audit_events`, log Caddy/web (`correlation_id`), `files`, `export_jobs`. Tra bảng cột/nơi lưu ở [`docs/privacy/data-map.yaml`](../../privacy/data-map.yaml).
3. **Khoanh vùng**: dừng đường rò (rollback, thu hồi phiên/membership/liên kết khách, xoay bí mật theo [secret-leak](secret-leak.md), chặn route). Thao tác lên dữ liệu thật theo INCIDENT-RESPONSE §4–§5.
4. **Quyết nghĩa vụ thông báo** (pháp lý, ≤ 24 giờ từ phát hiện): có/không, đối tượng, nội dung. Ghi quyết định và người quyết vào dòng thời gian.
5. **Thông báo**: dùng mẫu bên dưới; mỗi thông báo ra ngoài cần chủ dự án duyệt (AGENTS §6). Lưu bản đã gửi + biên nhận.
6. **Khắc phục và theo dõi**: sửa gốc qua cổng thường; theo dõi dấu hiệu lạm dụng dữ liệu đã lộ; hỗ trợ chủ thể (đổi mật khẩu, cảnh giác giả mạo).
7. **Hậu kiểm** ≤ 5 ngày làm việc: post-mortem; cập nhật `docs/privacy/ROPA.md`, THREAT-MODEL, DPIA nếu rủi ro đổi.

## Mẫu thông báo
Điền chỗ `<…>`; **không** đưa dữ liệu cá nhân của người bị ảnh hưởng vào nội dung. Văn bản gửi cơ quan theo biểu mẫu chính thức (Mẫu 08 — chưa xác minh), không dùng mẫu dưới thay thế.

### Cơ quan có thẩm quyền (tóm tắt sơ bộ — dùng cùng biểu mẫu chính thức)
> Tổ chức/đầu mối: `<tên, liên hệ>`. Phát hiện lúc `<giờ UTC+7>` ngày `<ngày>`. Mô tả: `<chuyện gì xảy ra>`. Loại dữ liệu: `<loại>`. Số chủ thể ước tính: `<số>`. Hậu quả có thể: `<…>`. Biện pháp đã thực hiện và dự kiến: `<…>`. Sẽ cập nhật lúc: `<giờ>`.

### Chủ thể dữ liệu
> Chúng tôi phát hiện ngày `<ngày>` một sự cố bảo mật có thể liên quan đến `<loại dữ liệu>` của bạn. Chúng tôi đã `<biện pháp>`. Bạn nên `<việc cần làm: ví dụ đổi mật khẩu, cảnh giác tin nhắn giả mạo>`. Liên hệ: `<kênh>`. Chúng tôi sẽ thông tin thêm khi có kết quả điều tra.

### Khách hàng của nền tảng (chủ cơ sở)
> Ngày `<ngày>` chúng tôi phát hiện sự cố ảnh hưởng dữ liệu của tổ chức `<tên>`: `<phạm vi, loại dữ liệu, số hồ sơ>`. Nguyên nhân: `<đã biết/đang điều tra>`. Đã làm: `<…>`. Bạn có thể cần thông báo cho chủ thể/cơ quan theo nghĩa vụ của bên kiểm soát dữ liệu: `<hướng dẫn>`. Cập nhật kế tiếp: `<giờ>`.

## Xác minh
- Dòng thời gian có: giờ phát hiện, giờ quyết định thông báo, giờ gửi từng thông báo, biên nhận; mọi mốc ≤ thời hạn ở bảng (hoặc ghi lý do trễ).
- Đường rò đã chặn: yêu cầu thử lại cho kết quả 401/403/404; không còn truy cập lạ trong log 24 giờ.
- Bí mật liên quan đã xoay (đối chiếu bảng ở secret-leak).
- Bản ghi sự cố lưu trong `docs/ops/` (không chứa dữ liệu cá nhân).

## Liên hệ và leo thang
Pháp lý/DPO: (chưa gán). Chủ dự án duyệt thông báo: (chưa gán). Cơ quan nhận thông báo: (chưa xác minh — cần pháp lý). Danh sách đầy đủ: [INCIDENT-RESPONSE §8](../INCIDENT-RESPONSE.md).

## Diễn tập
Tabletop ≥ 1 lần/năm cho tình huống "ảnh CCCD của một tổ chức lộ"; biên bản ghi vào `last_drilled`. Người diễn tập không phải tác giả runbook. Chưa diễn tập lần nào.
