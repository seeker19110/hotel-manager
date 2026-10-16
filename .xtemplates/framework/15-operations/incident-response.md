---
title: Ứng phó sự cố: SEV, runbook, liên lạc, post-mortem không đổ lỗi
kind: module
prefix: OPS-IR
applies_to: [all]
updated: 2026-10-15
---

# Ứng phó sự cố: SEV, runbook, liên lạc, post-mortem không đổ lỗi

> **Nhà** của quy trình sự cố: phân mức SEV1–4, vai trò, liên lạc, dòng thời gian, **giảm thiệt hại trước – tìm nguyên nhân sau**,
> post-mortem không đổ lỗi trong ≤ 5 ngày và **mỗi sự cố ≥ 1 hàng rào mới** (P12). Sự cố bảo mật dùng cùng quy trình với phần
> bảo toàn chứng cứ ở [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md). Mẫu:
> [`../templates/POST-MORTEM.md`](../templates/POST-MORTEM.md), [`../templates/RUNBOOK.md`](../templates/RUNBOOK.md).

## Nguyên tắc

- **Giảm thiệt hại trước, tìm nguyên nhân sau**: rollback, tắt flag, chuyển traffic, khôi phục backup — rồi mới debug. Khôi phục dịch vụ ≠ sửa triệt để.
- **An toàn trước tốc độ**: thao tác lên dữ liệu thật lúc chữa cháy phải có đường lùi (snapshot trước); không chạy lệnh phá huỷ khi chưa chắc.
- **Một người điều phối (Incident Commander)** ngay cả khi đội 2 người; IC không tự tay sửa mà điều phối, quyết định, liên lạc.
- **Mọi thay đổi lúc chữa cháy được ghi lại** (kênh sự cố, lệnh đã chạy, giờ UTC) để tái dựng dòng thời gian và hoàn tác sửa tay.
- **Không đổ lỗi**: giả định mọi người hành động hợp lý với thông tin có lúc đó; post-mortem sửa hệ thống/quy trình, không sửa người.
- **Học một lần** (P12): hành động khắc phục có người, hạn, ticket; ít nhất một hàng rào máy (test, alert, lint, hook, policy) để cùng nguyên nhân không tái diễn.
- **Kill switch ≤ 10 giây** cho hệ có agent/tự động: dừng run · phiên bản · toàn hệ, thu hồi token (xem [`../12-security/ai-security.md`](../12-security/ai-security.md)).

## Quyết định

| Mức | Nghĩa | Ví dụ | Phản ứng | Post-mortem |
|---|---|---|---|---|
| **SEV1** | Sập toàn bộ / mất hoặc lộ dữ liệu / mất tiền / xâm nhập xác nhận | site down, rò rỉ dữ liệu, thanh toán sai hàng loạt, agent chạy hoang | Ngay lập tức 24/7; IC + kênh sự cố mở ≤ 5 phút; status page ≤ 15 phút; lãnh đạo được báo | Bắt buộc, ≤ 5 ngày làm việc |
| **SEV2** | Luồng chính suy giảm nặng hoặc một nhóm lớn người dùng không dùng được | login lỗi 30%, chậm gấp 5, một vùng down | Trong giờ làm ưu tiên tuyệt đối; ngoài giờ nếu có on-call | Bắt buộc, ≤ 5 ngày |
| **SEV3** | Ảnh hưởng nhỏ, có cách lách | lỗi ngoài luồng chính, báo cáo sai | Lên lịch trong tuần | Tuỳ chọn (nếu lặp ≥ 2 → bắt buộc) |
| **SEV4** | Không ảnh hưởng người dùng, nợ vận hành | alert nhiễu, disk 80% | Ticket thường | Không |

| Hành động giảm thiệt hại | Dùng khi | Điều kiện sẵn sàng (phải có trước sự cố) |
|---|---|---|
| Rollback bản deploy trước | Sự cố xuất hiện ngay sau deploy | Rollback < 15 phút đã diễn tập ([`deployment-strategies.md`](deployment-strategies.md)) |
| Tắt feature flag | Tính năng mới gây lỗi | Flag có kill switch, không cần deploy |
| Chuyển traffic/scale | Quá tải, một vùng/nút hỏng | Multi-instance, LB health check |
| Khôi phục backup/PITR | Dữ liệu mất/hỏng | Backup đã thử khôi phục ([`backup-and-disaster-recovery.md`](backup-and-disaster-recovery.md)) |
| Kill switch agent | Agent/tự động hành xử sai | Kill switch ba mức ≤ 10 s |
| Thu hồi/xoay bí mật | Nghi lộ khoá | Runbook xoay cho từng loại khoá |
| Chặn IP/WAF rule/tắt endpoint | Tấn công/lạm dụng | WAF + rate limit cấu hình trong IaC |

## Checklist

- [ ] `OPS-IR-001` **MUST** Có `docs/ops/INCIDENT-RESPONSE.md` (hoặc mục trong RUNBOOK) định nghĩa SEV1–4 với ví dụ cụ thể của dự án, thời gian phản ứng, và ai được tuyên bố sự cố. → Kiểm: file tồn tại; mỗi SEV có ≥ 2 ví dụ; được nhắc trong onboarding. · Nguồn: NIST SP 800-61r3; PagerDuty Incident Response
- [ ] `OPS-IR-002` **MUST@L** Mỗi sự cố mở một bản ghi (issue template `incident`/kênh riêng) ghi: thời điểm phát hiện, triệu chứng, mức SEV, IC, dòng thời gian UTC được cập nhật liên tục. → Kiểm: template issue có các trường; sự cố gần nhất có timeline ≥ 5 mốc (phát hiện, SEV, giảm thiệt hại, khôi phục, đóng). · Nguồn: PagerDuty IR (Scribe); SRE Book
- [ ] `OPS-IR-003` **MUST@L** Vai trò rõ: Incident Commander (điều phối, quyết định), người xử lý kỹ thuật (SME), người liên lạc (khách/nội bộ), người ghi chép; đội nhỏ gộp vai nhưng IC luôn tách biệt với người gõ lệnh khi ≥ 2 người. → Kiểm: bản ghi sự cố có tên IC; checklist IC trong runbook. · Nguồn: PagerDuty IR — different roles
- [ ] `OPS-IR-004` **MUST** Thứ tự xử lý cố định: phát hiện → phân mức → **giảm thiệt hại** (rollback/flag/khôi phục/kill switch) → liên lạc → khắc phục triệt để qua cổng thường → đóng → post-mortem. → Kiểm: runbook liệt kê thứ tự; timeline sự cố gần nhất có mốc "giảm thiệt hại" trước mốc "root cause". · Nguồn: khung cũ `docs/ops/incident-response.md` (1b80fe4); NIST SP 800-61r3
- [ ] `OPS-IR-005` **MUST@L** Mọi lệnh/thay đổi tay lúc chữa cháy ghi vào kênh sự cố (lệnh + giờ + người); sau sự cố đưa về IaC/code hoặc hoàn tác. → Kiểm: timeline có lệnh đã chạy; drift job IaC = 0 sau khi đóng sự cố. · Nguồn: P8; [`infrastructure-as-code.md`](infrastructure-as-code.md)
- [ ] `OPS-IR-006` **MUST** Thao tác lên dữ liệu thật lúc sự cố có snapshot/backup ngay trước đó và lệnh hoàn tác đã viết sẵn; thao tác không thể hoàn tác cần hai người xác nhận. → Kiểm: runbook mục "Trước khi chạy lệnh lên dữ liệu"; timeline ghi snapshot id. · Nguồn: AGENTS.md §5 (điểm dừng bắt buộc về hành động); P3
- [ ] `OPS-IR-007` **MUST@L** Post-mortem **không đổ lỗi** cho mọi SEV1/SEV2 trong ≤ 5 ngày làm việc theo mẫu khung: tóm tắt, ảnh hưởng, timeline, nguyên nhân (5 whys), tốt/chưa tốt/may mắn, hành động. → Kiểm: file `docs/ops/postmortems/YYYY-MM-DD-<slug>.md` tồn tại ≤ 5 ngày sau đóng sự cố (script so ngày); không có tên người ở mục nguyên nhân. · Nguồn: SRE Book — Postmortem Culture; khung cũ post-mortem template
- [ ] `OPS-IR-008` **MUST@L** Mỗi post-mortem có ≥ 1 hành động là **hàng rào máy** (test hồi quy, alert, lint/policy, hook, cổng CI) kèm người phụ trách + hạn + ticket; hành động quá hạn hiện trong review tháng. → Kiểm: bảng hành động có cột Loại = `phòng ngừa|phát hiện` ≥ 1 hàng trỏ PR/rule; script liệt kê hành động quá hạn. · Nguồn: P12; khung cũ "mỗi sự cố ≥ 1 cải tiến"
- [ ] `OPS-IR-009` **MUST@L** Liên lạc: SEV1/2 cập nhật status page/kênh người dùng ≤ 15 phút sau xác nhận và mỗi 30–60 phút cho đến khi khôi phục; nội dung nói tác động + bước tiếp theo, không hứa thời gian không chắc. → Kiểm: timeline có mốc liên lạc; mẫu thông báo trong runbook. · Nguồn: PagerDuty IR — customer liaison
- [ ] `OPS-IR-010` **MUST** Sự cố bảo mật (lộ dữ liệu/secret, xâm nhập) = SEV1, kích hoạt thêm: bảo toàn chứng cứ, thu hồi/xoay bí mật, đánh giá nghĩa vụ thông báo (xem [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md), [`../16-compliance-privacy/international-privacy.md`](../16-compliance-privacy/international-privacy.md)). → Kiểm: runbook có nhánh "sự cố bảo mật" với checklist 3 mục trên và đầu mối pháp lý. · Nguồn: NIST SP 800-61r3; [`../12-security/logging-audit-and-incident.md`](../12-security/logging-audit-and-incident.md)
- [ ] `OPS-IR-011` **MUST@L** Runbook cho mỗi alert page và mỗi phụ thuộc chính (DB, queue, cache, nhà cung cấp): triệu chứng, lệnh chẩn đoán, hành động giảm thiệt hại, cách hoàn tác, liên hệ; runbook được thử ít nhất 1 lần. → Kiểm: `docs/ops/runbooks/` theo mẫu; mỗi alert `runbook_url` trỏ file có thật; ngày thử trong file. · Nguồn: [`../templates/RUNBOOK.md`](../templates/RUNBOOK.md); SRE Book
- [ ] `OPS-IR-012` **MUST@L** Diễn tập sự cố (game day/tabletop) ≥ 2 lần/năm gồm một kịch bản bảo mật và một kịch bản mất dữ liệu; đo thời gian phát hiện/giảm thiệt hại; kết quả thành hành động. → Kiểm: biên bản diễn tập với thời gian đo; hành động có ticket. · Nguồn: SRE Book (disaster role-playing); NIST SP 800-61r3
- [ ] `OPS-IR-013` **MUST@L** Đo và theo dõi: thời gian phát hiện (TTD), thời gian giảm thiệt hại (TTM), thời gian khôi phục (failed deployment recovery time), số sự cố theo SEV/tháng, % post-mortem đúng hạn, % hành động đóng đúng hạn. → Kiểm: báo cáo tháng sinh từ bản ghi sự cố (script/dashboard). · Nguồn: DORA (failed deployment recovery time); SRE Workbook
- [ ] `OPS-IR-014` **MUST@L** Sự cố liên quan nhà cung cấp/đối tác có đầu mối liên hệ, SLA hỗ trợ, và kịch bản khi nhà cung cấp down (degrade mode) viết sẵn. → Kiểm: bảng nhà cung cấp ↔ liên hệ ↔ kịch bản trong runbook. · Nguồn: NIST SP 800-34r1 (phụ thuộc bên ngoài)
- [ ] `OPS-IR-015` **MUST@L** Cơ chế tuyên bố và leo thang: ai tuyên bố SEV1, báo lãnh đạo trong bao lâu, khi nào gọi pháp lý/PR; danh sách liên hệ được kiểm 1 lần/quý. → Kiểm: bảng leo thang + ngày kiểm liên hệ. · Nguồn: PagerDuty IR
- [ ] `OPS-IR-016` **SHOULD** Hệ có agent/tự động: sự cố "agent hành xử sai" là loại riêng với bước đầu = kill switch + đóng băng phiên bản agent + giữ transcript/audit làm chứng cứ. → Kiểm: runbook mục "Agent"; diễn tập kill switch ≤ 10 s (ghi ngày). · Nguồn: [`../12-security/ai-security.md`](../12-security/ai-security.md); khung cũ spec C5-FR-09
- [ ] `OPS-IR-017` **SHOULD** Post-mortem được chia sẻ cho cả đội/công ty (không chỉ người liên quan) và lưu chỉ mục; lỗi lần thứ ba cùng nguyên nhân → leo thang kiến trúc (ADR). → Kiểm: chỉ mục `docs/ops/postmortems/README.md`; tag nguyên nhân để đếm lặp. · Nguồn: SRE Book — Postmortem Culture; catalog stored 23 §2.6 ("lỗi lần thứ ba")
- [ ] `OPS-IR-018` **SHOULD** Sự cố SEV3 lặp ≥ 2 lần trong quý → nâng SEV2 cho post-mortem bắt buộc. → Kiểm: review tháng đếm lặp theo tag. · Nguồn: P12
- [ ] `OPS-IR-019` **SHOULD** Có "bộ dụng cụ sự cố": lệnh truy cập khẩn (break-glass có log), dashboard sự cố, mẫu thông báo, danh sách lệnh chẩn đoán phổ biến — kiểm 1 lần/quý còn chạy. → Kiểm: `docs/ops/incident-kit.md` + ngày kiểm. · Nguồn: PagerDuty IR
- [ ] `OPS-IR-020` **MAY** Tự động mở kênh sự cố + bản ghi khi alert SEV1 nổ (ChatOps) và tự tổng hợp timeline từ log/alert. → Kiểm: bot cấu hình; test tạo sự cố giả. · Nguồn: PagerDuty IR (tooling)
- [ ] `OPS-IR-021` **MAY** Post-mortem tích hợp với threat model/SLO: cập nhật threat model nếu sự cố bảo mật không được dự đoán; điều chỉnh SLO nếu lặp. → Kiểm: post-mortem có mục "Threat model/SLO đã dự đoán?". · Nguồn: [`../12-security/threat-modeling.md`](../12-security/threat-modeling.md)

## Bẫy thường gặp

1. **Debug nguyên nhân trong khi dịch vụ còn down** → kéo dài thiệt hại. Rollback/flag trước, root cause sau (`OPS-IR-004`).
2. **Sửa tay lên production rồi quên** → drift, sự cố lặp sau deploy kế tiếp. Tránh: `OPS-IR-005` + drift job.
3. **Chạy lệnh "sửa dữ liệu" không snapshot** lúc 2 giờ sáng → mất dữ liệu thật, không hoàn tác. Tránh: `OPS-IR-006`.
4. **Post-mortem có tên người ở mục nguyên nhân** ("do X deploy sai") → lần sau mọi người giấu sự cố. Tránh: blameless, sửa quy trình (`OPS-IR-007`).
5. **Hành động khắc phục là "cẩn thận hơn"** → không kiểm được, không ngăn lặp. Tránh: hàng rào máy (`OPS-IR-008`).
6. **Không có IC** → 5 người cùng sửa, giẫm chân, không ai liên lạc với khách. Tránh: `OPS-IR-003`.
7. **Status page cập nhật khi đã xong** hoặc hứa "15 phút nữa" nhiều lần. Tránh: cập nhật sớm, nói tác động, không hứa thời gian.
8. **Sự cố bảo mật xử lý như sự cố thường**: xoá log để "dọn", không xoay khoá, không đánh giá nghĩa vụ thông báo. Tránh: `OPS-IR-010`.
9. **Runbook chưa bao giờ chạy thử** → lệnh sai, link chết, quyền thiếu lúc cần. Tránh: `OPS-IR-011/012`.
10. **Agent tự động không có kill switch** → "sự cố" kéo dài vì không ai dừng được nó. Tránh: `OPS-IR-016`.

## Cổng tự động

| Việc | Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Template sự cố | issue template `incident.md` với trường bắt buộc | CI kiểm template tồn tại | repo | thiếu = đỏ |
| Post-mortem đúng hạn | script so ngày đóng sự cố (label `sev1`/`sev2`) với file post-mortem | lịch hàng ngày | CI `schedule` | > 5 ngày làm việc = cảnh báo |
| Hành động có hàng rào máy | script đọc bảng hành động post-mortem | ≥ 1 hàng loại `phòng ngừa|phát hiện` trỏ PR/rule | CI khi merge post-mortem | thiếu = đỏ |
| Hành động quá hạn | script đọc ticket | hàng tháng | lịch | liệt kê |
| Runbook ↔ alert | script | mọi `runbook_url` trỏ file/URL tồn tại | CI | hỏng = đỏ |
| Drift sau sự cố | IaC `plan -detailed-exitcode` | sau đóng sự cố | CI | exit 2 = ticket |
| Kill switch | diễn tập staging | ≤ 10 s | hàng quý | quá = NO-GO |
| Chỉ số IR | script tổng hợp TTD/TTM/recovery time | hàng tháng | lịch | báo cáo |

## Nguồn

- NIST SP 800-61 Rev. 3 — Incident Response Recommendations and Considerations for Cybersecurity Risk Management (CSF 2.0 Community Profile, 04/2025): <https://csrc.nist.gov/pubs/sp/800/61/r3/final> — xác minh 2026-10-13.
- Google SRE Book — Postmortem Culture: Learning from Failure (blameless; trigger: downtime, mất dữ liệu, can thiệp on-call, thời gian khắc phục vượt ngưỡng, monitoring hỏng): <https://sre.google/sre-book/postmortem-culture/> — xác minh 2026-10-13.
- PagerDuty Incident Response — Different Roles (IC, Deputy, Scribe, SME, Customer/Internal Liaison): <https://response.pagerduty.com/before/different_roles/> — xác minh 2026-10-13 (license tài liệu: xem repo `pagerduty/incident-response-docs`, chưa xác minh).
- DORA — failed deployment recovery time, change fail rate: <https://dora.dev/guides/dora-metrics-four-keys/> — xác minh 2026-10-13.
- NIST SP 800-34 Rev. 1 Contingency Planning Guide (11/2010): <https://csrc.nist.gov/pubs/sp/800/34/r1/upd1/final> — xác minh 2026-10-13.
- Khung cũ X-stored `docs/ops/incident-response.md` (SEV, 7 bước, mẫu post-mortem, "mỗi sự cố ≥ 1 cải tiến"), commit `1b80fe4` — tận dụng và mở rộng.
- Khung cũ `docs/specs/AI-HARNESS-AND-COMPANY-SPEC.md` §A4.5 C5-FR-09 (kill switch ≤ 10 s), commit `1b80fe4`; catalog `seeker19110/stored` 23 §2.6 (lỗi lần thứ ba), đọc 2026-10-13.
