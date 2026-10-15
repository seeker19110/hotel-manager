---
title: Đồng ý, quyền chủ thể dữ liệu (truy cập/xoá/di chuyển), cookie, trẻ em
kind: module
prefix: CMP-RIGHTS
applies_to: [web-app, mobile-app, desktop-app, static-site, game, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-14
---

# Đồng ý, quyền chủ thể dữ liệu (truy cập/xoá/di chuyển), cookie, trẻ em

> Cách **xây luồng** đồng ý, cookie/tracking, thực hiện quyền của người dùng (DSAR) và bảo vệ trẻ em sao cho kiểm
> được bằng máy. Căn cứ pháp lý Việt Nam ở [`vietnam-data-law.md`](vietnam-data-law.md), quốc tế ở
> [`international-privacy.md`](international-privacy.md); thiết kế tối thiểu hoá/xoá ở
> [`privacy-by-design.md`](privacy-by-design.md). Module này chỉ nói **giao diện, dữ liệu và quy trình** của đồng ý & quyền.

## Nguyên tắc

1. **Đồng ý là bản ghi, không phải checkbox:** lưu ai, khi nào, đồng ý gì (mục đích, phiên bản văn bản), qua kênh nào,
   rút khi nào — và chứng minh được (Luật 91/2025 Đ.9; GDPR Art. 7(1)).
2. **Mặc định không:** không tick sẵn, im lặng ≠ đồng ý, "tiếp tục dùng = đồng ý" không hợp lệ ở VN/EU.
3. **Rút đồng ý dễ như cho:** cùng số bước, cùng vị trí; rút → dừng xử lý mục đích đó (không xoá hồi tố nghĩa vụ pháp lý).
4. **Quyền của người dùng là tính năng sản phẩm, có SLA:** truy cập, sửa, xoá, hạn chế, phản đối, di chuyển, không
   bị quyết định tự động — có endpoint/giao diện, có hàng chờ, có thời hạn đo được.
5. **Trẻ em được bảo vệ hơn, không phải loại trừ:** xác định tuổi hợp lý theo rủi ro; người đại diện đồng ý; trẻ ≥ 7
   tuổi cũng được hỏi khi công bố thông tin riêng tư (NĐ 56/2017 Đ.36; Luật 91/2025 Đ.24).
6. **Dark pattern là vi phạm:** nút "từ chối" phải ngang hàng "đồng ý"; không ép đồng ý để dùng tính năng không liên quan.

## Quyết định

| Tình huống | Cơ sở xử lý nên chọn | Ghi chú |
|---|---|---|
| Dữ liệu cần để cung cấp dịch vụ đã ký (tài khoản, đơn hàng) | Thực hiện hợp đồng — không cần ô đồng ý riêng | VN: Luật 91/2025 Đ.19 liệt kê trường hợp không cần đồng ý; vẫn phải thông báo |
| Tiếp thị, cá nhân hoá, chia sẻ đối tác, cookie theo dõi | **Đồng ý** theo từng mục đích, opt-in | Rút được bất kỳ lúc nào |
| Cookie/kỹ thuật cần thiết (phiên, giỏ hàng, bảo mật) | Không cần đồng ý, nhưng phải liệt kê | ePrivacy Art. 5(3); Luật 91/2025 Đ.29 (tuỳ chọn từ chối cookie) |
| Analytics không định danh (không IP, không cross-site) | Tuỳ pháp luật: EU vài nước cho miễn; VN: cung cấp tuỳ chọn "không theo dõi" | Chọn công cụ không cookie khi có thể |
| Người dùng < 16 (VN) / < 16 hoặc 13 (EU theo nước) / < 13 (US COPPA) | Đồng ý người đại diện **có xác minh** tương xứng rủi ro | Dịch vụ hướng đến trẻ em: mặc định không thu thập; COPPA từ 22/04/2026 yêu cầu đồng ý riêng cho chia sẻ bên thứ ba |
| Tín hiệu trình duyệt Global Privacy Control / Do Not Track | Tôn trọng như yêu cầu từ chối bán/chia sẻ (CCPA bắt buộc GPC); VN: tuỳ chọn "không theo dõi" | Implement ở server, không chỉ client |

**Mặc định khuyến nghị:** bảng `consent_records` + dịch vụ đồng ý (consent service) là nguồn sự thật; SDK/tracking
chỉ nạp sau khi service trả `granted` cho mục đích tương ứng; DSAR qua một hàng chờ có SLA và bằng chứng.

## Checklist

- [ ] `CMP-RIGHTS-001` **MUST** Bản ghi đồng ý lưu `subject_id, purpose_id, policy_version, granted_at, channel, ui_snapshot_hash, withdrawn_at`; truy vấn được theo người dùng; không sửa tại chỗ (append). → Kiểm: schema bảng; test ghi/rút tạo bản ghi mới; export theo người dùng. · Nguồn: GDPR Art. 7(1); Luật 91/2025/QH15 Đ.9
- [ ] `CMP-RIGHTS-002` **MUST@L** Mọi ô đồng ý mặc định chưa chọn, tách theo mục đích, nút "từ chối"/"chỉ cần thiết" ngang hàng và cùng bước với "đồng ý". → Kiểm: test E2E snapshot trạng thái mặc định; kiểm cấu trúc DOM 2 nút cùng cấp; không có nút từ chối ẩn sau "tuỳ chỉnh". · Nguồn: Luật 91/2025/QH15 Đ.9; GDPR Art. 4(11), Art. 7(4); NĐ 330/2026 Đ.43
- [ ] `CMP-RIGHTS-003` **MUST** Script/SDK theo dõi (analytics, ads, session replay, pixel) chỉ nạp **sau** khi đồng ý mục đích tương ứng; từ chối → không có request ra ngoài. → Kiểm: test Playwright chặn mạng: trước khi đồng ý, 0 request tới domain tracker; cookie theo dõi không được đặt. · Nguồn: ePrivacy Directive 2002/58/EC Art. 5(3); Luật 91/2025/QH15 Đ.29
- [ ] `CMP-RIGHTS-004` **MUST** Rút đồng ý có cùng số bước/vị trí như cho; rút → dừng xử lý mục đích đó ≤ thời hạn luật (VN: không quá 72 giờ theo NĐ 356/2025 — chưa xác minh số điều) và lan tới bên thứ ba. → Kiểm: test E2E rút tiếp thị → email tiếp thị không còn gửi; webhook/API tới nhà cung cấp email cập nhật. · Nguồn: Luật 91/2025/QH15 Đ.10; GDPR Art. 7(3)
- [ ] `CMP-RIGHTS-005` **MUST@L** Thông báo xử lý (privacy notice) hiển thị **trước** thu thập, có phiên bản; phiên bản người dùng đã đồng ý được lưu; thay đổi lớn → hỏi lại. → Kiểm: `policy_version` trong consent khớp phiên bản hiện hành; test đổi phiên bản → prompt lại. · Nguồn: Luật 91/2025/QH15 Đ.9, Đ.11; GDPR Art. 13
- [ ] `CMP-RIGHTS-006` **MUST@L** Quyền truy cập/sao chép dữ liệu: người dùng tự phục vụ lấy toàn bộ dữ liệu về mình (gồm dữ liệu suy luận) ở định dạng máy đọc được (JSON/CSV) trong thời hạn luật (GDPR 1 tháng; VN theo NĐ 356 — chưa xác minh số điều). → Kiểm: endpoint/job export có test; đối chiếu danh sách kho trong data map. · Nguồn: GDPR Art. 15, 20; Luật 91/2025/QH15 Đ.4
- [ ] `CMP-RIGHTS-007` **MUST** Quyền xoá: tự phục vụ, xác thực lại trước khi xoá, lan tới mọi kho và bên xử lý; trường hợp từ chối (nghĩa vụ pháp lý lưu) phải nêu căn cứ và chỉ giữ phần bắt buộc. → Kiểm: mục CMP-PRIV-005; test xoá tài khoản có dữ liệu phải giữ (hoá đơn) → PII ngoài hoá đơn bị xoá, hoá đơn giữ với lý do. · Nguồn: GDPR Art. 17; Luật 91/2025/QH15 Đ.14
- [ ] `CMP-RIGHTS-008` **MUST@L** Quyền sửa/hạn chế/phản đối có giao diện hoặc kênh tiếp nhận ghi vé, SLA đo được, bằng chứng hoàn thành. → Kiểm: hàng chờ DSAR có trường `received_at, due_at, completed_at`; metric SLA; báo cáo tháng. · Nguồn: GDPR Art. 16, 18, 21; Luật 91/2025/QH15 Đ.4, Đ.13
- [ ] `CMP-RIGHTS-009` **MUST@L** Xác minh danh tính người yêu cầu DSAR tương xứng (đăng nhập + yếu tố thứ hai cho xoá/xuất); không gửi dữ liệu cho email chưa xác thực. → Kiểm: test yêu cầu từ phiên chưa MFA bị từ chối bước xuất. · Nguồn: GDPR Art. 12(6); ASVS 5.0 V6
- [ ] `CMP-RIGHTS-010` **MUST@L** Quyết định tự động có ảnh hưởng đáng kể (chấm điểm, từ chối dịch vụ, giá cá nhân hoá): thông báo rõ, giải thích logic chính, cho phép yêu cầu người xem lại và từ chối. → Kiểm: UI có thông báo + nút "yêu cầu xem xét"; log quyết định có `model_version`. · Nguồn: GDPR Art. 22; Luật 91/2025/QH15 Đ.30; CCPA regs ADMT (01/01/2027)
- [ ] `CMP-RIGHTS-011` **MUST@L** Trẻ em: xác định tuổi ở đăng ký (ngày sinh hoặc tín hiệu); dưới 16 (VN) phải có đồng ý người đại diện với xác minh tương xứng; công bố thông tin riêng tư của trẻ ≥ 7 tuổi cần đồng ý cả trẻ; người đại diện rút → dừng xử lý. → Kiểm: test E2E luồng dưới 16; bản ghi đồng ý có `guardian_subject_id`; không hiển thị hồ sơ trẻ công khai mặc định. · Nguồn: Luật 91/2025/QH15 Đ.24; NĐ 56/2017/NĐ-CP Đ.36; Luật Trẻ em 102/2016/QH13 Đ.1, Đ.21
- [ ] `CMP-RIGHTS-012` **MUST@L** Dịch vụ hướng đến trẻ em/MXH: tài khoản dưới 16 do cha mẹ/người giám hộ đăng ký bằng thông tin của họ; có công cụ giám sát; kiểm soát nội dung gây hại; không quảng cáo hành vi cho trẻ. → Kiểm: luồng đăng ký trẻ em gắn tài khoản giám hộ; cờ `is_minor` tắt cá nhân hoá quảng cáo (test). · Nguồn: NĐ 147/2024/NĐ-CP; Luật ANM 116/2025/QH15 Đ.16; EU AI Act Art. 5; COPPA 16 CFR 312
- [ ] `CMP-RIGHTS-013` **MUST@L** Tôn trọng tín hiệu Global Privacy Control/"không theo dõi" ở server: nhận header/cookie → ghi như từ chối bán/chia sẻ/theo dõi cho phiên và tài khoản. → Kiểm: test gửi `Sec-GPC: 1` → không nạp tracker, consent ghi `denied` nguồn `gpc`. · Nguồn: CCPA §1798.135(b); Luật 91/2025/QH15 Đ.29 ("không theo dõi")
- [ ] `CMP-RIGHTS-014` **SHOULD** Trung tâm quyền riêng tư trong app: xem/sửa từng đồng ý, tải dữ liệu, xoá tài khoản, lịch sử yêu cầu — không cần gửi email. → Kiểm: trang tồn tại, E2E đủ 4 chức năng. · Nguồn: GDPR Art. 12 (dễ tiếp cận); Luật 91/2025/QH15 Đ.4
- [ ] `CMP-RIGHTS-015` **SHOULD** Banner cookie dùng cùng ngôn ngữ và dễ hiểu (đọc được ở trình độ phổ thông), tiếp cận được (bàn phím, screen reader), không chặn nội dung thiết yếu. → Kiểm: axe trên banner = 0 lỗi; test tab/Esc. · Nguồn: WCAG 2.2 SC 2.1.1; GDPR Art. 12(1)
- [ ] `CMP-RIGHTS-016` **SHOULD** Danh sách cookie/SDK sinh tự động từ quét thực tế (crawler) và đối chiếu với tuyên bố; cookie mới chưa khai báo → fail CI. → Kiểm: job quét staging liệt kê cookie; diff với `docs/privacy/cookies.yaml` = 0. · Nguồn: ePrivacy Art. 5(3)
- [ ] `CMP-RIGHTS-017` **SHOULD** Đồng ý thu qua kênh khác (giọng nói, giấy, offline) được số hoá vào cùng bảng với bằng chứng (file/hash). → Kiểm: bản ghi `channel != web` có `evidence_uri`. · Nguồn: Luật 91/2025/QH15 Đ.9 (hình thức in/sao chép được)
- [ ] `CMP-RIGHTS-018` **SHOULD** Email/SMS tiếp thị có liên kết huỷ đăng ký một chạm, xử lý ≤ 10 ngày (CAN-SPAM) và ngay lập tức ở hệ thống của mình. → Kiểm: header `List-Unsubscribe` + test huỷ cập nhật consent. · Nguồn: CAN-SPAM 16 CFR 316; RFC 8058
- [ ] `CMP-RIGHTS-019` **SHOULD** Khi người dùng tử vong/mất năng lực hành vi: quy trình cho người đại diện theo pháp luật yêu cầu truy cập/xoá với giấy tờ. → Kiểm: runbook + mẫu. · Nguồn: Luật 91/2025/QH15 Đ.24
- [ ] `CMP-RIGHTS-020` **MAY** Dùng chuẩn mã hoá đồng ý máy đọc được (vd IAB TCF v2.2 cho ads, hoặc cấu trúc riêng) để truyền trạng thái đồng ý tới đối tác. → Kiểm: payload chuẩn có test. · Nguồn: IAB TCF v2.2 (chưa xác minh phiên bản ngày 2026-10-13)
- [ ] `CMP-RIGHTS-021` **MAY** Xác minh tuổi bằng phương pháp bảo toàn riêng tư (ước lượng không lưu ảnh, VNeID/ví định danh) thay vì tải giấy tờ. → Kiểm: không lưu ảnh giấy tờ sau xác minh. · Nguồn: Luật 91/2025/QH15 Đ.29; eIDAS 2.0 (EU) 2024/1183

## Bẫy thường gặp

- **Banner "Bằng việc tiếp tục bạn đồng ý"**: vô hiệu ở VN/EU. Cách tránh: hai nút ngang hàng, không nạp tracker trước khi chọn.
- **Tracker nạp trước banner** vì tag manager mặc định: đo bằng test chặn mạng.
- **"Xoá tài khoản" = đổi trạng thái** và email vẫn nhận tiếp thị.
- **DSAR qua email thủ công, không SLA, không bằng chứng** → không chứng minh được khi bị kiểm tra.
- **Rút đồng ý chỉ ở hệ thống của mình**, nhà cung cấp email/ads vẫn giữ danh sách.
- **Hỏi tuổi bằng "Tôi trên 18"** cho dịch vụ nhiều trẻ em → không tương xứng rủi ro; ngược lại đòi CCCD cho mọi người → vi phạm Đ.29.
- **Ép đồng ý tiếp thị để tạo tài khoản** (bundling) → đồng ý không tự nguyện.
- **Phiên bản chính sách đổi mà không prompt lại** → đồng ý cũ không còn giá trị cho mục đích mới.

## Cổng tự động

| Việc kiểm | Công cụ (giấy phép) | Lệnh/cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Không có request tracker trước khi đồng ý | Playwright (Apache-2.0) `page.route` + danh sách domain tracker | `npm run test:e2e -- --grep consent-gating` | CI (PR) | 0 request |
| Mặc định ô đồng ý chưa chọn, 2 nút ngang hàng | Playwright snapshot + kiểm DOM | `consent-defaults.spec` | CI | pass |
| A11y banner/trung tâm quyền riêng tư | `@axe-core/playwright` 4.13.0 (MPL-2.0, xác minh npm 2026-10-13) | trong E2E | CI | 0 lỗi serious/critical |
| Cookie thực tế ↔ khai báo | Script crawl staging (Playwright) → so `docs/privacy/cookies.yaml` | `node scripts/privacy/cookie-audit.mjs` | CI nightly | diff = 0 |
| GPC/"không theo dõi" | Test gửi header `Sec-GPC: 1` | E2E | CI | consent = denied |
| SLA DSAR | Metric `dsar_overdue_count` | alert > 0 | Observability | 0 quá hạn |
| Xoá lan mọi kho | E2E xoá tài khoản (xem CMP-PRIV) | CI merge | — | pass |

## Nguồn

- Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 (hiệu lực 01/01/2026) Đ.4, Đ.9, Đ.10, Đ.11, Đ.13, Đ.14, Đ.24, Đ.29, Đ.30: <https://vanban.chinhphu.vn/?pageid=27160&docid=214590> — xác minh 2026-10-13; NĐ 356/2025/NĐ-CP (thay NĐ 13/2023/NĐ-CP từ 01/01/2026): <https://vanban.chinhphu.vn/?pageid=27160&docid=216387> — xác minh 2026-10-13, thời hạn thực hiện quyền (chưa xác minh số điều). Kiểm tra văn bản sửa đổi trước khi áp dụng.
- NĐ 330/2026/NĐ-CP Đ.43, Đ.65 (mức phạt về đồng ý, MXH): <https://luatvietan.vn/nghi-dinh-330-2026-nd-cp.html> — nguồn thứ cấp, xác minh 2026-10-13.
- NĐ 56/2017/NĐ-CP Đ.33–37; Luật Trẻ em 102/2016/QH13: <https://hethongphapluat.com/nghi-dinh-56-2017-nd-cp-huong-dan-luat-tre-em.html> — xác minh 2026-10-13; NĐ 147/2024/NĐ-CP (25/12/2024): <https://luatvietnam.vn/tin-van-ban-moi/tu-25-12-2024-tai-khoan-mang-xa-hoi-da-xac-thuc-bang-so-dien-thoai-moi-duoc-dang-bai-186-99855-article.html> — 2026-10-13.
- GDPR Art. 4(11), 7, 8, 12–22: <https://eur-lex.europa.eu/eli/reg/2016/679/oj> — xác minh gián tiếp 2026-10-13; ePrivacy Directive 2002/58/EC Art. 5(3) — (chưa xác minh trực tiếp EUR-Lex ngày 2026-10-13).
- COPPA Rule 16 CFR Part 312, bản sửa đổi 90 FR 16918 (22/04/2025), hiệu lực 23/06/2025, tuân thủ từ 22/04/2026: <https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312> (eCFR, HTTP 200) và bản sửa đổi <https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule> (Federal Register, HTTP 200) — xác minh 2026-10-14 (link ftc.gov gốc 404/không truy cập được).
- CCPA/CPRA — GPC §1798.135; quy định ADMT (hiệu lực 01/01/2027): <https://www.cppa.ca.gov/announcements/2025/20250923.html> — xác minh 2026-10-13.
- RFC 8058 (one-click unsubscribe): <https://www.rfc-editor.org/rfc/rfc8058> — (chưa xác minh truy cập ngày 2026-10-13).
- `@axe-core/playwright` 4.13.0: <https://registry.npmjs.org/@axe-core/playwright/latest> — xác minh 2026-10-13.
