---
title: Danh sách phụ thuộc có hạn và gia hạn
kind: handover
updated: 2026-10-25
---

# Phụ thuộc có hạn (PM-HANDOVER-009)

> Mọi thứ hết hạn được (tên miền, chứng chỉ, giấy phép, gói SaaS, khoá API, thẻ thanh toán, ngoại lệ có hạn) có một dòng.
> `scripts/ops-registers.mjs` (job gate): ngày ở cột "Hết hạn" đã qua ⇒ **đỏ**; còn ≤ 30 ngày ⇒ **cảnh báo** trong CI; dòng
> `security.txt` và các ngoại lệ trong `license-policy.json` phải khớp ngày với tệp gốc. Mục chưa mua ghi `—` (điền khi có — việc
> của người). Không ghi bí mật ở đây (`docs/handover/accounts.md` ghi nơi lưu bí mật).

| Mục | Loại | Hết hạn | Chủ gia hạn (vai trò) | Gia hạn bằng | Ghi chú |
|---|---|---|---|---|---|
| `apps/web/public/.well-known/security.txt` (Expires) | khai báo bảo mật | 2027-10-24 | Tech Lead | sửa `Expires` (≤ 1 năm) | RFC 9116; test community-files cũng nhắc |
| Ngoại lệ giấy phép `@img/sharp-libvips-linux-x64` | ngoại lệ có hạn | 2026-12-31 | Tech Lead | rà lại `license-policy.json` | D-061, D-114 |
| Ngoại lệ giấy phép `parse-cache-control` | ngoại lệ có hạn | 2027-04-18 | Tech Lead | rà lại `license-policy.json` | D-068 |
| Luật bỏ qua grype (`.grype.yaml`) | ngoại lệ có hạn | — | Tech Lead | `scripts/grype-ignore-check.mjs` tự đỏ khi quá hạn | hạn từng luật trong tệp |
| Tên miền (`HM_DOMAIN`, `HM_FILES_DOMAIN`) | tên miền | — | chủ dự án | nhà đăng ký (chưa mua) | bật tự gia hạn khi mua |
| Chứng chỉ TLS (Let's Encrypt qua Caddy) | chứng chỉ | — | vận hành | Caddy tự gia hạn (bằng chứng: log Caddy khi có VPS) | chưa có tên miền |
| VPS tại Việt Nam | gói dịch vụ | — | chủ dự án | nhà cung cấp (chưa chọn) | |
| SMTP relay | gói dịch vụ / khoá API | — | vận hành | nhà cung cấp (chưa chọn) | |
| Kho sao lưu khác máy | gói dịch vụ | — | vận hành | nhà cung cấp (chưa chọn) | |
| Thẻ thanh toán cho các dịch vụ trên | thẻ | — | chủ dự án | — | ghi tháng hết hạn thẻ (không ghi số thẻ) |
