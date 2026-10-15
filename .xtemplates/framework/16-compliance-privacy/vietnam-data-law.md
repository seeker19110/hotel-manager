---
title: Pháp luật dữ liệu Việt Nam: PDPL 2025, NĐ 356/2025, Luật ANM 2025, Luật Dữ liệu, lưu trữ trong nước
kind: module
prefix: CMP-VN
applies_to: [all]
updated: 2026-10-14
---

# Pháp luật dữ liệu Việt Nam: PDPL 2025, NĐ 356/2025, Luật ANM 2025, Luật Dữ liệu, lưu trữ trong nước

> Nghĩa vụ **bắt buộc theo luật Việt Nam** đối với phần mềm xử lý dữ liệu của người dùng tại Việt Nam, quy về việc
> kiểm được bằng máy/bằng chứng. Thiết kế riêng tư ở [`privacy-by-design.md`](privacy-by-design.md); luồng đồng ý
> và quyền chủ thể ở [`consent-and-user-rights.md`](consent-and-user-rights.md); hồ sơ/bằng chứng ở
> [`records-and-audit-readiness.md`](records-and-audit-readiness.md). **Luật đổi nhanh (2025–2026 thay gần hết
> văn bản cũ) — kiểm tra văn bản sửa đổi/thay thế trước khi áp dụng.**

## Nguyên tắc

1. **Luật mới thắng luật cũ:** từ 01/01/2026 Luật 91/2025/QH15 + NĐ 356/2025/NĐ-CP thay NĐ 13/2023; từ 01/07/2026
   Luật An ninh mạng 116/2025/QH15 thay cả Luật ANM 2018 và Luật ATTT mạng 2015; NĐ 333/2026 thay NĐ 53/2022.
   Tài liệu/code còn trích NĐ 13 hay NĐ 53 là lỗi thời.
2. **Đồng ý phải chứng minh được:** rõ ràng, tự nguyện, theo từng mục đích, in/sao chép được, im lặng không phải
   đồng ý (Luật 91/2025 Đ.9; NĐ 330/2026 phạt 50–70 triệu khi coi im lặng là đồng ý).
3. **Có hồ sơ trước khi xử lý rủi ro:** hồ sơ đánh giá tác động xử lý (ĐGTĐ) và hồ sơ chuyển dữ liệu ra nước ngoài
   nộp Bộ Công an (Cục A05) trong 60 ngày; cập nhật khi thay đổi.
4. **Lưu trữ trong nước là nghĩa vụ có điều kiện:** doanh nghiệp trong nước lưu tại Việt Nam các dữ liệu NĐ 333/2026
   Đ.19 k.1; doanh nghiệp nước ngoài lưu + đặt chi nhánh khi Bộ Công an yêu cầu. Chuyển dữ liệu cốt lõi/quan trọng
   xuyên biên giới theo Luật Dữ liệu Đ.23 + NĐ 165/2025.
5. **Mức phạt tính theo doanh thu:** tối đa 5% doanh thu năm trước (chuyển xuyên biên giới trái phép), 10 lần
   khoản thu (mua bán dữ liệu), 3 tỷ đồng (vi phạm khác) — Luật 91/2025 Đ.8.

## Quyết định

| Câu hỏi | Trả lời → nghĩa vụ |
|---|---|
| Xử lý dữ liệu cá nhân của người ở Việt Nam? | Có → toàn bộ Luật 91/2025 + NĐ 356/2025 áp dụng, kể cả tổ chức nước ngoài (Đ.1) |
| Có dữ liệu **nhạy cảm** (sức khoẻ, sinh trắc, tài chính, vị trí, trẻ em…)? | Có → biện pháp bảo vệ tăng cường, thông báo riêng cho chủ thể, ĐGTĐ bắt buộc, thông báo vi phạm 72 giờ |
| Có chuyển dữ liệu ra ngoài Việt Nam (cloud nước ngoài, SaaS, LLM API)? | Có → hồ sơ đánh giá tác động chuyển dữ liệu (Đ.20) nộp trong 60 ngày từ lần chuyển đầu; ngoại lệ: chủ thể tự chuyển, lưu dữ liệu nhân sự trên cloud |
| Là mạng xã hội/dịch vụ truyền thông trực tuyến? | Có → Đ.29: không đòi ảnh giấy tờ để xác thực, có lựa chọn từ chối cookie và "không theo dõi", không nghe lén; NĐ 147/2024 xác thực tài khoản |
| Dùng AI/dữ liệu lớn trên dữ liệu cá nhân? | Có → Đ.30 phân loại rủi ro, thông báo xử lý tự động, cho phép từ chối; thêm [`ai-regulation.md`](ai-regulation.md) |
| Doanh nghiệp nhỏ/khởi nghiệp? | NĐ 356/2025 cho miễn chỉ định bộ phận bảo vệ dữ liệu trong 2 năm đầu, **trừ** khi trực tiếp kinh doanh xử lý dữ liệu cá nhân — vẫn phải có ĐGTĐ và đồng ý |
| Là hệ thống thông tin của cơ quan nhà nước hoặc phục vụ nhà nước? | Xác định cấp độ 1–5 (Luật ANM 2025 Đ.8), bảo vệ theo cấp độ; 12 tháng chuyển tiếp từ 01/07/2026 (Đ.45) |

## Bảng văn bản áp dụng (xác minh 2026-10-13)

| Văn bản | Ban hành · Hiệu lực | Điều cần biết với phần mềm | Nguồn |
|---|---|---|---|
| Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 | 26/06/2025 · 01/01/2026 | Đ.8 phạt; Đ.9 đồng ý; Đ.14 xoá; Đ.19 không cần đồng ý; Đ.20 xuyên biên giới; Đ.21–22 ĐGTĐ; Đ.23 thông báo vi phạm 72h; Đ.24 trẻ em; Đ.25–32 ngành; Đ.33 bộ phận BVDL; Đ.39 chuyển tiếp | vanban.chinhphu.vn docid 214590 |
| NĐ 356/2025/NĐ-CP | 31/12/2025 · 01/01/2026 (thay NĐ 13/2023) | Hồ sơ ĐGTĐ xử lý và chuyển dữ liệu ra nước ngoài (Mẫu số 09/10, tiền kiểm qua Cục A05), thông báo vi phạm (Mẫu 08), cập nhật hồ sơ 6 tháng/10 ngày, miễn bộ phận BVDL 2 năm cho DN nhỏ — số điều lệch giữa các bản chép (Đ.11 vs Đ.19–20), **chưa xác minh số điều**, đối chiếu bản gốc vbpl.moj.gov.vn | vanban.chinhphu.vn docid 216387 |
| NĐ 330/2026/NĐ-CP | 19/08/2026 · 19/08/2026 | Xử phạt ANM + BVDLCN: đồng ý 30–50 tr; im lặng = đồng ý 50–70 tr; ĐGTĐ không nộp 20–30 tr; MXH 50–150 tr; từ chối cung cấp dữ liệu cho chủ thể 10–20 tr (theo nguồn thứ cấp) | luatvietan.vn (chưa đối chiếu Công báo) |
| Luật An ninh mạng 116/2025/QH15 | 10/12/2025 · 01/07/2026 | Đ.8 cấp độ 1–5; Đ.16 trẻ em; Đ.26 an ninh dữ liệu; Đ.44 thay Luật 24/2018 + 86/2015; Đ.45 chuyển tiếp 12 tháng | thuvienphapluat 666020 |
| NĐ 333/2026/NĐ-CP | 19/08/2026 · 19/08/2026 | Đ.19 dữ liệu phải lưu tại VN (thông tin cá nhân; tên tài khoản, thời gian dùng, thẻ tín dụng, email, IP đăng nhập/đăng xuất, SĐT); Đ.20 lưu ≥ 24 tháng; Đ.22–23 log định danh IP ≥ 12 tháng; Đ.31 chuyển tiếp NĐ 53/2022 | Công báo 499/04-09-2026 |
| Luật Dữ liệu 60/2024/QH15 | 30/11/2024 · 01/07/2025 | Đ.13 phân loại (cốt lõi/quan trọng/khác); Đ.23 chuyển xuyên biên giới 3 trường hợp | thuvienphapluat 621343 |
| NĐ 165/2025/NĐ-CP | 30/06/2025 · 01/07/2025 | Chi tiết Luật Dữ liệu Đ.13–37, đánh giá rủi ro chuyển dữ liệu cốt lõi/quan trọng | thuvienphapluat 663547 |
| Luật Giao dịch điện tử 20/2023/QH15 + NĐ 23/2025/NĐ-CP | 22/06/2023 · 01/07/2024; NĐ 21/02/2025 · 10/04/2025 | Giá trị pháp lý thông điệp dữ liệu, chữ ký số, dịch vụ tin cậy (dấu thời gian, chứng thực hợp đồng) | thuvienphapluat 513347 |
| NĐ 147/2024/NĐ-CP | 09/11/2024 · 25/12/2024 | Xác thực tài khoản MXH bằng SĐT/định danh; dưới 16 tuổi cha mẹ đăng ký; gỡ nội dung vi phạm 24h | luatvietnam |
| Luật Trẻ em 102/2016/QH13 + NĐ 56/2017/NĐ-CP | 05/04/2016 · 01/06/2017; NĐ 09/05/2017 · 01/07/2017 | Trẻ em < 16 tuổi; Đ.33–37 NĐ 56: đồng ý cha mẹ **và** trẻ ≥ 7 tuổi khi đưa thông tin riêng tư lên mạng | hethongphapluat |
| NĐ 85/2016/NĐ-CP + TT 12/2022/TT-BTTTT (cấp độ ATTT) | 01/07/2016; TT 12/08/2022 · 01/10/2022 | Luật gốc (ATTT 2015) hết hiệu lực 01/07/2026; cấp độ đã xác định được giữ (Luật ANM 2025 Đ.45) — **kiểm tra nghị định thay thế** | thuvienphapluat 318857 |

## Checklist

- [ ] `CMP-VN-001` **MUST** Thu thập sự đồng ý theo từng mục đích, hiển thị rõ loại dữ liệu/mục đích/bên nhận, lưu bằng chứng đồng ý (thời điểm, phiên bản văn bản, kênh) có thể in/sao chép. → Kiểm: bảng `consents` có `purpose_id`, `policy_version`, `granted_at`, `channel`; test từ chối xử lý khi thiếu bản ghi đồng ý. · Nguồn: Luật 91/2025/QH15 Đ.9; NĐ 330/2026 Đ.43
- [ ] `CMP-VN-002` **MUST@L** Không dùng checkbox tick sẵn, im lặng hoặc không phản hồi làm căn cứ đồng ý. → Kiểm: test UI/E2E: trạng thái mặc định của mọi ô đồng ý = chưa chọn; snapshot form. · Nguồn: Luật 91/2025/QH15 Đ.9; NĐ 330/2026 Đ.43
- [ ] `CMP-VN-003` **MUST@L** Lập hồ sơ đánh giá tác động xử lý dữ liệu cá nhân (Mẫu số 10 NĐ 356/2025, tiền kiểm qua Cục A05 — Bộ Công an) và nộp Bộ Công an trong 60 ngày kể từ khi bắt đầu xử lý; lưu biên nhận. → Kiểm: `docs/privacy/DGTD/` có hồ sơ + biên nhận/ngày gửi; việc này nằm trong checklist phát hành G7. · Nguồn: Luật 91/2025/QH15 Đ.21; NĐ 356/2025/NĐ-CP (hồ sơ ĐGTĐ, Mẫu số 10 — chưa xác minh số điều)
- [ ] `CMP-VN-004` **MUST** Mọi lần chuyển dữ liệu cá nhân ra ngoài Việt Nam (cloud, SaaS, LLM, CDN lưu dữ liệu) có trong hồ sơ đánh giá tác động chuyển dữ liệu nộp trong 60 ngày từ lần chuyển đầu. → Kiểm: data map có cột `region`/`processor_country`; script liệt kê nhà cung cấp ngoài VN và đối chiếu danh mục trong hồ sơ; chênh lệch = 0. · Nguồn: Luật 91/2025/QH15 Đ.20; NĐ 356/2025/NĐ-CP
- [ ] `CMP-VN-005` **MUST@L** Hồ sơ ĐGTĐ/chuyển dữ liệu được cập nhật khi phát sinh mục đích mới, thay bên xử lý/bên thứ ba (định kỳ 6 tháng) hoặc thay đổi khác trong 10 ngày theo NĐ 356/2025. → Kiểm: PR thêm nhà cung cấp/mục đích phải cập nhật `docs/privacy/DGTD/CHANGELOG.md`; CI kiểm nhãn `privacy:processor-change`. · Nguồn: Luật 91/2025/QH15 Đ.22; NĐ 356/2025/NĐ-CP (cập nhật hồ sơ — chưa xác minh số điều)
- [ ] `CMP-VN-006` **MUST** Quy trình thông báo vi phạm: phát hiện → đánh giá → thông báo Bộ Công an (Mẫu 08) và chủ thể trong **72 giờ** khi vi phạm có thể gây hại; runbook có mẫu sẵn. → Kiểm: `docs/ops/runbooks/data-breach.md` tồn tại với mốc giờ, diễn tập tabletop ≥ 1 lần/năm có biên bản. · Nguồn: Luật 91/2025/QH15 Đ.23; NĐ 356/2025/NĐ-CP (Mẫu 08 — chưa xác minh số điều)
- [ ] `CMP-VN-007` **MUST** Thực hiện quyền chủ thể (truy cập, chỉnh sửa, rút đồng ý, xoá, hạn chế, phản đối) trong thời hạn NĐ 356/2025 quy định (thường 72 giờ cho xoá/rút đồng ý trừ trường hợp luật khác). → Kiểm: endpoint/giao diện DSAR có SLA đo được; test E2E rút đồng ý → dừng xử lý mục đích tương ứng. · Nguồn: Luật 91/2025/QH15 Đ.4, Đ.10, Đ.14; NĐ 356/2025/NĐ-CP (thời hạn thực hiện quyền — chưa xác minh số điều)
- [ ] `CMP-VN-008` **MUST@L** Chỉ định bộ phận/nhân sự bảo vệ dữ liệu cá nhân (hoặc thuê dịch vụ) và ghi trong hồ sơ ĐGTĐ; DN nhỏ/khởi nghiệp dùng miễn trừ 2 năm phải ghi ngày hết miễn trừ. → Kiểm: `docs/privacy/README.md` ghi tên vai trò, liên hệ, ngày hết miễn trừ (nếu có). · Nguồn: Luật 91/2025/QH15 Đ.33; NĐ 356/2025/NĐ-CP
- [ ] `CMP-VN-009` **MUST@L** Dữ liệu trẻ em (< 16 tuổi): có cơ chế lấy đồng ý người đại diện; công bố thông tin đời tư của trẻ ≥ 7 tuổi cần đồng ý cả trẻ và người đại diện; ngừng xử lý khi người đại diện rút. → Kiểm: luồng đăng ký có xác định tuổi, test E2E dưới 16 phải có đồng ý người đại diện; dịch vụ MXH: tài khoản dưới 16 do cha mẹ đăng ký. · Nguồn: Luật 91/2025/QH15 Đ.24; NĐ 56/2017/NĐ-CP Đ.36; NĐ 147/2024/NĐ-CP
- [ ] `CMP-VN-010` **MUST@L** Dịch vụ mạng xã hội/truyền thông trực tuyến: không yêu cầu ảnh/video giấy tờ tuỳ thân để xác thực thông thường; có tuỳ chọn từ chối cookie và "không theo dõi"; không ghi âm/đọc tin nhắn khi chưa có đồng ý. → Kiểm: test E2E tuỳ chọn tồn tại và được tôn trọng (không set cookie theo dõi sau khi từ chối). · Nguồn: Luật 91/2025/QH15 Đ.29; NĐ 330/2026 Đ.65
- [ ] `CMP-VN-011` **MUST@L** Doanh nghiệp trong nước lưu tại Việt Nam các dữ liệu NĐ 333/2026 Đ.19 k.1 (thông tin cá nhân; tên tài khoản, thời gian dùng, thẻ tín dụng, email, IP đăng nhập/đăng xuất gần nhất, SĐT) ≥ 24 tháng; bản sao ở nước ngoài phải nằm trong hồ sơ chuyển dữ liệu. → Kiểm: cấu hình vùng (region) của CSDL/bucket chứa các trường này = VN; IaC có policy chặn region khác. · Nguồn: NĐ 333/2026/NĐ-CP Đ.19, Đ.20; Luật ANM 116/2025/QH15 Đ.26
- [ ] `CMP-VN-012` **MUST@L** Dữ liệu cốt lõi/dữ liệu quan trọng (theo danh mục Nhà nước) chỉ chuyển/xử lý xuyên biên giới sau đánh giá rủi ro theo NĐ 165/2025; sử dụng nền tảng ở nước ngoài để xử lý cũng tính là chuyển. → Kiểm: data map phân loại theo Luật Dữ liệu Đ.13; ADR nêu nền tảng xử lý và kết luận đánh giá. · Nguồn: Luật Dữ liệu 60/2024/QH15 Đ.13, Đ.23; NĐ 165/2025/NĐ-CP
- [ ] `CMP-VN-013` **MUST@L** Hệ thống phục vụ cơ quan nhà nước hoặc hạ tầng quan trọng xác định cấp độ (1–5) và áp dụng biện pháp theo cấp độ; cấp độ đã xác định theo luật cũ giữ nguyên nhưng phải đáp ứng điều kiện mới trong 12 tháng từ 01/07/2026. → Kiểm: `docs/security/cap-do.md` có quyết định phê duyệt cấp độ + ma trận biện pháp; hạn hoàn thành ≤ 01/07/2027. · Nguồn: Luật ANM 116/2025/QH15 Đ.8, Đ.45; NĐ 85/2016/NĐ-CP; TT 12/2022/TT-BTTTT
- [ ] `CMP-VN-014` **MUST@L** Nhật ký hệ thống phục vụ định danh IP/điều tra (thời gian theo chuẩn thời gian quốc gia, IP, phiên) lưu đầy đủ, liên tục ≥ 12 tháng, toàn vẹn, truy xuất được. → Kiểm: cấu hình retention log ≥ 12 tháng, log ở kho chỉ ghi thêm (WORM/immutable); đồng bộ NTP. · Nguồn: NĐ 333/2026/NĐ-CP Đ.22–23
- [ ] `CMP-VN-015` **MUST@L** Hợp đồng với bên xử lý (cloud, SaaS, agency, LLM API) có điều khoản xử lý dữ liệu cá nhân theo Luật 91/2025 (mục đích, biện pháp bảo vệ, xoá/trả dữ liệu khi kết thúc, thông báo vi phạm). → Kiểm: `docs/privacy/processors.md` link hợp đồng/DPA cho từng bên; CI chặn thêm SDK mới chưa có dòng. · Nguồn: Luật 91/2025/QH15 Đ.17, Đ.37
- [ ] `CMP-VN-016` **SHOULD** Thông báo xử lý dữ liệu (privacy notice) sinh từ data map, có phiên bản, hiển thị trước khi thu thập; lưu phiên bản người dùng đã đồng ý. → Kiểm: `policy_version` trong bảng consent khớp phiên bản notice đang hiển thị. · Nguồn: Luật 91/2025/QH15 Đ.9, Đ.11
- [ ] `CMP-VN-017` **SHOULD** Lĩnh vực tài chính–ngân hàng: không dùng thông tin tín dụng để chấm điểm/xếp hạng khi chưa có đồng ý; thông báo khách hàng khi lộ thông tin tài khoản/tín dụng. → Kiểm: feature flag chấm điểm chỉ bật khi có consent `credit-scoring`; runbook lộ dữ liệu có bước thông báo khách hàng. · Nguồn: Luật 91/2025/QH15 Đ.27
- [ ] `CMP-VN-018` **SHOULD** Lĩnh vực y tế/bảo hiểm: không cung cấp dữ liệu sức khoẻ cho bên thứ ba (bảo hiểm…) trừ khi có yêu cầu bằng văn bản của chủ thể hoặc thuộc Đ.19. → Kiểm: API chia sẻ hồ sơ sức khoẻ yêu cầu `consent_document_id`; log truy cập. · Nguồn: Luật 91/2025/QH15 Đ.26
- [ ] `CMP-VN-019` **SHOULD** Tuyển dụng/nhân sự: chỉ thu thông tin phục vụ tuyển dụng; xoá dữ liệu ứng viên không trúng tuyển trừ khi có thoả thuận khác. → Kiểm: retention ứng viên trong data map; job xoá chạy. · Nguồn: Luật 91/2025/QH15 Đ.25
- [ ] `CMP-VN-020` **SHOULD** Dữ liệu vị trí/sinh trắc: có tuỳ chọn bật/tắt theo dõi vị trí trong app; không theo dõi qua RFID/beacon khi chưa đồng ý. → Kiểm: test quyền hệ điều hành + cờ trong app; không gửi toạ độ khi tắt. · Nguồn: Luật 91/2025/QH15 Đ.31
- [ ] `CMP-VN-021` **SHOULD** Khi có bộ xử lý tự động/AI trên dữ liệu cá nhân: thông báo cho chủ thể, giải thích ảnh hưởng, cho phép từ chối; phân loại mức rủi ro. → Kiểm: UI có thông báo + tuỳ chọn; xem [`ai-regulation.md`](ai-regulation.md). · Nguồn: Luật 91/2025/QH15 Đ.30
- [ ] `CMP-VN-022` **SHOULD** Hồ sơ đã nộp theo NĐ 13/2023 được giữ nhưng lần cập nhật sau 01/01/2026 theo mẫu mới; đồng ý đã lấy hợp lệ không cần lấy lại. → Kiểm: `docs/privacy/DGTD/` ghi rõ hồ sơ gốc và lịch cập nhật theo mẫu NĐ 356. · Nguồn: Luật 91/2025/QH15 Đ.39
- [ ] `CMP-VN-023` **MAY** Dùng dịch vụ dấu thời gian/chứng thực hợp đồng điện tử của tổ chức cung cấp dịch vụ tin cậy để chứng minh thời điểm đồng ý/giao kết. → Kiểm: bản ghi có dấu thời gian từ nhà cung cấp được cấp phép. · Nguồn: Luật GDĐT 20/2023/QH15 Đ.28–33; NĐ 23/2025/NĐ-CP
- [ ] `CMP-VN-024` **MAY** Theo dõi văn bản mới bằng danh sách nguồn (vanban.chinhphu.vn, Công báo) và rà soát hàng quý; ghi ngày rà vào `docs/privacy/README.md`. → Kiểm: ngày rà gần nhất ≤ 90 ngày. · Nguồn: thực hành nội bộ

## Bẫy thường gặp

- **Trích NĐ 13/2023 hoặc NĐ 53/2022 trong chính sách mới:** cả hai đã bị thay (01/01/2026 và 19/08/2026). Cách tránh: bảng văn bản ở trên là nguồn duy nhất; grep repo tìm "13/2023".
- **"Dùng AWS Singapore là bình thường"** mà không có hồ sơ chuyển dữ liệu: phạt tới 5% doanh thu. Cách tránh: data map có `region`; mọi region ngoài VN phải có trong hồ sơ.
- **Gọi LLM API nước ngoài với dữ liệu khách hàng** = chuyển dữ liệu xuyên biên giới. Cách tránh: redact + đưa nhà cung cấp vào hồ sơ.
- **Một ô "tôi đồng ý với điều khoản" cho mọi mục đích** (tiếp thị, chia sẻ đối tác, phân tích): không phải đồng ý theo mục đích. Cách tránh: từng mục đích một ô, mặc định chưa chọn.
- **Nhầm 72 giờ "thông báo" với "điều tra xong":** đồng hồ chạy từ khi phát hiện. Cách tránh: runbook gửi thông báo sơ bộ rồi bổ sung.
- **MXH yêu cầu chụp CCCD để "xác minh"** cho việc thường ngày: cấm theo Đ.29, phạt 70–150 triệu. Cách tránh: xác thực qua SĐT/VNeID.
- **Cấp độ ATTT "làm hồ sơ cho xong"** không cập nhật khi kiến trúc đổi; sau 01/07/2026 còn 12 tháng để đáp ứng điều kiện mới.
- **Log IP không đồng bộ thời gian** → không truy xuất được theo NĐ 333 Đ.22. Cách tránh: NTP + timezone UTC + lưu offset.

## Cổng tự động

| Việc kiểm | Công cụ | Lệnh/cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Region của kho chứa dữ liệu Đ.19 NĐ 333 | OPA/conftest (Apache-2.0) trên Terraform/Pulumi | `conftest test infra/ -p policy/vn-residency.rego` | CI (PR hạ tầng) | 0 vi phạm |
| Nhà cung cấp ngoài VN ↔ hồ sơ chuyển dữ liệu | Script đối chiếu `data-map.yaml` ↔ `docs/privacy/DGTD/transfer.yaml` | `python scripts/privacy/check-transfer.py` | CI | 0 nhà cung cấp thiếu |
| Tham chiếu văn bản hết hiệu lực | ripgrep | `rg -n "13/2023/NĐ-CP\|53/2022/NĐ-CP" docs/ src/` | CI | 0 (trừ mục lịch sử) |
| Mặc định ô đồng ý = chưa chọn | Playwright | test `consent-defaults.spec` | CI | pass |
| Retention log ≥ 12 tháng, immutable | Kiểm cấu hình (Terraform plan/CloudFormation) | policy conftest | CI | pass |
| Mốc 60 ngày nộp hồ sơ ĐGTĐ | Mục trong `GO-NO-GO` G7 + nhắc lịch | `docs/privacy/DGTD/` có biên nhận | Cổng phát hành | BLOCKER nếu thiếu |

## Nguồn

- Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15 (ban hành 26/06/2025, hiệu lực 01/01/2026): <https://vanban.chinhphu.vn/?pageid=27160&docid=214590> — xác minh 2026-10-13; nội dung điều khoản đối chiếu <https://hethongphapluat.com/luat-bao-ve-du-lieu-ca-nhan-2025.html> — 2026-10-13. Kiểm tra văn bản sửa đổi/thay thế trước khi áp dụng.
- Nghị định 356/2025/NĐ-CP (31/12/2025, hiệu lực 01/01/2026, thay NĐ 13/2023/NĐ-CP): <https://vanban.chinhphu.vn/?pageid=27160&docid=216387> — xác minh 2026-10-13; bản gốc đối chiếu số điều: <https://vbpl.vn/en/van-ban/chi-tiet/nghi-dinh-so-356-2025-nd-cp-quy-dinh-chi-tiet-mot-so-dieu-va-bien-phap-thi-hanh-luat-bao-ve-du-lieu-ca-nhan--187276>.
- Nghị định 13/2023/NĐ-CP (17/04/2023, hiệu lực 01/07/2023) — **đã bị thay thế từ 01/01/2026** bởi NĐ 356/2025/NĐ-CP; giữ để tra cứu lịch sử/hồ sơ đã nộp (Luật 91/2025 Đ.39): <https://luatvietnam.vn/bai-viet-lien-quan/13-2023-nd-cp-249791.html> — xác minh 2026-10-13.
- Nghị định 330/2026/NĐ-CP (19/08/2026, hiệu lực 19/08/2026) xử phạt an ninh mạng và BVDLCN: <https://luatvietan.vn/nghi-dinh-330-2026-nd-cp.html> — xác minh 2026-10-13 qua nguồn thứ cấp (chưa đối chiếu Công báo).
- Luật An ninh mạng số 116/2025/QH15 (10/12/2025, hiệu lực 01/07/2026; Đ.44 thay Luật 24/2018/QH14 và Luật 86/2015/QH13): <https://thuvienphapluat.vn/van-ban/Cong-nghe-thong-tin/Luat-An-ninh-mang-2025-so-116-2025-QH15-666020.aspx> — xác minh 2026-10-13; Đ.8/16/26/44/45 đối chiếu <https://hethongphapluat.com/luat-an-ninh-mang-2025/dieu-44>.
- Nghị định 333/2026/NĐ-CP (19/08/2026, hiệu lực 19/08/2026) quy định chi tiết Luật An ninh mạng — Công báo số 499 ngày 04/09/2026: <https://congbaocdn.chinhphu.vn/180507251028987904/2026/9/4/470335-1787890927_v1_1788486330_signed.pdf> — xác minh 2026-10-13 (đọc toàn văn PDF).
- Luật Dữ liệu số 60/2024/QH15 (30/11/2024, hiệu lực 01/07/2025): <https://thuvienphapluat.vn/van-ban/Bo-may-hanh-chinh/Luat-Du-lieu-2024-so-60-2024-QH15-621343.aspx>; Nghị định 165/2025/NĐ-CP (30/06/2025, hiệu lực 01/07/2025): <https://thuvienphapluat.vn/van-ban/Cong-nghe-thong-tin/Nghi-dinh-165-2025-ND-CP-huong-dan-Luat-Du-lieu-663547.aspx> — xác minh 2026-10-13.
- Luật Giao dịch điện tử số 20/2023/QH15 (22/06/2023, hiệu lực 01/07/2024): <https://thuvienphapluat.vn/van-ban/Cong-nghe-thong-tin/Luat-Giao-dich-dien-tu-2023-20-2023-QH15-513347.aspx>; Nghị định 23/2025/NĐ-CP (21/02/2025, hiệu lực 10/04/2025): <https://thuvienphapluat.vn/van-ban/thue-phi-le-phi/decree-23-2025-nd-cp-digital-signatures-and-trust-services-649650.aspx> — xác minh 2026-10-13.
- Nghị định 147/2024/NĐ-CP (09/11/2024, hiệu lực 25/12/2024): <https://luatvietnam.vn/tin-van-ban-moi/tu-25-12-2024-tai-khoan-mang-xa-hoi-da-xac-thuc-bang-so-dien-thoai-moi-duoc-dang-bai-186-99855-article.html> — xác minh 2026-10-13 (nguồn thứ cấp).
- Luật Trẻ em 102/2016/QH13 (hiệu lực 01/06/2017) và Nghị định 56/2017/NĐ-CP (hiệu lực 01/07/2017): <https://hethongphapluat.com/nghi-dinh-56-2017-nd-cp-huong-dan-luat-tre-em.html> — xác minh 2026-10-13.
- Nghị định 85/2016/NĐ-CP (01/07/2016) và Thông tư 12/2022/TT-BTTTT (12/08/2022, hiệu lực 01/10/2022): <https://thuvienphapluat.vn/van-ban/cong-nghe-thong-tin/decree-85-2016-nd-cp-on-the-security-of-information-systems-by-classification-318857.aspx> — xác minh 2026-10-13; (chưa xác minh) nghị định thay thế sau Luật ANM 2025 — không tìm thấy ngày 2026-10-13.
- Nghiên cứu nền: `research/2026-10-13-stored-catalog-extraction.md` §2.16 (NĐ 13/2023, DPIA — nay đã được thay).
