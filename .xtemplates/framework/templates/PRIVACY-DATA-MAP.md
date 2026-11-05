---
title: Mẫu sổ dữ liệu cá nhân và bên xử lý
kind: template
updated: 2026-11-02
---

# Mẫu docs/privacy/data-map.yaml và docs/privacy/processors.md

> **Ai viết:** người xây (trường, bảng, nơi lưu) + người phụ trách bảo vệ dữ liệu (căn cứ, thời hạn, hợp đồng). **Giai
> đoạn:** G3 (bản đầu cùng SPEC), cập nhật trong cùng PR thêm cột/SDK/nhà cung cấp. **Cổng dùng:** `CMP-PRIV-001`
> ([`../16-compliance-privacy/privacy-by-design.md`](../16-compliance-privacy/privacy-by-design.md)), `CMP-VN-015`
> ([`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md)), `CMP-INTL-003/004`,
> `CMP-AUDIT-007`. Căn cứ pháp lý và thời hạn: theo các module đó (không chép lại luật ở đây).
> **Luật:** máy đọc được (YAML) để script so schema ↔ sổ; mỗi trường có phân loại, mục đích, thời hạn lưu; mỗi bên xử
> lý có hợp đồng/DPA và nơi lưu (trong/ngoài Việt Nam).

````yaml
# docs/privacy/data-map.yaml — cập nhật <YYYY-MM-DD>
systems:
  - name: <postgres-prod>
    location: <vn-hcm | ap-southeast-1>   # nơi lưu thật — ngoài VN thì cần hồ sơ chuyển dữ liệu
    tables:
      - name: <users>
        fields:
          - column: <email>
            category: <thuong>             # thuong | nhay_cam | tre_em
            purpose: <đăng nhập, gửi thông báo đơn hàng>
            legal_basis: <đồng ý | hợp đồng | nghĩa vụ pháp lý — theo module 16>
            retention: <P30D | until-account-deleted>  # ISO 8601 duration hoặc until-account-deleted (CMP-PRIV-002)
            access: <role:support (xem che một phần)>
            copies: [<backup-s3>, <replica-doc>, <kho-phan-tich>]  # nơi sao chép: bản sao lưu, replica, kho phân tích, log
            shared_with: [<sendgrid>]      # tên ở processors.md
````

````markdown
# Bên xử lý dữ liệu — <Tên sản phẩm> · cập nhật <YYYY-MM-DD>

| Bên xử lý | Dịch vụ | Dữ liệu nhận (trường ở data-map) | Nơi lưu | Hợp đồng/DPA (ngày, link nội bộ) | Bên xử lý phụ đã biết | Rà gần nhất |
|---|---|---|---|---|---|---|
| <SendGrid> | <gửi email> | <email, tên> | <US> | <DPA ký YYYY-MM-DD> | <…> | <YYYY-MM-DD> |
````
