---
title: Bàn giao & các bên: tài liệu bàn giao, đào tạo, hỗ trợ, kết thúc dự án
kind: module
prefix: PM-HANDOVER
applies_to: [all]
updated: 2026-10-14
---

# Bàn giao & các bên: tài liệu bàn giao, đào tạo, hỗ trợ, kết thúc dự án

> Dự án chỉ "xong" khi **người khác** vận hành được mà không cần người xây ngồi cạnh: tài liệu bàn giao đủ, runbook
> được người mới chạy thử, tài khoản/secret chuyển giao an toàn, có kênh hỗ trợ và điều kiện kết thúc rõ ràng.
> Áp dụng ở **G7–G8** và bất cứ khi nào đổi người/đội/nhà cung cấp. Mẫu: [`../templates/RUNBOOK.md`](../templates/RUNBOOK.md),
> [`../templates/GO-NO-GO.md`](../templates/GO-NO-GO.md).

## Nguyên tắc

1. **Bàn giao là cổng có bằng chứng**, không phải buổi họp: người nhận tự chạy được runbook từ đầu, ghi lại chỗ vấp; chỗ vấp là lỗi tài liệu phải sửa trước khi ký.
2. **Một người quyết định cuối cho mỗi quyết định.** Bản đồ các bên (ai quyết, ai làm, ai được hỏi, ai được báo) ghi thành văn bản; GO/NO-GO có người ký tên.
3. **Secret không đi qua chat.** Chuyển giao tài khoản bằng cơ chế của nền tảng (chuyển ownership, kho secret dùng chung) và **xoay** ngay sau bàn giao; chi tiết ở [`../12-security/secrets-management.md`](../12-security/secrets-management.md).
4. **Bus factor ≥ 2** cho mọi thành phần sống còn trước khi ra mắt; một người biết = rủi ro mức cao trong sổ rủi ro.
5. **Hỗ trợ có mức dịch vụ ghi thành số** (kênh, giờ, thời gian phản hồi theo SEV); quy trình sự cố ở [`../15-operations/incident-response.md`](../15-operations/incident-response.md).
6. **Kết thúc có checklist như bắt đầu**: thu hồi quyền, tắt tài nguyên, xử lý dữ liệu theo luật, chuyển giao domain/IP, lưu trữ repo — không "để đó".
7. **Mỗi bàn giao để lại bài học**: retrospective ngắn, hàng rào mới (P12) cho lần sau.
8. **Tài liệu bàn giao là file trong repo, được máy kiểm còn đúng** (build từ clone sạch, link sống, lệnh chạy được) — không phải tệp đính kèm email.

## Quyết định

| Kiểu bàn giao | Gói tối thiểu | Cổng ký | Điểm riêng |
|---|---|---|---|
| Nội bộ: đội khác tiếp quản | README + RUNBOOK + ADR + PROGRESS + sổ rủi ro + danh sách tài khoản + dashboard | Người nhận chạy runbook thành công; bus factor ≥2 | Lịch "đi kèm" 1–2 tuần, người cũ chỉ trả lời, không làm hộ |
| Khách hàng/đối tác nhận sản phẩm | Gói nội bộ + tài liệu người dùng + điều khoản hỗ trợ/SLA + biên bản nghiệm thu theo tiêu chí chấp nhận | GO/NO-GO có chữ ký hai bên + bằng chứng từng mục | Chuyển ownership tài khoản (cloud, domain, store, email) trước khi ký; IP/license theo [`../16-compliance-privacy/licensing-and-ip.md`](../16-compliance-privacy/licensing-and-ip.md) |
| Mở mã nguồn / cộng đồng | README + CONTRIBUTING + LICENSE + SECURITY.md + release notes | Người ngoài build từ clone sạch | Quy trình ở [`../18-cross-cutting/open-source-and-community.md`](../18-cross-cutting/open-source-and-community.md) |
| Kết thúc / đóng dự án | Checklist đóng: thu hồi quyền, tắt tài nguyên, xoá/lưu dữ liệu theo luật, archive repo, chuyển domain | Người sở hữu ký "đã đóng" + bằng chứng | Thời hạn lưu dữ liệu và nghĩa vụ pháp lý sau khi đóng |

## Checklist

- [ ] `PM-HANDOVER-001` **MUST@L** Bản đồ các bên (`docs/STAKEHOLDERS.md` hoặc mục trong `PROJECT.md`): vai trò, tên, quyết định gì, kênh liên hệ, người thay thế. → Kiểm: bảng có ≥1 dòng "quyết định cuối" cho phạm vi, phát hành, bảo mật; không ô trống ở cột "người thay thế" khi dự án ≥ M.
- [ ] `PM-HANDOVER-002` **MUST** Gói tài liệu bàn giao tồn tại trong repo: `README.md` (chạy local từ clone sạch), `RUNBOOK.md`, `docs/adr/`, `PROGRESS.md`, sổ rủi ro, danh sách tài khoản/dịch vụ (không chứa secret). → Kiểm: `test -f README.md -a -f RUNBOOK.md -a -d docs/adr`; CI job "clean clone build" xanh.
- [ ] `PM-HANDOVER-003` **MUST@L** Runbook được **người không xây** chạy từ đầu (deploy, rollback, khôi phục backup, xử lý cảnh báo mẫu) và ghi log chỗ vấp; chỗ vấp sửa xong mới ký bàn giao. → Kiểm: `docs/handover/runbook-test-<ngày>.md` ghi tên người chạy, từng bước PASS/FAIL, commit sửa runbook sau đó.
- [ ] `PM-HANDOVER-004` **MUST** Tài khoản/secret chuyển giao bằng cơ chế nền tảng (chuyển ownership tổ chức, kho secret dùng chung, mời thành viên) — không gửi qua chat/email; mọi secret được xoay sau bàn giao. → Kiểm: `docs/handover/accounts.md` liệt kê dịch vụ · chủ mới · ngày chuyển · ngày xoay; `gitleaks detect` sạch; không có secret trong lịch sử chat đính kèm.
- [ ] `PM-HANDOVER-005` **MUST** Quyền truy cập của người rời dự án bị thu hồi trong ngày rời (repo, cloud, CSDL, kho secret, dashboard, store, domain) và có danh sách kiểm. → Kiểm: `docs/handover/offboarding-<tên>.md` tick đủ dịch vụ với ngày; `gh api orgs/<org>/members` không còn tên.
- [ ] `PM-HANDOVER-006` **MUST@L** Nghiệm thu dùng GO/NO-GO: mỗi tiêu chí chấp nhận có PASS/FAIL/N/A + bằng chứng (file:dòng, link CI, ảnh); người ký cuối ghi tên/ngày. → Kiểm: `docs/GO-NO-GO-<phiên bản>.md` không có BLOCKER FAIL; chữ ký tồn tại.
- [ ] `PM-HANDOVER-007` **MUST@L** Mức hỗ trợ ghi thành số: kênh, giờ phục vụ, thời gian phản hồi/khắc phục theo SEV, người trực, cách leo thang. → Kiểm: `RUNBOOK.md` mục "Hỗ trợ & liên hệ" đủ cột; cảnh báo thử gửi tới đúng kênh (bằng chứng ở G8).
- [ ] `PM-HANDOVER-008` **MUST@L** Bus factor ≥ 2 cho mỗi thành phần sống còn (code, hạ tầng, dữ liệu, tài khoản gốc) trước G7. → Kiểm: bảng "Thành phần → người biết" ≥2 tên mỗi dòng; tài khoản gốc có ≥2 người có quyền khôi phục (không dùng chung mật khẩu).
- [ ] `PM-HANDOVER-009` **MUST@M** Danh sách phụ thuộc có hạn (domain, chứng chỉ, license, gói SaaS, khoá API, thẻ thanh toán) kèm ngày hết hạn, chủ gia hạn, nhắc trước hạn. → Kiểm: `docs/handover/renewals.md`; cảnh báo lịch/CI trước hạn ≥ 30 ngày; chứng chỉ TLS tự động gia hạn có bằng chứng.
- [ ] `PM-HANDOVER-010` **SHOULD** Đào tạo người nhận: buổi hướng dẫn có ghi hình/ghi chú, FAQ từ câu hỏi thật, bài tập thực hành (deploy thử lên staging, xử lý một cảnh báo giả). → Kiểm: `docs/handover/training.md` + bằng chứng người nhận hoàn thành bài tập.
- [ ] `PM-HANDOVER-011` **SHOULD** Báo cáo tiến độ cho các bên theo nhịp cố định (tuần/mốc), ngắn, cùng một mẫu: đã xong (bằng chứng) · tiếp theo · rủi ro · cần quyết định. → Kiểm: `docs/status/` hoặc kênh có ≥1 báo cáo mỗi nhịp; mục "cần quyết định" được trả lời có ngày.
- [ ] `PM-HANDOVER-012` **SHOULD** Tài liệu người dùng cuối (hướng dẫn, FAQ, trang trạng thái/kênh báo lỗi) sẵn trước ra mắt; release notes cho người dùng theo [`../templates/RELEASE-NOTES.md`](../templates/RELEASE-NOTES.md). → Kiểm: link tài liệu trong app/README; `CHANGELOG.md`/release notes có bản cho người dùng.
- [ ] `PM-HANDOVER-013` **SHOULD** Checklist đóng dự án: thu hồi quyền, tắt/huỷ tài nguyên có phí, xuất và lưu/xoá dữ liệu theo thời hạn luật, chuyển domain/IP, archive repo với README ghi trạng thái, thông báo người dùng. → Kiểm: `docs/handover/closure.md` tick đủ với bằng chứng (hoá đơn cuối, ảnh tài nguyên đã tắt, thông báo đã gửi).
- [ ] `PM-HANDOVER-014` **SHOULD** Retrospective cuối dự án/bàn giao: 3 điều giữ, 3 điều đổi, hành động có chủ + hạn; hàng rào mới đưa vào khung/CLAUDE.md/TRAPS. → Kiểm: `docs/retro-<ngày>.md`; ≥1 hành động thành PR/issue.
- [ ] `PM-HANDOVER-015` **SHOULD** Lịch "đi kèm" sau bàn giao có thời hạn (vd 2 tuần) và quy tắc: người cũ trả lời, người mới thao tác; hết hạn thì cắt quyền người cũ. → Kiểm: ngày kết thúc đi kèm ghi trong `docs/handover/`; offboarding sau ngày đó.
- [ ] `PM-HANDOVER-016` **MAY** Sơ đồ kiến trúc C4 mức 1–2 và sơ đồ luồng dữ liệu cập nhật ở lần bàn giao (dùng lại từ threat model). → Kiểm: `docs/architecture/` có ngày cập nhật ≥ ngày bàn giao.
- [ ] `PM-HANDOVER-017` **MAY** "Ngày không có người cũ" diễn tập trước bàn giao thật: người nhận vận hành một ngày, người cũ không trả lời; ghi lại lỗ hổng. → Kiểm: ghi chú diễn tập + sửa tài liệu sau đó.

## Bẫy thường gặp

| Bẫy | Dấu hiệu | Cách tránh |
|---|---|---|
| Bàn giao bằng buổi họp | Hai tuần sau không ai deploy được | Người nhận tự chạy runbook; chỗ vấp là lỗi tài liệu (`PM-HANDOVER-003`) |
| Secret qua chat | Mật khẩu root trong tin nhắn, không xoay | Chuyển ownership + xoay; `gitleaks` cả lịch sử |
| Tài khoản gốc gắn với một cá nhân | Email cá nhân sở hữu domain/cloud/store | Tài khoản tổ chức, ≥2 người có quyền khôi phục |
| Người rời vẫn còn quyền | Token cũ còn chạy CI | Offboarding trong ngày, danh sách dịch vụ đầy đủ |
| "Hỗ trợ khi cần" | Không ai biết gọi ai lúc 2h sáng | Mức hỗ trợ bằng số, cảnh báo thử gửi thật |
| Đóng dự án bằng im lặng | Tài nguyên vẫn tính tiền, dữ liệu cá nhân vẫn nằm đó | Checklist đóng với bằng chứng; thời hạn lưu/xoá theo luật |
| Nghiệm thu bằng cảm giác | "Trông ổn", "framework lo rồi" | "Evidence or FAIL": mỗi mục có bằng chứng, con người ký (catalog 09 §1.5) |
| Người cũ làm hộ mãi | Người mới không bao giờ tự vận hành | Lịch đi kèm có hạn, quy tắc "chỉ trả lời" |
| Hạn gia hạn bị quên | Domain hết hạn, chứng chỉ hết hạn | Bảng renewals + nhắc trước ≥30 ngày |
| Tài liệu bàn giao là bản chụp lúc viết | README nói lệnh cũ, CI đã đổi | Job "clean clone build" hằng tuần; runbook cập nhật khi cảnh báo nổ (SRE Workbook ch. 8) |
| Nhiều người quyết, không ai quyết | Phát hành chờ "mọi người đồng ý" | Bản đồ các bên: một tên ở cột "quyết định cuối" cho mỗi loại quyết định |

## Cổng tự động

| Việc | Công cụ / lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| Build từ clone sạch | CI job clone mới + `make setup && make test` (hoặc lệnh tương đương stack) | CI hằng tuần | Xanh |
| Tài liệu bàn giao tồn tại | `test -f README.md -a -f RUNBOOK.md -a -d docs/adr -a -f PROGRESS.md` | CI | Thiếu → đỏ tại G7 |
| Không secret trong repo/lịch sử | `gitleaks detect --redact` (MIT) | pre-commit + CI | 0 phát hiện |
| Quyền thành viên khớp danh sách | `gh api orgs/<org>/members --jq '.[].login'` so với `docs/STAKEHOLDERS.md` | CI hằng tuần | Người ngoài danh sách → issue |
| Hạn gia hạn | Script đọc `docs/handover/renewals.md`, cảnh báo ≤ 30 ngày; chứng chỉ: `openssl s_client … \| openssl x509 -enddate` | CI hằng ngày | Mở issue |
| Link trong tài liệu bàn giao còn sống | `lychee README.md RUNBOOK.md docs/` (MIT/Apache-2.0) | CI hằng tuần | 0 link hỏng |
| GO/NO-GO không còn BLOCKER | `rg -n "BLOCKER.*FAIL" docs/GO-NO-GO-*.md` | CI trước release | 0 kết quả |

## Nguồn

- Google SRE Workbook ch. 8 "On-Call" — playbook: mục đích, nội dung, cập nhật khi cảnh báo nổ: <https://sre.google/workbook/on-call/> — xác minh 2026-10-13.
- Google SRE Book ch. 15 "Postmortem Culture: Learning from Failure" (retro không đổ lỗi, hành động có chủ): <https://sre.google/sre-book/postmortem-culture/> — xác minh 2026-10-13.
- NIST SP 800-61 Rev. 3 (04/2025) — ứng phó sự cố trong quản lý rủi ro, thay Rev. 2: <https://csrc.nist.gov/pubs/sp/800/61/r3/final> — xác minh 2026-10-13.
- "Evidence or it's a FAIL", GO/NO-GO, con người ký cuối — `seeker19110/stored` mục 09 §1.5 (PinoyFreeCoder/deployment-checklist `agent.md`), đọc 2026-10-13.
- Khung cũ X-stored `01-process-and-standards.md` GĐ7–GĐ8, `docs/ops/incident-response.md`, commit `1b80fe4`; `research/2026-10-13-old-framework-analysis.md` (CODEOWNERS/LICENSE hard-code một cá nhân — ví dụ bẫy tài khoản gắn cá nhân).
