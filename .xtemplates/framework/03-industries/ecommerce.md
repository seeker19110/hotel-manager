---
title: Thương mại điện tử · bán lẻ · marketplace
kind: industry
slug: ecommerce
prefix: IND-ECOM
modules: [16-compliance-privacy/*, 12-security/appsec-web, 12-security/logging-audit-and-incident, 12-security/secrets-management, 09-database/transactions-and-consistency, 09-database/indexing-and-query-performance, 09-database/search-and-vector, 08-backend/integrations-and-webhooks, 08-backend/background-jobs-and-queues, 08-backend/caching, 08-backend/api-design, 18-cross-cutting/units-time-and-money, 18-cross-cutting/i18n-and-l10n, 07-frontend/performance-web-vitals, 07-frontend/forms-and-validation, 06-design-ux/accessibility, 06-design-ux/ui-states-and-feedback, 14-testing-quality/performance-and-load, 14-testing-quality/e2e-and-accessibility, 17-product-project/metrics-and-analytics]
updated: 2026-10-13
---

# Gói ngành: Thương mại điện tử · bán lẻ · marketplace

> Ghép cho web/app **bán hàng hoá, dịch vụ** hoặc **sàn trung gian** (marketplace, livestream bán hàng, affiliate).
> Lõi nghiệp vụ là giỏ hàng → đơn → thanh toán → kho → giao → trả; luật mới của Việt Nam (Luật TMĐT 2025, hiệu lực
> 01/07/2026) siết định danh người bán, livestream, trách nhiệm sàn và thuế. Thanh toán chi tiết ở gói
> [`fintech.md`](fintech.md); giao nhận ở [`logistics.md`](logistics.md).

## Khi nào dùng

Dùng khi có **đặt hàng trực tuyến** (kể cả đặt rồi trả tiền khi nhận), có **tồn kho/giá/khuyến mãi**, hoặc là **nền
tảng trung gian** cho nhiều người bán. Cửa hàng chỉ giới thiệu sản phẩm, không đặt hàng → không cần gói này.

## Kiến trúc tham chiếu

```text
[Storefront web/app (SSR/ISR + CDN)] ──► [BFF/API] ──► Catalog · Pricing/Promo · Cart · Checkout · Order (state machine)
                                                   ├─ Inventory (reservation có TTL, không âm)
                                                   ├─ Payment (PSP, idempotent, webhook) → xem fintech
                                                   ├─ Fulfillment/Shipping (3PL API) → xem logistics
                                                   ├─ Search (index từ catalog, eventual)
                                                   └─ Notification/Invoice (hoá đơn điện tử NĐ 70/2025)
[Seller portal] ──► định danh người bán (Luật TMĐT Đ.17), quy chế, khiếu nại có người giám sát
```

## Thành phần đặc thù khuyến nghị (xác minh lại trước khi dùng)

| Thành phần | Mặc định | Ghi chú |
|---|---|---|
| Giá & tiền | Số nguyên đơn vị nhỏ nhất, giá đã gồm VAT ghi rõ; làm tròn một lần ở dòng và ở tổng theo quy tắc công bố | [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md) |
| Tồn kho | Bảng `stock(sku, warehouse, on_hand, reserved)` + `reservation(ttl)`; `CHECK on_hand - reserved >= 0` | Over-selling có chủ đích phải là cấu hình, không phải lỗi |
| Đơn hàng | State machine `created → paid/cod_confirmed → packed → shipped → delivered → completed / cancelled / returned` | Mọi chuyển trạng thái idempotent, có lý do |
| Khuyến mãi | Rule engine với thứ tự áp dụng, tính "stackable", giới hạn ngân sách và số lần/khách | Lưu snapshot khuyến mãi đã áp vào đơn |
| Tìm kiếm | Index từ catalog qua event (eventual), fallback DB | [`../09-database/search-and-vector.md`](../09-database/search-and-vector.md) |
| Hoá đơn | Hoá đơn điện tử có mã cơ quan thuế qua nhà cung cấp được phép | NĐ 123/2020 sửa bởi NĐ 70/2025 |

## Khung pháp lý

**Việt Nam (xác minh 2026-10-13 — kiểm tra văn bản sửa đổi/thay thế trước khi áp dụng):**

| Văn bản | Ban hành · Hiệu lực | Nội dung với phần mềm | Nguồn |
|---|---|---|---|
| Luật Thương mại điện tử 122/2025/QH15 | 10/12/2025 · 01/07/2026 (thay khung NĐ 52/2013 + NĐ 85/2021) | Đ.11 công khai thông tin; Đ.15 trách nhiệm chung; Đ.17 sàn trung gian: xác thực điện tử danh tính người bán, kiểm duyệt hàng, dữ liệu hàng hoá truy cập ≥ 1 năm, dữ liệu hợp đồng ≥ 3 năm, báo trước 5 ngày khi khoá người bán, khiếu nại trực tuyến có giám sát của con người; Đ.22–26 livestream/affiliate; Đ.27–32 xuyên biên giới | thuvienphapluat 662035; hethongphapluat Đ.17 |
| NĐ 248/2026/NĐ-CP | 30/06/2026 · 01/07/2026 | Chi tiết Luật TMĐT: thông tin phải công khai, thủ tục thông báo/đăng ký nền tảng, quy chế hoạt động, Ngày TMĐT quốc gia | moit.gov.vn |
| NĐ 52/2013/NĐ-CP + NĐ 85/2021/NĐ-CP | 85/2021: 25/09/2021 · 01/01/2022 | Khung cũ — hết hiệu lực theo Luật TMĐT 2025 từ 01/07/2026; chỉ dùng cho hành vi trước ngày đó | caselaw 408202 |
| Luật Bảo vệ quyền lợi người tiêu dùng 19/2023/QH15; NĐ 55/2024/NĐ-CP | 20/06/2023 · 01/07/2024; NĐ 16/05/2024 · 01/07/2024 | Hợp đồng mẫu/điều kiện giao dịch chung, giao dịch từ xa, người tiêu dùng dễ bị tổn thương, trách nhiệm nền tảng số | moit.gov.vn |
| NĐ 98/2020/NĐ-CP + NĐ 24/2025/NĐ-CP | 24/2025: hiệu lực 21/02/2025 | Xử phạt thương mại, Điều 53a vi phạm giao dịch trên không gian mạng | hcc.nghean.gov.vn |
| NĐ 123/2020/NĐ-CP + NĐ 70/2025/NĐ-CP | 01/07/2022; 70/2025: 20/03/2025 · 01/06/2025 | Hoá đơn điện tử: thời điểm lập, nội dung người mua (số định danh), nhà cung cấp nước ngoài tự nguyện dùng | thuvienphapluat |
| Luật Thuế GTGT 48/2024/QH15; NĐ 117/2025/NĐ-CP; NĐ 68/2026/NĐ-CP | 01/07/2025; 117: 01/07/2025; 68: 05/03/2026 | Sàn có chức năng thanh toán khấu trừ, kê khai, nộp thuế thay hộ/cá nhân kinh doanh theo từng giao dịch; ngưỡng 500 triệu/năm theo NĐ 68 (**quan hệ thay thế NĐ 117 chưa xác minh**) | luatvietnam |
| Luật Quảng cáo sửa đổi 75/2025/QH15 | 16/06/2025 · 01/01/2026 | Đ.15a người có ảnh hưởng: xác minh người quảng cáo, thông báo rõ nội dung quảng cáo; MXH phải phân biệt quảng cáo | luatvietnam 404208 |
| Luật BVDLCN 91/2025/QH15 + NĐ 356/2025 | 01/01/2026 | Đồng ý theo mục đích, tiếp thị, cookie; Đ.28 quảng cáo | xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) |
| Luật Giao dịch điện tử 20/2023/QH15 | 01/07/2024 | Hợp đồng điện tử, chứng thực hợp đồng điện tử trong thương mại | thuvienphapluat 513347 |
| NĐ 333/2026/NĐ-CP Đ.19 | 19/08/2026 | TMĐT thuộc nhóm phải lưu dữ liệu người dùng tại VN (DN trong nước bắt buộc) | Công báo 499 |

**Quốc tế (xác minh 2026-10-13):** EU Consumer Rights Directive 2011/83/EU (rút lui 14 ngày) + Omnibus Directive
(EU) 2019/2161 · DSA Regulation (EU) 2022/2065 (áp dụng chung 17/02/2024; truy xuất người bán, notice-and-action) ·
GDPR · PSD2 SCA cho thanh toán EU · PCI DSS v4.0.1 · European Accessibility Act 2019/882 (áp dụng 28/06/2025 cho
dịch vụ TMĐT) · WCAG 2.2.

## Mô hình dữ liệu / nghiệp vụ đặc trưng

- **Catalog:** `product → variant(sku) → price_list(currency, valid_from/to) → stock(warehouse)`; thuộc tính theo danh mục.
- **Cart:** phiên tạm, giá được **chốt lại** khi vào checkout (không tin giá trong cart cũ).
- **Order:** snapshot bất biến của giá, thuế, khuyến mãi, địa chỉ tại thời điểm đặt; `order_line` không đổi sau khi đặt (đổi = huỷ/tạo mới hoặc return).
- **Inventory reservation:** giữ hàng có TTL khi vào checkout; commit khi thanh toán thành công/ COD xác nhận; release khi hết hạn.
- **Promotion:** mã, điều kiện, ngân sách, giới hạn/người, xếp chồng; `applied_promotions` lưu trong đơn.
- **Return/refund:** `return_request → approved → received → refunded (partial)`; đối chiếu với thanh toán.
- **Seller (marketplace):** `seller(identity_verified_at, documents, status)`, `payout`, `commission`.

## Ca biên nghiệp vụ

1. **Tồn kho âm do hai người mua sản phẩm cuối cùng cùng lúc:** reservation trong giao dịch có khoá hàng + `CHECK ≥ 0`; người đến sau nhận "hết hàng" chứ không "đã đặt".
2. **Giá đổi khi hàng đang trong giỏ:** checkout tính lại và hiển thị diff; đơn chốt giá tại thời điểm đặt, không phải lúc thêm giỏ.
3. **Mã giảm giá chồng (stacking):** 2 mã cùng loại, mã % + mã tiền, freeship + giảm giá — rule engine quy định thứ tự và giới hạn; tổng giảm không vượt giá trị đơn (không âm).
4. **Khuyến mãi hết ngân sách giữa lúc thanh toán:** giữ chỗ ngân sách khi vào checkout hoặc chấp nhận vượt có giới hạn; không được huỷ đơn đã thanh toán im lặng.
5. **Làm tròn thuế theo dòng ≠ theo tổng:** 3 dòng 33.333 đ + VAT 8% → chọn một quy tắc (theo dòng rồi cộng) và ghi trên hoá đơn đúng quy tắc đó.
6. **Trả hàng một phần nhiều lần + hoàn phí ship:** tổng hoàn ≤ đã trả; phí ship hoàn theo chính sách; khuyến mãi theo đơn phải phân bổ lại theo tỷ lệ.
7. **COD khách từ chối nhận:** đơn về `returned_to_sender`, tồn kho nhập lại chỉ sau khi kho xác nhận, không tự động.
8. **Webhook PSP đến trước khi đơn được tạo xong** (race): lưu sự kiện chờ, xử lý khi đơn tồn tại; không bỏ.
9. **Đổi địa chỉ sau khi đã packed:** phải qua trạng thái cho phép; phí ship tính lại; không sửa snapshot đơn gốc.
10. **Người bán bị tạm khoá khi còn đơn đang giao:** đơn vẫn phải hoàn tất; Luật TMĐT yêu cầu báo trước 5 ngày trừ khi cơ quan nhà nước yêu cầu.
11. **Flash sale:** hàng chục nghìn request/giây vào một SKU — hàng đợi + giới hạn + reservation; test tải trước.
12. **Múi giờ khuyến mãi "đến hết 30/6":** hết 23:59:59 giờ VN, server UTC; lưu `valid_to` có timezone.
13. **Hoá đơn lập sai thời điểm/sai người mua** (thiếu số định danh theo NĐ 70) → phải có luồng điều chỉnh/thay thế hoá đơn.

## Checklist

- [ ] `IND-ECOM-001` **MUST** Tồn kho không âm: reservation có TTL khi vào checkout, ràng buộc `on_hand - reserved >= 0` ở CSDL, commit/release idempotent. → Kiểm: test song song N người mua 1 đơn vị cuối → đúng 1 thành công; constraint tồn tại trong migration. · Nguồn: [`../09-database/transactions-and-consistency.md`](../09-database/transactions-and-consistency.md)
- [ ] `IND-ECOM-002` **MUST** Đơn hàng là snapshot bất biến (giá, thuế, khuyến mãi, địa chỉ, phiên bản điều khoản); giá chốt lại ở checkout, không tin giá trong giỏ/client. → Kiểm: test đổi giá sau khi thêm giỏ → checkout hiển thị giá mới; API đặt hàng bỏ qua giá client gửi lên. · Nguồn: Luật BVQLNTD 19/2023/QH15 (giao dịch từ xa); OWASP ASVS 5.0 V11
- [ ] `IND-ECOM-003` **MUST** Tiền/giá/thuế dùng số nguyên đơn vị nhỏ nhất, một hàm làm tròn, quy tắc công bố trên hoá đơn; test ca biên dòng/tổng. → Kiểm: lint cấm float trong module giá; test 3×33.333 đ + 8%. · Nguồn: ISO 4217; NĐ 123/2020/NĐ-CP (nội dung hoá đơn)
- [ ] `IND-ECOM-004` **MUST** Khuyến mãi qua rule engine: thứ tự áp dụng, giới hạn chồng, ngân sách, giới hạn/người; tổng giảm ≤ giá trị đơn; snapshot khuyến mãi lưu trong đơn. → Kiểm: bảng test ca chồng mã (%, tiền, freeship); test tổng không âm. · Nguồn: thực hành nội bộ; Luật BVQLNTD Đ.17 (thông tin chính xác)
- [ ] `IND-ECOM-005` **MUST** Trạng thái đơn/trả hàng/hoàn tiền theo state machine; chuyển trạng thái idempotent có lý do; hoàn tiền một phần nhiều lần không vượt số đã trả. → Kiểm: property test chuyển trạng thái; test hoàn 2 lần song song. · Nguồn: thực hành nội bộ; xem [`fintech.md`](fintech.md)
- [ ] `IND-ECOM-006` **MUST** Thanh toán qua PSP có token hoá, idempotency key, webhook xác minh chữ ký và xử lý idempotent; không lưu dữ liệu thẻ. → Kiểm: mục IND-FIN-003/004/007 đạt; quét repo không có PAN. · Nguồn: PCI DSS v4.0.1; [`fintech.md`](fintech.md)
- [ ] `IND-ECOM-007` **MUST** Công khai trên nền tảng thông tin bắt buộc: chủ sở hữu, điều kiện giao dịch chung, chính sách đổi trả/vận chuyển/thanh toán, giá đã gồm thuế, chi phí phát sinh trước khi đặt. → Kiểm: test E2E trang checkout hiển thị tổng cuối gồm thuế + phí trước nút đặt hàng; trang chính sách có phiên bản. · Nguồn: Luật TMĐT 122/2025/QH15 Đ.11; NĐ 248/2026/NĐ-CP; Luật BVQLNTD 19/2023/QH15
- [ ] `IND-ECOM-008` **MUST** Lưu và cho truy cập dữ liệu hàng hoá đã đăng ≥ 1 năm và dữ liệu hợp đồng/đơn hàng ≥ 3 năm kể từ giao kết (kể cả khi tài khoản người bán bị khoá); người bán tải được dữ liệu của mình. → Kiểm: retention trong data map ≥ 3 năm cho đơn; test người bán bị khoá vẫn tải được đơn cũ. · Nguồn: Luật TMĐT 122/2025/QH15 Đ.17 k.1e, k.2đ, k.2i
- [ ] `IND-ECOM-009` **MUST** Hoá đơn điện tử lập đúng thời điểm, đủ nội dung (số định danh người mua khi có), có mã cơ quan thuế khi thuộc diện; có luồng điều chỉnh/thay thế; lưu ≥ 10 năm. → Kiểm: tích hợp nhà cung cấp hoá đơn có test; job lập theo `business_date`; retention. · Nguồn: NĐ 123/2020/NĐ-CP sửa bởi NĐ 70/2025/NĐ-CP; Luật Kế toán 88/2015/QH13 Đ.41
- [ ] `IND-ECOM-010` **MUST** Thu thập/sử dụng dữ liệu khách hàng cho tiếp thị, cá nhân hoá, chia sẻ đối tác chỉ khi có đồng ý theo mục đích; cookie/tracking có tuỳ chọn từ chối. → Kiểm: mục CMP-VN-001/002/010 và [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md) đạt. · Nguồn: Luật 91/2025/QH15 Đ.9, Đ.28, Đ.29
- [ ] `IND-ECOM-011` **MUST@M** Marketplace: xác thực điện tử danh tính người bán (VNeID/giấy tờ hợp pháp với người bán nước ngoài) trước khi cho đăng bán; kiểm duyệt thông tin hàng hoá trước khi hiển thị; hệ thống khiếu nại trực tuyến có người giám sát quyết định. → Kiểm: test người bán chưa xác thực không đăng được sản phẩm; hàng chờ khiếu nại có người duyệt (không chỉ tự động). · Nguồn: Luật TMĐT 122/2025/QH15 Đ.17 k.1c, k.1đ, k.3, k.4
- [ ] `IND-ECOM-012` **MUST@M** Marketplace: tạm ngừng/chấm dứt tài khoản người bán có thông báo trước ≥ 5 ngày (trừ khi cơ quan nhà nước yêu cầu); gỡ hàng vi phạm theo quy chế có hệ thống rà soát/cảnh báo tự động (nền tảng lớn). → Kiểm: luồng khoá có bước thông báo + hẹn giờ; log quyết định. · Nguồn: Luật TMĐT 122/2025/QH15 Đ.17 k.2e, k.2g, k.3c
- [ ] `IND-ECOM-013` **MUST@M** Sàn có chức năng thanh toán khấu trừ, kê khai, nộp thuế thay hộ/cá nhân kinh doanh theo từng giao dịch thành công, có bảng kê và đối chiếu. → Kiểm: module thuế có test theo loại người bán (cư trú/không), báo cáo kỳ; đối chiếu tổng khấu trừ = Σ giao dịch. · Nguồn: Luật Thuế GTGT 48/2024/QH15; NĐ 117/2025/NĐ-CP; NĐ 68/2026/NĐ-CP
- [ ] `IND-ECOM-014` **MUST@M** Livestream bán hàng/affiliate: định danh người livestream, gắn nhãn nội dung quảng cáo, lưu bản ghi phiên theo quy chế. → Kiểm: tính năng livestream yêu cầu tài khoản đã xác thực; nhãn "quảng cáo" hiển thị (test E2E). · Nguồn: Luật TMĐT 122/2025/QH15 Đ.22–26; Luật Quảng cáo sửa đổi 75/2025/QH15 Đ.15a; NĐ 147/2024/NĐ-CP
- [ ] `IND-ECOM-015` **MUST** Đổi trả/huỷ: luồng tự phục vụ với thời hạn theo chính sách công bố (EU: 14 ngày rút lui), trạng thái minh bạch, hoàn tiền về đúng phương thức. → Kiểm: test E2E tạo yêu cầu trả → hoàn một phần; email/thông báo mỗi bước. · Nguồn: Luật BVQLNTD 19/2023/QH15; Directive 2011/83/EU Art. 9
- [ ] `IND-ECOM-016` **MUST** Checkout tiếp cận được (WCAG 2.2 AA), hoạt động bằng bàn phím, lỗi form rõ ràng, trạng thái tải/lỗi/rỗng đầy đủ; mobile-first. → Kiểm: axe trong E2E = 0 lỗi nghiêm trọng; Lighthouse a11y ≥ 90; xem [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md). · Nguồn: WCAG 2.2; EAA 2019/882
- [ ] `IND-ECOM-017` **SHOULD** Hiệu năng storefront: LCP ≤ 2,5 s p75 trang sản phẩm/danh mục, INP ≤ 200 ms; checkout không tải script bên thứ ba không cần thiết. → Kiểm: Lighthouse CI + RUM; xem [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md). · Nguồn: Core Web Vitals
- [ ] `IND-ECOM-018` **SHOULD** Test tải kịch bản flash sale (đỉnh ×10 bình thường) trước mỗi chiến dịch lớn; hàng đợi/giới hạn cho SKU nóng. → Kiểm: báo cáo k6 với mục tiêu p95 và tỷ lệ lỗi < 0,1%; xem [`../14-testing-quality/performance-and-load.md`](../14-testing-quality/performance-and-load.md). · Nguồn: thực hành nội bộ
- [ ] `IND-ECOM-019` **SHOULD** Khuyến mãi/giá có `valid_from/valid_to` kèm múi giờ; hiển thị theo giờ người dùng; test biên 23:59:59 giờ VN. → Kiểm: test đơn vị với timezone. · Nguồn: [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md)
- [ ] `IND-ECOM-020` **SHOULD** Chống gian lận đơn (địa chỉ ảo, lạm dụng mã, bom hàng COD) bằng điểm rủi ro + review; không chặn vĩnh viễn tự động. → Kiểm: metric `fraud_hold_rate`; hàng chờ review có SLA. · Nguồn: thực hành nội bộ
- [ ] `IND-ECOM-021` **SHOULD** Phân tích sản phẩm (funnel, conversion) không chứa PII trực tiếp; ID giả danh hoá; sự kiện có schema versioned. → Kiểm: schema sự kiện trong repo; quét PII trong analytics. · Nguồn: [`../17-product-project/metrics-and-analytics.md`](../17-product-project/metrics-and-analytics.md); Luật 91/2025/QH15
- [ ] `IND-ECOM-022` **MAY** Dùng dịch vụ chứng thực hợp đồng điện tử trong thương mại cho đơn giá trị lớn/B2B. → Kiểm: hợp đồng có mã chứng thực. · Nguồn: Luật TMĐT 122/2025/QH15 Đ.3 k.15, Đ.33–36
- [ ] `IND-ECOM-023` **MAY** Bán xuyên biên giới vào EU: thực hiện DSA Art. 30 (truy xuất người bán) và quyền rút lui 14 ngày; vào VN từ nước ngoài: đại diện uỷ quyền theo Luật TMĐT Chương IV. → Kiểm: ADR pháp lý theo thị trường. · Nguồn: DSA 2022/2065; Luật TMĐT 122/2025/QH15 Đ.27–32

## Cổng chất lượng tương đương

| Cổng chung | Tương đương TMĐT | Ngưỡng |
|---|---|---|
| CWV | LCP ≤ 2,5 s · INP ≤ 200 ms · CLS ≤ 0,1 (p75, trang PDP/PLP/checkout) | Lighthouse CI + RUM |
| Tải | Flash sale ×10 với p95 đặt hàng ≤ 1 s, lỗi < 0,1% | k6 |
| Đúng dữ liệu | 0 tồn kho âm; Σ hoàn ≤ Σ thu; hoá đơn = đơn (đối chiếu ngày) | job + alert |
| Pháp lý | Thông tin công khai Đ.11, định danh người bán, retention 1/3 năm, thuế thay ✅ | GO/NO-GO |
| A11y | WCAG 2.2 AA checkout, 0 lỗi axe nghiêm trọng | CI |

## Bẫy

- **Tính giá ở client rồi tin** → mua 0 đồng. Chốt ở server.
- **Khuyến mãi cộng dồn không giới hạn** → đơn âm, mất ngân sách.
- **Giảm tồn kho khi thêm vào giỏ** → kho "ảo hết hàng"; hoặc giảm khi giao → oversell. Dùng reservation có TTL.
- **Index tìm kiếm hiển thị giá cũ** → mâu thuẫn; luôn chốt giá từ nguồn sự thật khi checkout.
- **Dựa vào NĐ 52/2013 & 85/2021** sau 01/07/2026.
- **Marketplace "tự động khoá" người bán bằng model** không người giám sát → vi phạm Đ.17 k.4.
- **Thuế thay tính trên đơn tạo** thay vì giao dịch thành công → sai kỳ, sai số.
- **Cookie consent chỉ là banner** nhưng script tracking vẫn chạy trước khi đồng ý.

## Nguồn

- Luật Thương mại điện tử 122/2025/QH15 (10/12/2025, hiệu lực 01/07/2026): <https://thuvienphapluat.vn/van-ban/Thuong-mai/Luat-Thuong-mai-dien-tu-2025-so-122-2025-QH15-662035.aspx>; Đ.17 đối chiếu <https://hethongphapluat.com/luat-thuong-mai-dien-tu-2025/dieu-17> — xác minh 2026-10-13; kiểm tra văn bản sửa đổi/thay thế trước khi áp dụng.
- NĐ 248/2026/NĐ-CP (30/06/2026, hiệu lực 01/07/2026): <https://moit.gov.vn/tin-tuc/bo-cong-thuong-pho-bien-luat-thuong-mai-dien-tu-va-nghi-dinh-so-248-2026-nd-cp.html> — xác minh 2026-10-13.
- NĐ 85/2021/NĐ-CP (25/09/2021, hiệu lực 01/01/2022) sửa NĐ 52/2013/NĐ-CP: <https://caselaw.vn/van-ban-phap-luat/408202-nghi-dinh-so-85-2021-nd-cp-ngay-25-09-2021-cua-chinh-phu-sua-doi-nghi-dinh-52-2013-nd-cp-ve-thuong-mai-dien-tu> — xác minh 2026-10-13.
- Luật Bảo vệ quyền lợi người tiêu dùng 19/2023/QH15 (20/06/2023, hiệu lực 01/07/2024) và NĐ 55/2024/NĐ-CP (16/05/2024, hiệu lực 01/07/2024): <https://moit.gov.vn/tin-tuc/bao-chi-voi-nguoi-dan/cac-van-ban-quy-pham-phap-luat-ve-bao-ve-quyen-loi-nguoi-tieu-dung-co-hieu-luc-tu-ngay-01-7-2024.html> — xác minh 2026-10-13.
- NĐ 24/2025/NĐ-CP (hiệu lực 21/02/2025) sửa NĐ 98/2020/NĐ-CP: <https://hcc.nghean.gov.vn/laws/detail/Nghi-dinh-so-24-2025-ND-CP-cua-Chinh-phu-Sua-doi-bo-sung-mot-so-dieu-cua-Nghi-dinh-so-98-2020-ND-CP-ngay-26-thang-8-nam-2020-cua-Chinh-phu-quy-dinh-xu-phat-vi-pham-hanh-chinh-trong-hoat-dong-thuong-mai-san-xuat-buon-ban-hang-gia-hang-cam-va-bao-1695/> — xác minh 2026-10-13.
- NĐ 70/2025/NĐ-CP (20/03/2025, hiệu lực 01/06/2025) sửa NĐ 123/2020/NĐ-CP: <https://thuvienphapluat.vn/hoi-dap-phap-luat/diem-moi-ve-dang-ky-su-dung-hoa-don-dien-tu-theo-nghi-dinh-70-138046958.html> — xác minh 2026-10-13.
- Luật Thuế GTGT 48/2024/QH15 (hiệu lực 01/07/2025); NĐ 117/2025/NĐ-CP (hiệu lực 01/07/2025): <https://luatvietnam.vn/thue-phi-le-phi/ho-ca-nhan-kinh-doanh-online-bi-khau-tru-thue-bao-nhieu-565-102490-article.html>; NĐ 68/2026/NĐ-CP (05/03/2026): <https://luatvietnam.vn/thue-phi-le-phi/tong-hop-van-ban-huong-dan-thue-hoa-don-tren-san-thuong-mai-dien-tu-565-111128-article.html> — xác minh 2026-10-13 (nguồn thứ cấp; quan hệ thay thế 117↔68 chưa xác minh).
- Luật Quảng cáo sửa đổi 75/2025/QH15 (16/06/2025, hiệu lực 01/01/2026): <https://luatvietnam.vn/thuong-mai/luat-quang-cao-sua-doi-2025-so-75-2025-qh15-404208-d1.html> — xác minh 2026-10-13.
- Consumer Rights Directive 2011/83/EU; DSA Regulation (EU) 2022/2065 (17/02/2024): <https://eumonitor.eu/9353000/1/j9vvik7m1c3gyxp/vlxjdfijgixk> — xác minh gián tiếp 2026-10-13 (EUR-Lex không truy cập được qua công cụ).
- European Accessibility Act 2019/882 (áp dụng 28/06/2025): <https://digital-strategy.ec.europa.eu/en/policies/changes-accessibility-standard> — xác minh 2026-10-13.
- Nghiên cứu nền: `research/2026-10-13-stored-catalog-extraction.md` §2.5 (checklist go-live), §2.16.
