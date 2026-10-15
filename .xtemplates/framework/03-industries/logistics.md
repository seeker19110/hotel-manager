---
title: Logistics · vận tải · chuỗi cung ứng
kind: industry
slug: logistics
prefix: IND-LOGI
modules: [16-compliance-privacy/privacy-by-design, 16-compliance-privacy/vietnam-data-law, 16-compliance-privacy/consent-and-user-rights, 16-compliance-privacy/records-and-audit-readiness, 12-security/appsec-web, 12-security/infrastructure-and-network, 12-security/logging-audit-and-incident, 08-backend/integrations-and-webhooks, 08-backend/background-jobs-and-queues, 08-backend/realtime-and-streaming, 08-backend/reliability-and-errors, 08-backend/api-design, 09-database/transactions-and-consistency, 09-database/indexing-and-query-performance, 09-database/data-modeling, 18-cross-cutting/units-time-and-money, 14-testing-quality/integration-and-contract, 14-testing-quality/unit-and-logic-edge-cases, 15-operations/observability, 15-operations/slo-and-alerting, 05-architecture/integration-patterns]
updated: 2026-10-13
---

# Gói ngành: Logistics · vận tải · chuỗi cung ứng

> Ghép cho TMS/WMS/OMS, giao hàng chặng cuối, đặt xe/giao đồ ăn, chuyển phát/bưu chính, theo dõi đơn, kho lạnh, hải
> quan/xuất nhập khẩu, fleet/telematics. Đặc thù: **thế giới vật lý không khớp dữ liệu** (hàng ở đâu, cân nặng thật,
> địa chỉ sai), **hàng chục tích hợp** (3PL, hãng tàu, hải quan, bản đồ, thiết bị), **thời gian và địa lý** là trục chính,
> và dữ liệu vị trí tài xế/người nhận là dữ liệu cá nhân nhạy cảm.

## Khi nào dùng

Dùng khi hệ thống **điều phối hàng hoá/phương tiện/người giao** hoặc **theo dõi lô hàng** qua nhiều bên; gồm cả tính
năng giao hàng của sàn TMĐT (ghép cùng [`ecommerce.md`](ecommerce.md)). Phần thu hộ (COD) và đối soát tiền → [`fintech.md`](fintech.md).

## Kiến trúc tham chiếu

```text
[Khách/Seller] ─► [Order/Shipment API] ─► Shipment state machine (created → picked_up → in_transit → out_for_delivery → delivered / failed / returned)
                                           ├─ Routing/Dispatch (tối ưu tuyến, phân công; SLA theo vùng/khung giờ)
                                           ├─ Tracking ingest (GPS/thiết bị GSHT, scan mã SSCC/GS1-128, POD ảnh/chữ ký) — stream, idempotent, out-of-order
                                           ├─ Integration hub: 3PL/hãng vận chuyển (API/EDI), hải quan (VNACCS), bản đồ, SMS/Zalo — contract test, retry, DLQ
                                           ├─ Warehouse: tồn kho theo vị trí (bin), FIFO/FEFO, lô/hạn dùng, chuỗi lạnh (nhiệt độ)
                                           └─ Đối soát: COD, phí vận chuyển, hoàn hàng ↔ fintech
Dữ liệu vị trí: thu khi đang làm việc, tối thiểu hoá, retention ngắn; log bất biến cho tranh chấp
```

## Thành phần đặc thù khuyến nghị (xác minh lại trước khi dùng)

| Thành phần | Mặc định | Ghi chú |
|---|---|---|
| Định danh lô/kiện | GS1: SSCC (18 số) cho kiện/pallet, GTIN cho hàng, GLN cho địa điểm; mã vạch GS1-128/QR | (chưa xác minh phiên bản GS1 General Specifications 2026-10-13 — trang GS1 trả 403) |
| Điều kiện giao hàng quốc tế | Incoterms® 2020 (11 điều kiện) lưu theo hợp đồng/lô | ICC; chưa có phiên bản mới công bố (xác minh 2026-10-13) |
| Thời gian/địa lý | UTC + múi giờ địa điểm; toạ độ WGS84; geofence; ETA có khoảng tin cậy | [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md) |
| Đơn vị | SI (kg, m, m³), cân nặng quy đổi thể tích theo công thức công bố của hãng; tiền số nguyên | Không float cho cân nặng tính cước (dùng gram) |
| Tích hợp | API REST/webhook ký; EDI (EDIFACT/X12) với hãng lớn; contract test từng đối tác | [`../08-backend/integrations-and-webhooks.md`](../08-backend/integrations-and-webhooks.md) |
| Thiết bị | GSHT theo QCVN (NĐ 151/2024), camera; dữ liệu kết nối cơ quan quản lý | NĐ 158/2024 + 218/2026 |

## Khung pháp lý

**Việt Nam (xác minh 2026-10-13 — kiểm tra văn bản sửa đổi/thay thế trước khi áp dụng):**

| Văn bản | Ban hành · Hiệu lực | Nội dung với phần mềm | Nguồn |
|---|---|---|---|
| NĐ 163/2017/NĐ-CP kinh doanh dịch vụ logistics | 30/12/2017 · 20/02/2018 | Đ.3 danh mục dịch vụ (kho, xếp dỡ, chuyển phát, đại lý hải quan…); Đ.4 kinh doanh bằng phương tiện điện tử phải tuân thủ TMĐT; Đ.5 giới hạn trách nhiệm | thuvienphapluat 373059 |
| Luật Đường bộ 35/2024/QH15; Luật TTATGT đường bộ 36/2024/QH15 | 27/06/2024 · 01/01/2025 (thay Luật GTĐB 2008) | Kinh doanh vận tải, thiết bị giám sát hành trình, dữ liệu phương tiện | datafiles.chinhphu.vn (VBHN) |
| NĐ 158/2024/NĐ-CP hoạt động vận tải đường bộ (sửa bởi NĐ 218/2026/NĐ-CP 19/06/2026); NĐ 151/2024/NĐ-CP (GSHT, hiệu lực 01/01/2025) | 18/12/2024 · 01/01/2025 (chưa xác minh chính xác) | Điều kiện kinh doanh vận tải; bộ phận an toàn phân tích dữ liệu GSHT; thu hồi giấy phép khi sửa/làm sai lệch dữ liệu GSHT; kết nối dữ liệu tới cơ quan quản lý | luatvietnam 438376; hethongphapluat |
| Luật Bưu chính 49/2010/QH12; NĐ 47/2011/NĐ-CP (sửa NĐ 150/2018, NĐ 25/2022) | 17/06/2010 · 01/01/2011 (chưa xác minh); NĐ 17/06/2011 · 15/08/2011 | Giấy phép bưu chính/văn bản xác nhận cho chuyển phát; bồi thường thiệt hại; hợp đồng dịch vụ bưu chính điện tử (CV 3720/BTTTT-BC 2018) | thuvienphapluat 125633 |
| NĐ 34/2024/NĐ-CP hàng hoá nguy hiểm | 31/03/2024 · 15/05/2024 (Đ.9–12 đường bộ bãi bỏ bởi NĐ 161/2024 từ 01/01/2025) | 9 loại hàng nguy hiểm, giấy phép vận chuyển, miễn theo ngưỡng | caselaw 411891 |
| Luật Hải quan 54/2014/QH13 (sửa bởi Luật 90/2025/QH15 hiệu lực 01/07/2025; Luật 11/2026/QH16 hiệu lực 01/03/2027); NĐ 08/2015 + 59/2018 | — | Thủ tục hải quan điện tử (VNACCS/VCIS), một cửa quốc gia, quản lý rủi ro; hàng TMĐT xuất nhập khẩu (nghị định đang dự thảo) | thoibaotaichinhvietnam |
| Luật TMĐT 122/2025/QH15 Chương V | 01/07/2026 | Dịch vụ hỗ trợ TMĐT: logistics, thanh toán, chứng thực hợp đồng — trách nhiệm phối hợp | thuvienphapluat 662035 |
| Luật BVDLCN 91/2025/QH15 Đ.31; NĐ 356/2025/NĐ-CP (thay NĐ 13/2023 từ 01/01/2026) | 01/01/2026 | Dữ liệu vị trí là nhạy cảm; không theo dõi vị trí qua RFID/thiết bị khi chưa đồng ý trừ luật định; app phải có tuỳ chọn theo dõi vị trí | xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) |
| NĐ 333/2026/NĐ-CP Đ.19 | 19/08/2026 | "Dịch vụ kết nối vận chuyển qua không gian mạng" thuộc nhóm phải lưu dữ liệu người dùng VN trong nước | Công báo 499 |
| NĐ 123/2020 + NĐ 70/2025 (hoá đơn); Luật Kế toán 88/2015 Đ.41 | — | Hoá đơn vận chuyển, chứng từ lưu ≥ 10 năm | thuvienphapluat |

**Quốc tế (xác minh 2026-10-13):** Incoterms® 2020 (ICC) · GS1 General Specifications (SSCC/GTIN/GLN, GS1-128, EPCIS 2.0 —
chưa xác minh phiên bản) · UN/EDIFACT, ANSI X12 · ISO 28000:2022 (an ninh chuỗi cung ứng — chưa xác minh) · GDPR
(telematics tài xế = dữ liệu cá nhân) · EU eFTI Regulation 2020/1056 (thông tin vận tải hàng hoá điện tử — chưa xác minh
ngày áp dụng) · IATA/IMO cho hàng không/hàng hải khi áp dụng.

## Mô hình dữ liệu / nghiệp vụ đặc trưng

- **Shipment** (`id, order_ref, shipper, consignee, pickup/delivery addresses (geocoded + raw), service_level, cod_amount_minor,
  declared_weight_g, actual_weight_g, volumetric_weight_g, incoterm, status, sla_due_at`), **Package** (SSCC, dims, lô/hạn),
  **Leg/Route** (hub → hub, carrier), **TrackingEvent** (`event_id, occurred_at, received_at, location, source, idempotent`),
  **ProofOfDelivery** (ảnh, chữ ký, OTP, người nhận thay), **Exception** (thất bại, hư hỏng, mất, khiếu nại).
- **Trạng thái là dẫn xuất từ sự kiện** theo `occurred_at` (không phải thứ tự đến); event cũ đến muộn không được làm lùi trạng thái.
- **Kho:** `inventory(sku, lot, expiry, bin, qty)`; FEFO cho hàng hạn dùng; nhiệt độ cho chuỗi lạnh (`temp_log`).
- **Địa chỉ VN:** cấu trúc sau sắp xếp đơn vị hành chính 2025 (bỏ cấp huyện) — lưu phiên bản danh mục địa giới, ánh xạ cũ → mới.
- **Giá cước:** bảng giá theo vùng/khoảng cách/cân nặng tính cước = max(thực, thể tích), phụ phí, làm tròn một lần.

## Ca biên nghiệp vụ

1. **Sự kiện tracking đến sai thứ tự** (delivered trước out_for_delivery do mạng): sắp theo `occurred_at`, trạng thái không lùi,
   nhưng vẫn lưu sự kiện; hiển thị đúng chuỗi.
2. **Cùng sự kiện gửi hai lần từ thiết bị/3PL** (retry): idempotent theo `event_id`/hash; không đếm 2 lần giao thất bại.
3. **Cân nặng khai 500 g, thực tế 2 kg:** cước tính lại tại hub có bằng chứng (ảnh cân), thông báo người gửi; quy tắc
   làm tròn gram và ngưỡng chênh lệch cho phép.
4. **Địa chỉ không geocode được hoặc geocode sai 5 km:** giữ địa chỉ thô, điểm tin cậy, cho tài xế sửa toạ độ tại chỗ có log; không huỷ đơn tự động.
5. **Đổi địa giới hành chính** (bỏ huyện, sáp nhập xã/tỉnh 2025): đơn cũ có địa chỉ cũ vẫn giao được; ánh xạ danh mục có phiên bản.
6. **Giao hàng qua nửa đêm / qua múi giờ** (xuyên biên giới): SLA theo giờ địa phương điểm giao; `sla_due_at` lưu UTC + múi giờ.
7. **Người nhận vắng, người khác nhận thay:** POD ghi người nhận thay + OTP/ảnh; chính sách xác nhận; tránh lộ thông tin người nhận.
8. **COD thu rồi tài xế nộp thiếu/muộn:** đối soát theo tài xế/ngày; trạng thái tiền tách khỏi trạng thái giao.
9. **Hàng lạnh vượt ngưỡng nhiệt độ 10 phút:** cảnh báo thời gian thực, đánh dấu lô, quy tắc huỷ/không giao.
10. **Hàng nguy hiểm trộn vào lô thường:** phân loại tại tạo đơn (9 loại NĐ 34/2024), chặn nếu không có giấy phép.
11. **Tối ưu tuyến với 2.000 điểm** và ràng buộc khung giờ: heuristic có timeout, kết quả khả thi trước tối ưu; test với dữ liệu thật ẩn danh.
12. **Thiết bị GSHT mất tín hiệu/giả mạo:** dữ liệu "khoảng trống" được đánh dấu, không nội suy thành "đã đi qua"; sửa dữ liệu GSHT bị cấm (thu hồi giấy phép).
13. **Trả hàng 1 phần của lô nhiều kiện:** trạng thái theo kiện (SSCC), không theo shipment.

## Checklist

- [ ] `IND-LOGI-001` **MUST** Trạng thái lô hàng/kiện là dẫn xuất từ sự kiện theo `occurred_at`; sự kiện đến muộn/sai thứ tự không làm lùi trạng thái; mọi sự kiện lưu kèm `received_at` và `source`. → Kiểm: property test chuỗi sự kiện hoán vị → trạng thái cuối giống nhau; test event cũ không lùi. · Nguồn: thực hành event sourcing; [`../09-database/transactions-and-consistency.md`](../09-database/transactions-and-consistency.md)
- [ ] `IND-LOGI-002` **MUST** Ingest tracking/webhook từ thiết bị và đối tác idempotent theo `event_id` (hoặc hash nội dung + thời gian), xác minh chữ ký, trả 2xx nhanh, xử lý qua queue có DLQ; mất kết nối thiết bị được ghi là "khoảng trống" không nội suy. → Kiểm: test gửi trùng → 1 sự kiện; test webhook sai chữ ký → 401; test gap không tạo sự kiện vị trí giả. · Nguồn: [`../08-backend/integrations-and-webhooks.md`](../08-backend/integrations-and-webhooks.md); NĐ 158/2024/NĐ-CP (cấm sửa dữ liệu GSHT)
- [ ] `IND-LOGI-003` **MUST** Mỗi kiện có mã định danh duy nhất theo GS1 (SSCC) hoặc mã nội bộ có checksum; mã vạch/QR quét được ở mọi hub; trạng thái theo kiện, tổng hợp lên lô. → Kiểm: test sinh/validate check digit; test lô 3 kiện trả 1 → trạng thái partial. · Nguồn: GS1 General Specifications (SSCC); thực hành nội bộ
- [ ] `IND-LOGI-004` **MUST** Cước tính từ cân nặng tính cước = max(thực, thể tích) với đơn vị gram và công thức thể tích công bố; tiền số nguyên; làm tròn một lần; thay đổi cước tại hub có bằng chứng và thông báo. → Kiểm: test bảng ca biên (0 g, 999 g, 1.000 g, thể tích > thực); lint cấm float; log cân lại có ảnh. · Nguồn: [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md); NĐ 163/2017/NĐ-CP Đ.5 (giới hạn trách nhiệm)
- [ ] `IND-LOGI-005` **MUST** Thời gian: lưu UTC + múi giờ địa điểm cho SLA/ETA/khung giờ; địa lý WGS84; địa chỉ lưu cả bản thô và chuẩn hoá có điểm tin cậy; danh mục địa giới hành chính có phiên bản và ánh xạ cũ → mới. → Kiểm: test SLA qua nửa đêm/múi giờ; test địa chỉ huyện cũ vẫn ánh xạ; bảng `admin_unit_version`. · Nguồn: [`../18-cross-cutting/units-time-and-money.md`](../18-cross-cutting/units-time-and-money.md); Nghị quyết sắp xếp ĐVHC 2025 (chưa xác minh số hiệu)
- [ ] `IND-LOGI-006` **MUST** Dữ liệu vị trí tài xế/người giao chỉ thu khi đang trong ca/nhiệm vụ, có thông báo và tuỳ chọn trong app, tối thiểu hoá tần suất, retention ngắn (theo nhu cầu tranh chấp/luật GSHT), giả danh hoá cho phân tích. → Kiểm: test ngoài ca không gửi toạ độ; data map `location` có retention; thông báo trong app. · Nguồn: Luật 91/2025/QH15 Đ.31; GDPR Art. 5(1)(c); NĐ 151/2024/NĐ-CP (dữ liệu GSHT theo quy định)
- [ ] `IND-LOGI-007` **MUST** Thông tin người nhận (SĐT, địa chỉ) chỉ hiển thị cho tài xế trong thời gian giao, che một phần, gọi qua số ảo khi có thể; POD (ảnh/chữ ký) có retention và không chứa dữ liệu thừa. → Kiểm: test API tài xế sau khi giao xong → không truy cập được SĐT; cấu hình masking. · Nguồn: Luật 91/2025/QH15 Đ.3, Đ.12; GDPR Art. 25
- [ ] `IND-LOGI-008` **MUST** Tích hợp đối tác (3PL, hãng vận chuyển, bản đồ, hải quan) có contract test, timeout, retry lũy thừa, circuit breaker, DLQ và dashboard lỗi theo đối tác; đối tác lỗi không chặn tạo đơn. → Kiểm: bộ contract test theo đối tác trong CI; test chaos đối tác timeout → đơn vẫn tạo với trạng thái chờ; xem [`../14-testing-quality/integration-and-contract.md`](../14-testing-quality/integration-and-contract.md). · Nguồn: [`../05-architecture/integration-patterns.md`](../05-architecture/integration-patterns.md)
- [ ] `IND-LOGI-009` **MUST** Phân loại hàng nguy hiểm/hạn chế tại tạo đơn (9 loại NĐ 34/2024; cấm gửi theo Luật Bưu chính) và chặn khi thiếu giấy phép/điều kiện; chuỗi lạnh có log nhiệt độ và cảnh báo vượt ngưỡng. → Kiểm: test tạo đơn hàng nguy hiểm không giấy phép → từ chối; test cảnh báo nhiệt độ. · Nguồn: NĐ 34/2024/NĐ-CP; Luật Bưu chính 49/2010/QH12 (vật phẩm cấm gửi)
- [ ] `IND-LOGI-010` **MUST** COD và cước được đối soát theo tài xế/đối tác/ngày; trạng thái tiền tách khỏi trạng thái giao; chênh lệch có chủ xử lý. → Kiểm: mục IND-FIN-006 áp dụng cho dòng COD; job đối soát + metric. · Nguồn: [`fintech.md`](fintech.md); TT 40/2024/TT-NHNN (khi là trung gian thanh toán)
- [ ] `IND-LOGI-011` **MUST** Chứng từ vận chuyển/hoá đơn/POD lưu theo thời hạn (chứng từ kế toán ≥ 10 năm; POD theo chính sách khiếu nại) bất biến, truy xuất theo mã lô. → Kiểm: retention trong data map; kho WORM cho hoá đơn/POD. · Nguồn: Luật Kế toán 88/2015/QH13 Đ.41; NĐ 70/2025/NĐ-CP
- [ ] `IND-LOGI-012` **MUST@M** Kinh doanh vận tải/chuyển phát có giấy phép tương ứng (vận tải NĐ 158/2024; bưu chính Luật 49/2010); dữ liệu GSHT/camera kết nối cơ quan quản lý theo quy định; không sửa/làm sai lệch dữ liệu. → Kiểm: hồ sơ pháp lý; tích hợp kết nối có log; quyền sửa dữ liệu GSHT = không tồn tại. · Nguồn: NĐ 158/2024/NĐ-CP; NĐ 151/2024/NĐ-CP; Luật Bưu chính 49/2010/QH12
- [ ] `IND-LOGI-013` **MUST@M** Hải quan/xuất nhập khẩu: tờ khai điện tử qua VNACCS/VCIS hoặc đại lý; HS code, Incoterm, trị giá lưu theo lô; thay đổi luật thuế/hải quan có cấu hình phiên bản. → Kiểm: schema `customs_declaration`; contract test với môi trường thử (nếu có); ADR theo Luật 90/2025. · Nguồn: Luật Hải quan 54/2014/QH13 (sửa 2025, 2026); Incoterms 2020
- [ ] `IND-LOGI-014` **MUST@M** Dịch vụ kết nối vận chuyển qua mạng lưu dữ liệu người dùng VN trong nước; đối tác bản đồ/định vị nước ngoài nằm trong hồ sơ chuyển dữ liệu. → Kiểm: region kho dữ liệu; `processors.md` có nhà cung cấp bản đồ. · Nguồn: NĐ 333/2026/NĐ-CP Đ.19; Luật 91/2025/QH15 Đ.20
- [ ] `IND-LOGI-015` **SHOULD** Tối ưu tuyến/dispatch có timeout, kết quả khả thi trước tối ưu, giải thích phân công; test hồi quy với dữ liệu ẩn danh thật; tài xế có thể từ chối/báo lý do. → Kiểm: benchmark thời gian/khoảng cách trên bộ dữ liệu cố định; test timeout. · Nguồn: thực hành nội bộ
- [ ] `IND-LOGI-016` **SHOULD** ETA có khoảng tin cậy và được đo sai số (MAE) theo vùng; thông báo người nhận khi trễ; SLA theo dịch vụ có dashboard. → Kiểm: metric `eta_mae_minutes`; alert SLA; xem [`../15-operations/slo-and-alerting.md`](../15-operations/slo-and-alerting.md). · Nguồn: thực hành nội bộ
- [ ] `IND-LOGI-017` **SHOULD** Kho: FEFO cho hàng hạn dùng, tồn theo bin không âm, kiểm kê có chênh lệch được ghi nhận; thao tác offline trên thiết bị quét đồng bộ idempotent. → Kiểm: test FEFO; constraint tồn ≥ 0; test đồng bộ offline trùng. · Nguồn: [`../09-database/transactions-and-consistency.md`](../09-database/transactions-and-consistency.md)
- [ ] `IND-LOGI-018` **SHOULD** Tracking công khai cho người nhận không lộ dữ liệu thừa (chỉ trạng thái/ETA, không địa chỉ đầy đủ/SĐT), mã tra cứu không đoán được, giới hạn tốc độ. → Kiểm: test trang tracking không chứa PII; mã ≥ 128 bit entropy hoặc OTP. · Nguồn: Luật 91/2025/QH15 Đ.3; ASVS 5.0 V3
- [ ] `IND-LOGI-019` **SHOULD** Trao đổi EDI/API với hãng lớn theo chuẩn (EDIFACT/X12, GS1 EPCIS 2.0) thay định dạng riêng. → Kiểm: schema + validator trong test. · Nguồn: GS1 EPCIS 2.0 (chưa xác minh phiên bản)
- [ ] `IND-LOGI-020` **MAY** eFTI/chứng từ vận tải điện tử cho vận tải EU; e-CMR. → Kiểm: ADR khi mở thị trường EU. · Nguồn: Regulation (EU) 2020/1056 (chưa xác minh)
- [ ] `IND-LOGI-021` **MAY** Theo dõi phát thải CO₂ theo lô (GLEC Framework) cho báo cáo khách hàng. → Kiểm: báo cáo có phương pháp. · Nguồn: GLEC Framework (chưa xác minh phiên bản); xem [`../18-cross-cutting/sustainability-and-efficiency.md`](../18-cross-cutting/sustainability-and-efficiency.md)

## Cổng chất lượng tương đương

| Cổng chung | Tương đương logistics | Ngưỡng |
|---|---|---|
| Hiệu năng | Ingest tracking p95 ≤ 200 ms; dispatch 2.000 điểm ≤ 60 s; tra cứu ≤ 300 ms | k6 + benchmark |
| Đúng dữ liệu | 0 trạng thái lùi; 0 sự kiện trùng; đối soát COD = 0 break quá 24 h | job + alert |
| Tích hợp | 100% đối tác có contract test; lỗi đối tác không chặn tạo đơn | CI + chaos |
| Riêng tư | Vị trí ngoài ca = 0 bản ghi; SĐT người nhận che sau giao | test |
| Pháp lý | Giấy phép, GSHT kết nối, hàng nguy hiểm, lưu trữ trong nước ✅ | GO/NO-GO |

## Bẫy

- **Trạng thái = sự kiện mới nhất đến** → "delivered" rồi "in transit".
- **Nội suy GPS lấp khoảng trống** → bằng chứng giả khi tranh chấp, vi phạm cấm sửa dữ liệu GSHT.
- **Cân nặng float** → cước lệch 1 đồng, đối soát thất bại.
- **Geocode tự động rồi huỷ đơn khi thất bại** → mất đơn vùng sâu.
- **Theo dõi vị trí tài xế 24/7** "để chống gian lận" → vi phạm Đ.31 Luật 91/2025.
- **Tracking công khai lộ SĐT/địa chỉ** qua mã dễ đoán.
- **Danh mục địa giới cũ sau sáp nhập 2025** → không tạo được đơn/giao sai tuyến.
- **Một partner timeout kéo sập tạo đơn** vì gọi đồng bộ.

## Nguồn

- NĐ 163/2017/NĐ-CP (30/12/2017, hiệu lực 20/02/2018): <https://thuvienphapluat.vn/van-ban/thuong-mai/decree-163-2017-nd-cp-on-provision-of-logistics-services-373059.aspx> — xác minh 2026-10-13; kiểm tra văn bản sửa đổi trước khi áp dụng.
- Luật Đường bộ 35/2024/QH15 và Luật TTATGT đường bộ 36/2024/QH15 (hiệu lực 01/01/2025); NĐ 158/2024/NĐ-CP (18/12/2024) sửa bởi NĐ 218/2026/NĐ-CP (19/06/2026): <https://luatvietnam.vn/giao-thong/nghi-dinh-218-2026-nd-cp-sua-doi-nghi-dinh-158-2024-ve-van-tai-duong-bo-438376-d1.html>; <https://hethongphapluat.com/decree-no-158-2024-nd-cp-dated-december-18-2024-on-road-transport/chuong-4> — xác minh 2026-10-13 (ngày hiệu lực NĐ 158 chưa xác minh chính xác); NĐ 151/2024/NĐ-CP (GSHT, 01/01/2025): <https://pbgdpl.cantho.gov.vn/4-loai-phuong-tien-bat-buoc-lap-thiet-bi-giam-sat-hanh-trinh> — nguồn thứ cấp.
- Luật Bưu chính 49/2010/QH12; NĐ 47/2011/NĐ-CP (17/06/2011, hiệu lực 15/08/2011; sửa NĐ 150/2018, NĐ 25/2022): <https://thuvienphapluat.vn/van-ban/Cong-nghe-thong-tin/Nghi-dinh-47-2011-ND-CP-huong-dan-Luat-buu-chinh-125633.aspx> — xác minh 2026-10-13; (chưa xác minh) ngày hiệu lực Luật Bưu chính 01/01/2011.
- NĐ 34/2024/NĐ-CP (31/03/2024, hiệu lực 15/05/2024; Đ.9–12 bãi bỏ bởi NĐ 161/2024 từ 01/01/2025): <https://caselaw.vn/van-ban-phap-luat/411891-nghi-dinh-so-34-2024-nd-cp-ngay-31-03-2024-cua-chinh-phu-quy-dinh-ve-danh-muc-hang-hoa-nguy-hiem-van-chuyen-hang-hoa-nguy-hiem-bang-phuong-tien-thuy-noi-dia> — xác minh 2026-10-13.
- Luật Hải quan sửa đổi: Luật 90/2025/QH15 (25/06/2025, hiệu lực 01/07/2025) và Luật 11/2026/QH16 (hiệu lực 01/03/2027): <https://thuehaiquan.tapchikinhtetaichinh.vn/luat-hai-quan-sua-doi-dap-ung-yeu-cau-quan-ly-trong-tinh-hinh-moi-166625.html> — nguồn thứ cấp, xác minh 2026-10-13; NĐ 08/2015 + 59/2018 (chưa xác minh hiện trạng).
- Luật TMĐT 122/2025/QH15 Chương V: <https://thuvienphapluat.vn/van-ban/Thuong-mai/Luat-Thuong-mai-dien-tu-2025-so-122-2025-QH15-662035.aspx> — xác minh 2026-10-13.
- Luật 91/2025/QH15 Đ.31; NĐ 356/2025/NĐ-CP; NĐ 333/2026/NĐ-CP Đ.19: xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) — xác minh 2026-10-13.
- Incoterms® 2020 (11 điều kiện): <https://iccwbo.org/business-solutions/incoterms-rules/incoterms-2020/> — xác minh 2026-10-13.
- GS1 SSCC/General Specifications: <https://www.gs1.org/standards/id-keys/sscc> — (chưa xác minh: trang trả 403 ngày 2026-10-13).
- Luật Kế toán 88/2015/QH13 Đ.41: <https://hethongphapluat.com/luat-ke-toan-2015/dieu-41> — xác minh 2026-10-13.
