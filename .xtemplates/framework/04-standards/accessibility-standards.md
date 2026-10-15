---
title: Tiêu chuẩn tiếp cận (WCAG 2.2, EN 301 549, Section 508)
kind: standard
prefix: STD-A11Y
applies_to: [web-app, mobile-app, desktop-app, static-site, game, monorepo]
updated: 2026-10-14
---

# Tiêu chuẩn tiếp cận (WCAG 2.2, EN 301 549, Section 508)

> Phiên bản hiện hành của các chuẩn tiếp cận, chọn mức nào cho thị trường nào, và cách **chứng minh** tuân thủ bằng
> scan + bằng chứng kiểm tay. Kỹ thuật làm a11y ở [`../06-design-ux/accessibility.md`](../06-design-ux/accessibility.md);
> cách viết test ở [`../14-testing-quality/e2e-and-accessibility.md`](../14-testing-quality/e2e-and-accessibility.md).

## Nguyên tắc

- **WCAG 2.2 mức AA là mặc định toàn cầu.** EN 301 549 (EU) và Section 508 (Mỹ) đều quy chiếu WCAG; đạt 2.2 AA là đạt phần web của cả hai (Section 508 còn ở WCAG 2.0 AA — tập con).
- **Máy chỉ chứng minh được một phần.** axe/Lighthouse bắt lỗi kỹ thuật (contrast, nhãn, ARIA); nhiều tiêu chí (thứ tự focus hợp lý, nội dung dễ hiểu, lỗi gợi ý sửa) cần người. Bằng chứng tuân thủ = scan 0 lỗi **và** biên bản kiểm tay.
- **Tuyên bố theo tiêu chí (SC), không theo cảm giác.** Báo cáo tuân thủ liệt kê từng SC: đạt / không đạt / không áp dụng.
- **Không nhắm bản nháp.** WCAG 3.0 còn là Working Draft (2026-09-10); không viết vào hợp đồng/PROJECT.md.

## Quyết định

| Thị trường / loại | Chuẩn khai báo | Mức | Bằng chứng bắt buộc |
|---|---|---|---|
| Mặc định (mọi web/app) | WCAG 2.2 | AA | axe 0 lỗi critical/serious + kiểm tay bàn phím luồng chính |
| Cơ quan công / bán cho khu vực công EU | EN 301 549 (V3.2.1 bản hài hoà hiện hành trong OJ; V4.1.1 mới nhất 2026-09) + WCAG 2.2 AA | AA | Tuyên bố tiếp cận (accessibility statement) công khai + báo cáo theo mẫu EN |
| Bán cho chính phủ liên bang Mỹ | Section 508 (Revised 2017, E205.4 → WCAG 2.0 A+AA) | AA | ACR (Accessibility Conformance Report) theo mẫu VPAT |
| Mobile native | WCAG 2.2 AA qua WCAG2ICT + guideline nền tảng (Apple HIG Accessibility, Android Accessibility) | AA | Accessibility Inspector (iOS)/Accessibility Scanner (Android) + kiểm tay VoiceOver/TalkBack |
| Giáo dục, y tế, trẻ em | WCAG 2.2 AA + chọn vài SC AAA (2.4.12 Focus Not Obscured Enhanced, 3.3.9 Accessible Authentication Enhanced) | AA+ | như mặc định + SC AAA ghi rõ |
| Game | WCAG 2.2 AA cho UI/menu + Game Accessibility Guidelines (không phải chuẩn) | — | Checklist trong `GO-NO-GO.md` |

Mặc định khuyến nghị: **WCAG 2.2 AA**; không chọn A (quá thấp để được chấp nhận ở EU/Mỹ) và không hứa AAA toàn bộ (không khả thi cho mọi nội dung).

## Bảng phiên bản hiện hành (xác minh 2026-10-13)

| Chuẩn | Phiên bản | Phát hành | URL | Áp dụng khi | Chứng minh tuân thủ |
|---|---|---|---|---|---|
| WCAG | **2.2** (W3C Recommendation) | 2023-10-05, bản cập nhật 2024-12-12 | <https://www.w3.org/TR/WCAG22/> | Mọi UI web/hybrid | axe tags `wcag2a wcag2aa wcag21a wcag21aa wcag22aa` + bảng SC |
| ISO/IEC 40500 | **2025** (= WCAG 2.2 bản 10/2023; bản 12/2024 dự kiến thành ISO/IEC 40500:2026) | 2025 | <https://www.w3.org/WAI/standards-guidelines/wcag/> | Hợp đồng đòi mã ISO | Trích dẫn tương đương WCAG 2.2 |
| WCAG 3.0 | **Working Draft** | 2026-09-10 | <https://www.w3.org/TR/wcag-3.0/> | Không — theo dõi | — |
| EN 301 549 | **V4.1.1** mới nhất (gồm toàn văn WCAG 2.2); **V3.2.1** (2021-03) là bản hài hoà đang viện dẫn cho Directive (EU) 2016/2102 (tình trạng OJ của V4.1.1 **chưa xác minh**) | V4.1.1: 2026-09-02 | <https://www.etsi.org/deliver/etsi_en/301500_301599/301549/> | Khu vực công EU, European Accessibility Act (Directive (EU) 2019/882 — **chưa xác minh** ngày áp dụng) | Tuyên bố tiếp cận + báo cáo theo bảng điều khoản EN |
| Section 508 | Revised 508 Standards (36 CFR Part 1194) | Rule 2017-01-18, hiệu lực 2018-01-18 | <https://www.access-board.gov/ict/> | Chính phủ liên bang Mỹ | ACR/VPAT; E205.4 = WCAG 2.0 A+AA |

## Checklist

- [ ] `STD-A11Y-001` **MUST** Khai báo chuẩn và mức nhắm tới (`WCAG 2.2 AA`) trong `PROJECT.md`. → Kiểm: `grep -E "WCAG 2\.2 AA" PROJECT.md` khớp. · Nguồn: WCAG 2.2 Conformance
- [ ] `STD-A11Y-002` **MUST@M** Quét axe trong E2E với đủ tag tới `wcag22aa`, 0 vi phạm mức critical/serious trên mọi trang/màn chính. → Kiểm: cấu hình `AxeBuilder.withTags([... 'wcag22aa'])` trong test; job CI xanh. · Nguồn: WCAG 2.2 (SC AA)
- [ ] `STD-A11Y-003` **MUST@L** Có bảng tuân thủ theo SC (`docs/compliance/a11y-conformance.md`) gồm cả 6 SC mới mức A/AA của 2.2: 2.4.11, 2.5.7, 2.5.8, 3.2.6, 3.3.7, 3.3.8, mỗi SC có trạng thái đạt/không/không áp dụng. → Kiểm: `grep -cE "2\.4\.11|2\.5\.7|2\.5\.8|3\.2\.6|3\.3\.7|3\.3\.8" docs/compliance/a11y-conformance.md` ≥ 6. · Nguồn: WCAG 2.2 "New Success Criteria"
- [ ] `STD-A11Y-004` **MUST** Luồng chính được kiểm tay bằng bàn phím và ít nhất một trình đọc màn hình, ghi biên bản (người, ngày, luồng, kết quả) trong `GO-NO-GO.md`. → Kiểm: mục "Kiểm tay a11y" trong `GO-NO-GO.md` không trống. · Nguồn: WCAG 2.2 SC 2.1.1, 4.1.2
- [ ] `STD-A11Y-005` **MUST@M** Sản phẩm cho khu vực công EU có trang tuyên bố tiếp cận công khai ghi phiên bản EN 301 549 áp dụng. → Kiểm: `curl -s https://<domain>/accessibility-statement` trả 200 và chứa "EN 301 549". · Nguồn: Directive (EU) 2016/2102 Art. 7; EN 301 549
- [ ] `STD-A11Y-006` **MUST@L** Sản phẩm bán cho chính phủ liên bang Mỹ có ACR theo mẫu VPAT, tối thiểu WCAG 2.0 AA. → Kiểm: file `docs/compliance/acr-vpat.md` (hoặc PDF) có bảng SC và ngày. · Nguồn: Section 508 E205.4
- [ ] `STD-A11Y-007` **MUST@L** Không khai báo WCAG 3.0 hay bản nháp làm mục tiêu tuân thủ. → Kiểm: `grep -riE "WCAG ?3" PROJECT.md docs/compliance/` không khớp. · Nguồn: W3C WD 2026-09-10 (status)
- [ ] `STD-A11Y-008` **SHOULD** Mobile native dùng công cụ nền tảng (Accessibility Inspector/Accessibility Scanner) và đối chiếu WCAG2ICT. → Kiểm: báo cáo scan lưu trong artifact release.
- [ ] `STD-A11Y-009` **SHOULD** Lint tĩnh a11y bật trong CI (`eslint-plugin-jsx-a11y`, `eslint-plugin-vuejs-accessibility`, hoặc tương đương). → Kiểm: tên plugin xuất hiện trong config lint và job lint chạy.
- [ ] `STD-A11Y-010` **SHOULD** Điểm Lighthouse Accessibility ≥ 0.9 trên các URL chính (chỉ là chỉ báo, không thay bảng SC). → Kiểm: `lighthouserc` assertion `categories:accessibility` `minScore: 0.9`.
- [ ] `STD-A11Y-011` **SHOULD** Bảng tuân thủ được rà lại ở mỗi bản phát hành lớn hoặc ≤ 12 tháng. → Kiểm: trường `verified_at` trong file tuân thủ, script cảnh báo khi > 365 ngày.
- [ ] `STD-A11Y-012` **MAY** Chọn thêm SC AAA phù hợp sản phẩm (giáo dục, y tế, chính phủ) và ghi rõ trong bảng tuân thủ.
- [ ] `STD-A11Y-013` **MAY** Viện dẫn ISO/IEC 40500:2025 trong hợp đồng khi khách hàng yêu cầu mã ISO.

## Bẫy thường gặp

- **axe "0 lỗi" = "đạt WCAG".** Scanner chỉ bao phủ tập con quy tắc máy kiểm được; nhiều SC cần người. Cách tránh: STD-A11Y-004 bắt buộc biên bản kiểm tay.
- **Quên tag `wcag22aa`.** Mặc định axe không bật đủ tag 2.2 → bỏ sót Target Size (2.5.8), Focus Not Obscured (2.4.11). Cách tránh: ghi rõ tag trong helper test dùng chung.
- **Vẫn kiểm SC 4.1.1 Parsing.** 2.2 bỏ 4.1.1; báo lỗi "parsing" gây tranh cãi vô ích. Cách tránh: bảng SC làm từ 2.2, không copy từ 2.1.
- **Lẫn 24px và 44px.** WCAG 2.5.8 (AA) yêu cầu vùng chạm tối thiểu 24×24 CSS px (có ngoại lệ); 44px là khuyến nghị nền tảng mobile/AAA (2.5.5). Cách tránh: ghi rõ ngưỡng và nguồn trong design tokens.
- **Nhầm EN 301 549 V4.1.1 với bản hài hoà.** Pháp lý EU viện dẫn bản được công bố trong OJ (hiện V3.2.1); V4.1.1 mới nhất nhưng tình trạng OJ chưa xác minh. Cách tránh: tuyên bố tiếp cận ghi đúng bản viện dẫn.
- **Tưởng Section 508 = WCAG 2.2.** Section 508 vẫn trích WCAG 2.0 AA; đạt 2.2 AA là đủ nhưng ACR phải trình bày theo 2.0. Cách tránh: dùng mẫu VPAT đúng edition.
- **Overlay/widget "tự động sửa a11y".** Không thay đổi DOM gốc, không đạt SC, nhiều vụ kiện ở Mỹ. Cách tránh: sửa tại mã nguồn.
- **Lighthouse 100 điểm a11y → tuyên bố tuân thủ.** Lighthouse dùng tập con axe và chỉ chấm trang đơn. Cách tránh: coi là chỉ báo (STD-A11Y-010), bằng chứng là bảng SC + kiểm tay.

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| `@axe-core/playwright` 4.13.0 (MPL-2.0) | `new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze()` | CI job `e2e` | 0 violation impact `critical`/`serious` |
| `pa11y-ci` 5.0.0 (LGPL-3.0; quét nhanh nhiều URL tĩnh) | `pa11y-ci --config .pa11yci.json` (standard `WCAG2AA`) | CI nightly cho static-site | 0 error |
| `eslint-plugin-jsx-a11y` 6.10.2 (MIT) | rule set `recommended` | pre-commit + CI lint | 0 error |
| Lighthouse CI `@lhci/cli` 0.15.1 (Apache-2.0; **repo đứng yên từ 2025-06-26**) | `lhci autorun` với `categories:accessibility: ['error', {minScore: 0.9}]` | CI PR | ≥ 0.9 |
| Script kiểm tuyên bố | `grep -E "WCAG 2\.2 AA" PROJECT.md` + kiểm file tuân thủ | CI job `gate` | khớp |

## Nguồn

- WCAG 2.2 (W3C Recommendation 2023-10-05, cập nhật 2024-12-12): <https://www.w3.org/TR/WCAG22/> — xác minh 2026-10-13
- W3C WAI — WCAG overview (ISO/IEC 40500:2025; WCAG 3 early draft): <https://www.w3.org/WAI/standards-guidelines/wcag/> — xác minh 2026-10-13
- WCAG 3.0 Working Draft 2026-09-10: <https://www.w3.org/TR/wcag-3.0/> — xác minh 2026-10-13
- ETSI EN 301 549 (thư mục bản phát hành; V4.1.1 file 2026-09-02): <https://www.etsi.org/deliver/etsi_en/301500_301599/301549/> — xác minh 2026-10-13; tình trạng hài hoà trong OJ **(chưa xác minh)**
- U.S. Access Board — Revised 508 Standards (E205.4 WCAG 2.0 A/AA): <https://www.access-board.gov/ict/> · <https://www.section508.gov/manage/laws-and-policies/> — xác minh 2026-10-13
- Phiên bản công cụ: `registry.npmjs.org` (`@axe-core/playwright` 4.13.0, `pa11y-ci` 5.0.0, `eslint-plugin-jsx-a11y` 6.10.2, `@lhci/cli` 0.15.1) — xác minh 2026-10-13; Lighthouse CI commit cuối 2025-06-26: <https://github.com/GoogleChrome/lighthouse-ci/commits/main>
- Khung cũ X-stored `quality-supplements.md` Nhóm 2 mục 3 (a11y hai tầng), commit `1b80fe4`.
