---
title: Truyền thông · nội dung · xuất bản · UGC
kind: industry
slug: media-content
prefix: IND-MEDIA
modules: [16-compliance-privacy/*, 12-security/appsec-web, 12-security/ai-security, 12-security/logging-audit-and-incident, 08-backend/files-and-media, 08-backend/realtime-and-streaming, 08-backend/caching, 08-backend/background-jobs-and-queues, 08-backend/authn-authz, 09-database/search-and-vector, 09-database/indexing-and-query-performance, 07-frontend/performance-web-vitals, 07-frontend/rendering-and-routing, 06-design-ux/accessibility, 06-design-ux/content-and-microcopy, 13-ai-engineering/guardrails-and-safety, 18-cross-cutting/i18n-and-l10n, 15-operations/cost-management, 15-operations/observability, 17-product-project/metrics-and-analytics]
updated: 2026-10-14
---

# Gói ngành: Truyền thông · nội dung · xuất bản · UGC

> Ghép cho báo/tạp chí điện tử, nền tảng video/podcast, mạng xã hội, diễn đàn, nền tảng sáng tạo/UGC, CMS xuất bản,
> newsletter, livestream. Hai trục rủi ro: **nội dung** (bản quyền, nội dung vi phạm, trẻ em, deepfake, gỡ trong 24 h)
> và **quy mô** (CDN, cache, chi phí media, hiệu năng). Từ 01/07/2026 Luật Báo chí 2025 và Luật An ninh mạng 2025 có
> hiệu lực; NĐ 147/2024 (xác thực tài khoản, giấy phép MXH) áp dụng từ 25/12/2024.

## Khi nào dùng

Dùng khi sản phẩm **xuất bản nội dung cho công chúng** hoặc **cho người dùng đăng nội dung** (bình luận, video, bài viết,
livestream), có quảng cáo/thuê bao, hoặc đề xuất nội dung bằng thuật toán. Blog nội bộ không có UGC → chỉ cần hồ sơ
static-site/web-app.

## Kiến trúc tham chiếu

```text
[Tác giả/CMS] ─► [Editorial workflow: nháp → duyệt → xuất bản → chỉnh sửa có phiên bản] ─► [Content store + search index]
[Người dùng UGC] ─► [Upload (quét mã độc, giới hạn) → transcode/thumbnail (job) → kiểm duyệt tự động + người] ─► [Object storage + CDN]
[Đề xuất/feed] ─► thuật toán có giải thích, tắt cá nhân hoá được; không khai thác trẻ em
[Kiểm duyệt] ─► hàng chờ báo cáo (SLA 24 h), notice-and-takedown bản quyền, kháng nghị, log quyết định
[Quảng cáo/thuê bao] ─► nhãn quảng cáo, consent cho tracking, thanh toán → fintech
```

## Thành phần đặc thù khuyến nghị (xác minh lại trước khi dùng)

| Thành phần | Mặc định | Ghi chú |
|---|---|---|
| Media pipeline | Upload presigned → quét → transcode (HLS/DASH, AV1/H.264) → CDN; ảnh WebP/AVIF responsive | [`../08-backend/files-and-media.md`](../08-backend/files-and-media.md) |
| Nguồn gốc nội dung | C2PA Content Credentials cho nội dung do toà soạn/AI tạo (chưa xác minh phiên bản) | Nhãn AI bắt buộc theo Luật AI/NĐ 142 |
| Kiểm duyệt | Phân loại tự động (nội dung người lớn, bạo lực, CSAM hash-matching) + hàng chờ người; quyết định có lý do | Không "shadow ban" không thông báo |
| Bản quyền | Fingerprint audio/video (khi quy mô), notice-and-takedown, counter-notice | DMCA §512 (US), DSA Art. 16 (EU), Luật SHTT |
| Tìm kiếm | Index full-text + vector cho đề xuất; cache theo phiên bản bài | [`../09-database/search-and-vector.md`](../09-database/search-and-vector.md) |
| Hiệu năng | SSR/ISR + CDN, ảnh lazy, LCP ≤ 2,5 s; quảng cáo không gây CLS | [`../07-frontend/performance-web-vitals.md`](../07-frontend/performance-web-vitals.md) |

## Khung pháp lý

**Việt Nam (xác minh 2026-10-13 — kiểm tra văn bản sửa đổi/thay thế trước khi áp dụng):**

| Văn bản | Ban hành · Hiệu lực | Nội dung với phần mềm | Nguồn |
|---|---|---|---|
| NĐ 147/2024/NĐ-CP quản lý, cung cấp, sử dụng dịch vụ Internet và thông tin trên mạng | 09/11/2024 · 25/12/2024 (thay NĐ 72/2013) | Giấy phép MXH (ngưỡng truy cập/người dùng), xác thực tài khoản bằng SĐT/định danh; chỉ tài khoản xác thực mới đăng/bình luận/livestream; dưới 16 cha mẹ đăng ký; gỡ nội dung vi phạm trong 24 h; không đặt tên trùng cơ quan báo chí (Đ.36 k.7) | luatvietnam; lsvn.vn |
| Luật Báo chí 126/2025/QH15; NĐ 237/2026/NĐ-CP | 10/12/2025 · 01/07/2026 (thay Luật Báo chí 2016); NĐ 26/06/2026 | Hoạt động báo chí, cơ quan báo chí, trang thông tin điện tử tổng hợp, phóng viên thường trú | luatvietnam 422610 |
| Luật An ninh mạng 116/2025/QH15; NĐ 333/2026/NĐ-CP | 01/07/2026; 19/08/2026 | Xoá thông tin trái pháp luật/tin giả theo yêu cầu; Đ.16 bảo vệ trẻ em; MXH thuộc nhóm lưu dữ liệu người dùng trong nước (Đ.19 NĐ 333) | Công báo 499 |
| Luật BVDLCN 91/2025/QH15 Đ.29; NĐ 356/2025/NĐ-CP (thay NĐ 13/2023 từ 01/01/2026); NĐ 330/2026 Đ.65 | 01/01/2026; 19/08/2026 | MXH/truyền thông trực tuyến: công khai dữ liệu thu thập, cookie opt-out, "không theo dõi", không đòi ảnh giấy tờ, không nghe lén; phạt 50–150 triệu | xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) |
| Luật Sở hữu trí tuệ (sửa đổi 07/2022/QH15 hiệu lực 01/01/2023 — chưa xác minh; 131/2025/QH15 hiệu lực 01/04/2026) | — | Quyền tác giả nội dung số, trách nhiệm trung gian, ngoại lệ TDM cho huấn luyện AI (2025) | thuvienphapluat 700208 |
| Luật Quảng cáo sửa đổi 75/2025/QH15 | 16/06/2025 · 01/01/2026 | Đ.15a người chuyển tải sản phẩm quảng cáo/người có ảnh hưởng; MXH phải có tính năng phân biệt quảng cáo | luatvietnam 404208 |
| Luật AI 134/2025/QH15; NĐ 142/2026/NĐ-CP | 01/03/2026; 01/05/2026 | Dấu hiệu nhận biết nội dung AI (audio/ảnh/video watermark máy đọc được), nhãn deepfake; cấm thao túng | xem [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md) |
| Luật Trẻ em 102/2016/QH13; NĐ 56/2017/NĐ-CP Đ.35–36 | 01/06/2017; 01/07/2017 | Cảnh báo/gỡ nội dung gây hại; đăng thông tin riêng tư trẻ cần đồng ý cha mẹ + trẻ ≥ 7 tuổi | hethongphapluat |
| NĐ 174/2026/NĐ-CP xử phạt BCVT-CNTT | 15/05/2026 · 01/07/2026 (thay NĐ 15/2020) | Mức phạt trang TTĐT, MXH (Đ.93 tăng so với NĐ 15/2020 Đ.99) | lsvn.vn |

**Quốc tế (xác minh 2026-10-13):** EU DSA Regulation (EU) 2022/2065 (áp dụng chung 17/02/2024: notice-and-action Art. 16,
lý do quyết định Art. 17, khiếu nại nội bộ Art. 20, minh bạch đề xuất Art. 27, bảo vệ trẻ em Art. 28; VLOP từ 08/2023) ·
UK Online Safety Act 2023 (nội dung bất hợp pháp từ 17/03/2025; bộ quy tắc trẻ em 25/07/2025) · US DMCA 17 U.S.C. §512
(safe harbor, notice-and-takedown) · COPPA (nền tảng có trẻ em < 13) · GDPR · EU AI Act Art. 50 (nhãn/đánh dấu nội dung AI — mốc áp dụng ở [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md)) ·
Directive (EU) 2019/790 (bản quyền thị trường số, Art. 17) · WCAG 2.2.

## Mô hình dữ liệu / nghiệp vụ đặc trưng

- **Content** (`id, type, status, version, author, published_at, visibility, license, ai_generated, provenance`) với
  **ContentVersion** (bất biến) và **Revision log** (ai sửa gì, vì sao — kể cả sau xuất bản).
- **MediaAsset** (`storage_key, mime, duration, renditions[], hash, scan_status, moderation_status`).
- **UGC + Account** (`verified_phone/identity`, `is_minor`, `guardian`), **Report** (`reporter, target, reason,
  received_at, decided_at, decision, reason_text, appeal`), **Takedown notice** (bản quyền) + **Counter notice**.
- **Recommendation signal** giả danh hoá; cờ tắt cá nhân hoá theo người dùng; không dùng tín hiệu nhạy cảm.
- **Ad/sponsor** gắn `is_ad` hiển thị nhãn; consent cho tracking; nhãn người có ảnh hưởng.
- **Thời gian:** `published_at` theo UTC, hiển thị theo múi giờ độc giả; embargo theo giờ toà soạn.

## Ca biên nghiệp vụ

1. **Sửa bài sau xuất bản** (đính chính): phiên bản mới, ghi "đã sửa lúc…", bản cũ giữ cho kiểm chứng; URL không đổi.
2. **Gỡ nội dung theo yêu cầu cơ quan trong 24 h** nhưng tác giả kháng nghị: gỡ trước, kháng nghị sau, log đầy đủ hai bước.
3. **Báo cáo bản quyền giả (abuse DMCA)** để triệt đối thủ: counter-notice, xác minh người gửi, thống kê người báo cáo lạm dụng.
4. **Livestream chứa nội dung vi phạm giữa chừng:** cắt luồng theo thời gian thực, giữ bản ghi làm bằng chứng với retention có hạn.
5. **Tài khoản chưa xác thực SĐT** (NĐ 147) muốn bình luận: chỉ đọc; người dùng cũ có 90 ngày chuyển tiếp (đã qua).
6. **Trẻ dưới 16 lập tài khoản:** phải qua cha mẹ; nội dung đề xuất không khai thác; không quảng cáo hành vi.
7. **Ảnh/video AI deepfake của người thật:** gắn nhãn + watermark; nếu gây hại → cấm; kênh báo cáo ưu tiên.
8. **Bài viết lên hàng triệu lượt trong 10 phút** (viral): cache phải invalidate đúng phiên bản; CDN chịu tải; chi phí
   egress được cảnh báo.
9. **Xoá tài khoản nhưng bình luận còn trong bài người khác:** ẩn danh hoá bình luận (giữ nội dung, bỏ định danh) hoặc xoá theo chính sách công bố.
10. **Embargo 00:00 giờ VN, server UTC** → xuất bản 07:00 sai; lịch xuất bản phải có timezone.
11. **Nội dung được cấp phép có hạn (ảnh stock, bản quyền phim)**: hết hạn phải tự gỡ/thay; license lưu cùng asset.
12. **Người có ảnh hưởng quảng cáo không gắn nhãn:** hệ thống bắt gắn `is_ad` khi có hợp tác thương mại; không hiển thị nếu thiếu.

## Checklist

- [ ] `IND-MEDIA-001` **MUST** Tài khoản UGC (đăng, bình luận, livestream) chỉ được phép sau khi xác thực SĐT Việt Nam hoặc số định danh cá nhân theo NĐ 147/2024; tài khoản chưa xác thực chỉ đọc. → Kiểm: test E2E tài khoản chưa xác thực không có quyền đăng; cờ `verified_at`. · Nguồn: NĐ 147/2024/NĐ-CP (Đ.23, Đ.27 — chưa xác minh số điều)
- [ ] `IND-MEDIA-002` **MUST** Tài khoản trẻ em (< 16) do cha mẹ/người giám hộ đăng ký bằng thông tin của họ; mặc định riêng tư, không quảng cáo hành vi, không đề xuất khai thác; nội dung gây hại cho trẻ bị chặn/gỡ với hệ thống kỹ thuật hỗ trợ. → Kiểm: luồng đăng ký trẻ em gắn người giám hộ; cờ `is_minor` tắt ads/personalization (test chặn mạng); bộ lọc nội dung có test. · Nguồn: NĐ 147/2024/NĐ-CP; Luật ANM 116/2025/QH15 Đ.16; NĐ 56/2017/NĐ-CP Đ.35; DSA Art. 28
- [ ] `IND-MEDIA-003` **MUST** Luồng báo cáo/gỡ nội dung: tiếp nhận có mã, xử lý nội dung vi phạm pháp luật ≤ 24 h từ yêu cầu của cơ quan có thẩm quyền, quyết định có lý do gửi người đăng, kênh kháng nghị, log bất biến. → Kiểm: hàng chờ có `received_at/decided_at` và metric SLA 24 h; test quyết định sinh thông báo lý do; audit log append-only. · Nguồn: NĐ 147/2024/NĐ-CP; Luật ANM 116/2025/QH15; DSA Art. 16, 17, 20
- [ ] `IND-MEDIA-004` **MUST** Notice-and-takedown bản quyền: mẫu thông báo, xác minh người gửi, gỡ/khôi phục có thời hạn, counter-notice, thống kê lạm dụng; license của mọi asset (ảnh/video/font/nhạc) lưu cùng asset và tự gỡ khi hết hạn. → Kiểm: luồng DMCA/SHTT có test; `media_asset.license_id` bắt buộc; job hết hạn license. · Nguồn: Luật SHTT (sửa đổi 2022, 2025); 17 U.S.C. §512; DSA Art. 16; xem [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md)
- [ ] `IND-MEDIA-005` **MUST** Nội dung do AI tạo (audio/ảnh/video) gắn dấu hiệu nhận biết máy đọc được + nhãn hiển thị; deepfake người thật phải gắn nhãn rõ; nội dung cấm (lừa dối, thao túng, xâm hại) bị chặn. → Kiểm: test đầu ra pipeline có watermark/metadata; UI nhãn; bộ phát hiện deepfake trong kiểm duyệt. · Nguồn: Luật AI 134/2025/QH15 Đ.7; NĐ 142/2026/NĐ-CP Chương III; EU AI Act Art. 50(2)(4)
- [ ] `IND-MEDIA-006` **MUST** Quảng cáo và nội dung tài trợ có nhãn phân biệt rõ, kể cả bài của người có ảnh hưởng; nền tảng có tính năng gắn/hiển thị nhãn; tracking quảng cáo chỉ sau đồng ý. → Kiểm: `is_ad` hiển thị nhãn (snapshot); test chặn mạng tracker trước đồng ý; xem [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md). · Nguồn: Luật Quảng cáo sửa đổi 75/2025/QH15 Đ.15a; Luật 91/2025/QH15 Đ.28–29
- [ ] `IND-MEDIA-007` **MUST** Dịch vụ MXH/truyền thông trực tuyến: công khai dữ liệu thu thập, tuỳ chọn từ chối cookie và "không theo dõi", không yêu cầu ảnh giấy tờ cho xác thực thường, không đọc tin nhắn/ghi âm khi chưa đồng ý; lưu dữ liệu người dùng VN trong nước. → Kiểm: mục CMP-VN-010/011 đạt; test tuỳ chọn tồn tại và có hiệu lực. · Nguồn: Luật 91/2025/QH15 Đ.29; NĐ 330/2026 Đ.65; NĐ 333/2026/NĐ-CP Đ.19
- [ ] `IND-MEDIA-008` **MUST** Nội dung xuất bản có phiên bản bất biến, lịch sử chỉnh sửa công khai cho đính chính, URL ổn định (không đổi khi sửa tiêu đề), lịch xuất bản/embargo có múi giờ. → Kiểm: test sửa bài tạo version mới + dấu "đã chỉnh sửa"; redirect 301 khi đổi slug; test embargo 00:00 giờ VN. · Nguồn: Luật Báo chí 126/2025/QH15 (cải chính); thực hành toà soạn
- [ ] `IND-MEDIA-009` **MUST** Upload media: presigned URL, giới hạn kích thước/loại, quét mã độc, tách domain phục vụ file, transcode trong job nền idempotent, không chạy code từ nội dung người dùng. → Kiểm: test upload file độc bị từ chối; CSP/`Content-Disposition` cho domain file; xem [`../08-backend/files-and-media.md`](../08-backend/files-and-media.md). · Nguồn: OWASP ASVS 5.0 V12; [`../12-security/appsec-web.md`](../12-security/appsec-web.md)
- [ ] `IND-MEDIA-010` **MUST** Hiệu năng trang nội dung: LCP ≤ 2,5 s, CLS ≤ 0,1 (quảng cáo có khung giữ chỗ), INP ≤ 200 ms; cache theo phiên bản nội dung, invalidation khi xuất bản/sửa. → Kiểm: Lighthouse CI + RUM p75; test cache trả phiên bản mới ≤ 60 s sau xuất bản. · Nguồn: Core Web Vitals; [`../08-backend/caching.md`](../08-backend/caching.md)
- [ ] `IND-MEDIA-011` **MUST** Tiếp cận: phụ đề/transcript cho video/podcast, alt cho ảnh biên tập, cấu trúc heading, tương phản; trình phát điều khiển được bằng bàn phím. → Kiểm: axe = 0 lỗi nghiêm trọng; kiểm phụ đề bắt buộc trước xuất bản (CMS chặn). · Nguồn: WCAG 2.2 SC 1.2.2, 1.1.1; EAA 2019/882
- [ ] `IND-MEDIA-012` **MUST@M** Đề xuất/feed thuật toán: giải thích chính tham số chính, tuỳ chọn tắt cá nhân hoá (feed theo thời gian), không dùng dữ liệu nhạy cảm/trẻ em làm tín hiệu; đánh giá rủi ro hệ thống cho nền tảng lớn. → Kiểm: tuỳ chọn tắt có test; tài liệu tham số; data map tín hiệu đề xuất. · Nguồn: DSA Art. 27, 34–35; Luật 91/2025/QH15 Đ.30
- [ ] `IND-MEDIA-013` **MUST@M** Giấy phép/thông báo hoạt động: MXH trong nước vượt ngưỡng phải có giấy phép (NĐ 147); trang TTĐT tổng hợp/báo chí theo Luật Báo chí 2025; livestream/kiếm tiền chỉ khi đã cấp phép. → Kiểm: hồ sơ pháp lý trong `docs/legal/`; feature flag livestream gắn trạng thái giấy phép. · Nguồn: NĐ 147/2024/NĐ-CP; Luật Báo chí 126/2025/QH15; NĐ 237/2026/NĐ-CP
- [ ] `IND-MEDIA-014` **MUST@M** Kiểm duyệt CSAM/nội dung cực đoan bằng hash-matching/phân loại + báo cáo cơ quan chức năng; nhân viên kiểm duyệt có bảo vệ sức khoẻ tâm lý và công cụ làm mờ. → Kiểm: tích hợp hash DB có test; runbook báo cáo; cấu hình blur mặc định. · Nguồn: Luật ANM 116/2025/QH15 Đ.16; UK OSA 2023; DSA Art. 28
- [ ] `IND-MEDIA-015` **SHOULD** Nguồn gốc nội dung (provenance) cho bài/ảnh của toà soạn và nội dung AI qua C2PA hoặc metadata ký; hiển thị cho độc giả. → Kiểm: manifest hợp lệ với verifier. · Nguồn: C2PA (chưa xác minh phiên bản 2026-10-13); EU AI Act Art. 50
- [ ] `IND-MEDIA-016` **SHOULD** Chi phí media (storage/egress/transcode) theo dõi theo nội dung/kênh; chính sách rendition và vòng đời (lưu lạnh/xoá bản ít xem). → Kiểm: báo cáo cost; lifecycle policy trong IaC; xem [`../15-operations/cost-management.md`](../15-operations/cost-management.md). · Nguồn: thực hành FinOps
- [ ] `IND-MEDIA-017` **SHOULD** Xoá tài khoản: ẩn danh hoá bình luận/đóng góp còn trong ngữ cảnh người khác theo chính sách công bố; nội dung do người dùng sở hữu xoá hoặc trả về. → Kiểm: test xoá tài khoản → bình luận không còn định danh. · Nguồn: Luật 91/2025/QH15 Đ.14; GDPR Art. 17
- [ ] `IND-MEDIA-018` **SHOULD** Tìm kiếm/đa ngôn ngữ: index có tiếng Việt (dấu/không dấu), phân trang ổn định, không rò nội dung chưa xuất bản/hạn chế qua tìm kiếm. → Kiểm: test index chỉ chứa `status=published`; test không dấu. · Nguồn: [`../09-database/search-and-vector.md`](../09-database/search-and-vector.md)
- [ ] `IND-MEDIA-019` **SHOULD** Minh bạch kiểm duyệt: báo cáo định kỳ số yêu cầu gỡ, nguồn (cơ quan/người dùng), tỷ lệ kháng nghị thành công. → Kiểm: báo cáo công khai. · Nguồn: DSA Art. 15, 24
- [ ] `IND-MEDIA-020` **MAY** Hỗ trợ ActivityPub/RSS/Open Graph để nội dung di chuyển được và không khoá người dùng. → Kiểm: feed hợp lệ. · Nguồn: W3C ActivityPub (chưa xác minh phiên bản)
- [ ] `IND-MEDIA-021` **MAY** Thuê bao/paywall: hoá đơn điện tử, huỷ dễ như đăng ký, không dark pattern. → Kiểm: test huỷ ≤ cùng số bước đăng ký; xem [`fintech.md`](fintech.md). · Nguồn: Luật BVQLNTD 19/2023/QH15

## Cổng chất lượng tương đương

| Cổng chung | Tương đương truyền thông | Ngưỡng |
|---|---|---|
| CWV | LCP ≤ 2,5 s · CLS ≤ 0,1 (có quảng cáo) · INP ≤ 200 ms, p75 | Lighthouse CI + RUM |
| Kiểm duyệt | SLA 24 h yêu cầu cơ quan; báo cáo người dùng theo SLA công bố; 0 quyết định không lý do | metric + audit |
| A11y | 100% video có phụ đề; axe 0 lỗi nghiêm trọng | CMS gate |
| Pháp lý | Xác thực tài khoản, nhãn quảng cáo/AI, giấy phép ✅ | GO/NO-GO |
| Chi phí | Cost/1.000 lượt xem trong ngân sách | báo cáo tháng |

## Bẫy

- **Cho đăng bình luận ẩn danh** sau 25/12/2024 → vi phạm NĐ 147.
- **"Shadow ban" không thông báo, không lý do** → vi phạm DSA Art. 17 và mất lòng tin.
- **Sửa bài tại chỗ không dấu vết** → không đính chính được, vi phạm quy định cải chính.
- **Cache CDN giữ bản cũ sau gỡ** → nội dung vi phạm vẫn hiển thị quá 24 h.
- **Ảnh stock không rõ license** trên trang chủ.
- **Nhãn "AI" chỉ ở caption**, không có watermark máy đọc được.
- **Đề xuất dựa trên tín hiệu nhạy cảm** (tôn giáo, sức khoẻ) suy luận từ hành vi.
- **Quảng cáo chèn muộn gây CLS** → CWV đỏ, doanh thu giảm.

## Nguồn

- NĐ 147/2024/NĐ-CP (09/11/2024, hiệu lực 25/12/2024): <https://luatvietnam.vn/tin-van-ban-moi/tu-25-12-2024-tai-khoan-mang-xa-hoi-da-xac-thuc-bang-so-dien-thoai-moi-duoc-dang-bai-186-99855-article.html>; <https://lsvn.vn/quy-dinh-moi-ve-quan-ly-trang-thong-tin-dien-tu-mang-xa-hoi-a150603.html> — nguồn thứ cấp, xác minh 2026-10-13; kiểm tra văn bản sửa đổi trước khi áp dụng.
- Luật Báo chí 126/2025/QH15 (10/12/2025, hiệu lực 01/07/2026); NĐ 237/2026/NĐ-CP (26/06/2026): <https://luatvietnam.vn/chinh-sach/luat-bao-chi-2025-so-126-2025-qh15-422610-d1.html> — xác minh 2026-10-13.
- Luật Quảng cáo sửa đổi 75/2025/QH15 (hiệu lực 01/01/2026): <https://luatvietnam.vn/thuong-mai/luat-quang-cao-sua-doi-2025-so-75-2025-qh15-404208-d1.html> — xác minh 2026-10-13.
- Luật SHTT sửa đổi 131/2025/QH15 (hiệu lực 01/04/2026): <https://thuvienphapluat.vn/van-ban/So-huu-tri-tue/Law-131-2025-QH15-amendments-to-the-Law-on-Intellectual-Property-700208.aspx> — xác minh 2026-10-13; Luật 07/2022/QH15 (chưa xác minh ngày hiệu lực).
- NĐ 174/2026/NĐ-CP (15/05/2026, hiệu lực 01/07/2026): <https://lsvn.vn/tang-muc-xu-phat-tien-doi-voi-cac-vi-pham-ve-trang-thong-tin-dien-tu-a177134.html> — nguồn thứ cấp, 2026-10-13.
- Luật ANM 116/2025/QH15 Đ.16; NĐ 333/2026/NĐ-CP Đ.19; Luật 91/2025/QH15 Đ.29; NĐ 356/2025/NĐ-CP; NĐ 330/2026 Đ.65: xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) — xác minh 2026-10-13.
- Luật AI 134/2025/QH15; NĐ 142/2026/NĐ-CP: xem [`../16-compliance-privacy/ai-regulation.md`](../16-compliance-privacy/ai-regulation.md).
- DSA Regulation (EU) 2022/2065 (17/02/2024): <https://eumonitor.eu/9353000/1/j9vvik7m1c3gyxp/vlxjdfijgixk> — xác minh gián tiếp 2026-10-13 (EUR-Lex không truy cập được qua công cụ).
- UK Online Safety Act 2023 (17/03/2025; 25/07/2025): <https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/statement-protecting-children-from-harms-online> — xác minh 2026-10-13.
- DMCA 17 U.S.C. §512 — (chưa xác minh truy cập trang gốc ngày 2026-10-13).
- WCAG 2.2: <https://www.w3.org/TR/WCAG22/> — xác minh 2026-10-13.
