---
title: Sao lưu & DR: RPO/RTO, diễn tập khôi phục, multi-region
kind: module
prefix: OPS-DR
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, mobile-app, desktop-app, embedded-iot]
updated: 2026-10-14
---

# Sao lưu & DR: RPO/RTO, diễn tập khôi phục, multi-region

> Khôi phục thảm hoạ ở mức **hệ thống**: RPO/RTO cấp dịch vụ theo quy mô, 3-2-1 cho mọi dữ liệu **ngoài CSDL** (object storage,
> bí mật/khoá, cấu hình, state IaC, bộ nhớ agent), thứ tự khôi phục dịch vụ, runbook DR, đa vùng và **diễn tập toàn hệ thống có bằng
> chứng**. Backup **tầng CSDL** (PITR/WAL, pgBackRest/WAL-G, diễn tập restore CSDL, RPO/RTO từng kho) là nhà của
> [`../09-database/backup-and-recovery.md`](../09-database/backup-and-recovery.md) (`DB-BACKUP-*`) — ở đây chỉ trỏ, không lặp;
> dựng lại hạ tầng từ code ở [`infrastructure-as-code.md`](infrastructure-as-code.md).

## Nguyên tắc

- **Backup là để khôi phục**: chỉ số duy nhất có nghĩa là "khôi phục được trong RTO với mất mát ≤ RPO", đo bằng diễn tập, không bằng log "backup success".
- **3-2-1**: 3 bản (1 chính + 2 sao lưu), 2 loại phương tiện/hệ thống khác nhau, 1 bản offsite (vùng/tài khoản/nhà cung cấp khác).
- **Tách tài khoản và quyền**: bản sao lưu nằm trong tài khoản/dự án khác với production, quyền xoá tách khỏi quyền ghi; bất biến (Object Lock/WORM) để ransomware hoặc lệnh `rm` sai không xoá được.
- **RPO/RTO là quyết định sản phẩm**, ghi ở PROJECT.md/ADR theo quy mô; chi phí DR tăng phi tuyến khi RPO → 0 nên chọn có chủ.
- **Mọi thứ cần khôi phục đều trong phạm vi**: CSDL, object storage, bí mật/khoá, cấu hình, hàng đợi, bộ nhớ agent, state IaC, chứng chỉ — không chỉ DB.
- **Khôi phục cũng là code**: runbook khôi phục có lệnh cụ thể, chạy được bởi người không phải tác giả, tự động hoá tới mức có thể.

## Quyết định

| Quy mô | RPO mặc định | RTO mặc định | Cơ chế tối thiểu | Diễn tập |
|---|---|---|---|---|
| **S** (thử nghiệm, dữ liệu không thật) | 24 giờ | 1 ngày làm việc | Snapshot/dump hằng ngày, giữ 7 ngày, offsite 1 bản | 1 lần trước khi lên M |
| **M** (production có người dùng) | ≤ 1 giờ (PITR) | ≤ 4 giờ | PITR (WAL/binlog archive) + snapshot ngày + 3-2-1 + bất biến ≥ 30 ngày | Hàng quý, có bằng chứng |
| **L** (lớn, ngành quản lý) | ≤ 5 phút | ≤ 1 giờ (một vùng) / ≤ 4 giờ (mất vùng) | Replica đồng bộ/async đa vùng + PITR + backup đa tài khoản + DR site | Hàng quý + diễn tập mất vùng hàng năm |

| Tình huống | Lựa chọn | Điều kiện |
|---|---|---|
| CSDL (managed hoặc tự host) | Theo `DB-BACKUP-*` ở [`../09-database/backup-and-recovery.md`](../09-database/backup-and-recovery.md); DR cấp hệ thống chỉ yêu cầu bản sao CSDL nằm ở tài khoản/vùng DR và có trong thứ tự khôi phục | Không lặp cấu hình PITR ở đây |
| Object storage | Versioning + replication sang bucket khác vùng/tài khoản + Object Lock | Dữ liệu người dùng (upload) thường bị quên |
| SQLite/edge | Litestream/ snapshot định kỳ sang object storage | Ứng dụng desktop/CLI/IoT: hướng dẫn người dùng export + kiểm tra toàn vẹn |
| Multi-region | Chỉ khi L hoặc SLA yêu cầu; active-passive trước active-active | Active-active cần xử lý xung đột dữ liệu — ADR bắt buộc |
| Công cụ file/VM | restic (BSD-2) / Velero (K8s, Apache-2.0) / snapshot cloud | Mã hoá client-side với khoá trong KMS |

## Checklist

- [ ] `OPS-DR-001` **MUST@L** RPO/RTO **cấp dịch vụ hướng người dùng** (toàn hệ thống, không chỉ từng kho) được chốt theo quy mô trong `PROJECT.md`/ADR, là tổng hợp của RPO/RTO từng kho (`DB-BACKUP-001`) cộng thời gian dựng hạ tầng + xoay bí mật + xác minh. → Kiểm: `docs/ops/RPO-RTO.md` có hàng "dịch vụ" với RTO ≥ max(RTO kho) + thời gian dựng IaC đo từ drill. · Nguồn: NIST SP 800-34r1 (BIA cấp hệ thống)
- [ ] `OPS-DR-002` **MUST@L** Danh sách phạm vi DR liệt kê **mọi** thứ cần khôi phục ngoài CSDL — object storage, queue bền, bộ nhớ agent/vector store, state IaC, bí mật/khoá, chứng chỉ, cấu hình DNS/CDN — mỗi mục có cơ chế sao lưu tự động ↔ lịch ↔ retention; CSDL chỉ trỏ `DB-BACKUP-002`. → Kiểm: `docs/ops/BACKUP-SCOPE.md`; script đối chiếu tài nguyên dữ liệu trong state IaC với bảng, thiếu = đỏ. · Nguồn: NIST SP 800-34r1; CISA 3-2-1
- [ ] `OPS-DR-003` **MUST** Áp 3-2-1: ≥ 2 bản sao lưu, 2 hệ thống khác nhau, ≥ 1 bản ở vùng/tài khoản/nhà cung cấp khác production. → Kiểm: cấu hình replication/export sang bucket ở account id khác (IaC); liệt kê trong BACKUP-SCOPE. · Nguồn: CISA/CERT "Data Backup Options" (3-2-1)
- [ ] `OPS-DR-004` **MUST** Backup mã hoá at-rest và in-transit; khoá mã hoá backup được sao lưu riêng (KMS multi-region/escrow) — mất khoá = mất backup. → Kiểm: cấu hình mã hoá bucket/backup; khoá KMS có bản sao/escrow ghi trong runbook; test giải mã từ tài khoản DR. · Nguồn: NIST SP 800-34r1; [`../12-security/secrets-management.md`](../12-security/secrets-management.md)
- [ ] `OPS-DR-005` **MUST@L** **Diễn tập DR toàn hệ thống** (không chỉ restore CSDL — `DB-BACKUP-003/006`): dựng hạ tầng từ IaC trên tài khoản/vùng sạch → khôi phục CSDL + object storage + bí mật → chạy smoke test luồng chính → đo RTO/RPO thực; trước production và theo lịch (M: hàng năm; L: hàng quý). → Kiểm: `docs/ops/dr-drills.md` có ngày, người, RTO/RPO đo được, lỗi gặp, hành động; GO/NO-GO trỏ drill gần nhất. · Nguồn: lifecycle G8; catalog stored 09 §1.3; NIST SP 800-34r1 (test/exercise)
- [ ] `OPS-DR-006` **MUST@L** Giám sát sao lưu của các kho ngoài CSDL (object storage replication, export bí mật, state IaC, agent memory): job thất bại hoặc **không chạy** (absent) → alert; kiểm toàn vẹn (checksum/`restic check`) sau mỗi lần. → Kiểm: alert `backup_last_success_age{store} > RPO` cho từng mục trong BACKUP-SCOPE; diễn tập tắt job → alert nổ. · Nguồn: [`slo-and-alerting.md`](slo-and-alerting.md); CSDL xem `DB-BACKUP-002/013`
- [ ] `OPS-DR-007` **MUST** Quyền xoá backup tách khỏi quyền ghi của ứng dụng và admin thường; identity production không xoá được bản offsite. → Kiểm: IAM policy: app/CI chỉ `PutObject`; xoá cần vai trò riêng có MFA; test xoá bằng identity app → bị từ chối. · Nguồn: CIS Benchmark cloud; NIST SP 800-207
- [ ] `OPS-DR-008` **MUST** Runbook khôi phục có lệnh cụ thể cho từng kho (restore DB tới thời điểm T, khôi phục bucket, dựng lại hạ tầng từ IaC, xoay bí mật), kèm thứ tự phụ thuộc và cách xác minh; người không phải tác giả chạy được trong diễn tập. → Kiểm: `docs/ops/runbooks/restore-*.md`; diễn tập do người khác tác giả thực hiện (ghi tên). · Nguồn: NIST SP 800-34r1; [`../templates/RUNBOOK.md`](../templates/RUNBOOK.md)
- [ ] `OPS-DR-009` **MUST@L** **Thứ tự khôi phục dịch vụ** viết sẵn theo phụ thuộc (mạng/IAM → bí mật/KMS → CSDL → object storage → queue → ứng dụng → DNS/CDN) với điểm kiểm sau mỗi bước và tiêu chí "đã khôi phục" cho từng dịch vụ; drill tuân thứ tự này. → Kiểm: `docs/ops/runbooks/dr-order.md`; drill log ghi mốc thời gian từng bước. · Nguồn: NIST SP 800-34r1 (recovery sequence/priorities)
- [ ] `OPS-DR-010` **MUST@L** Bản sao lưu ngoài CSDL (object storage, export bí mật/cấu hình, state IaC) **bất biến** (Object Lock/WORM hoặc tài khoản chỉ ghi) với thời gian giữ ≥ 30 ngày chống ransomware/xoá nhầm; CSDL theo `DB-BACKUP-007`. → Kiểm: cấu hình Object Lock trong IaC cho bucket DR; test xoá trước hạn → bị từ chối. · Nguồn: CISA ransomware guidance (chưa fetch lại 2026-10-13); NIST SP 800-34r1
- [ ] `OPS-DR-011` **MUST@L** Khôi phục được **toàn bộ môi trường** (hạ tầng từ IaC + dữ liệu từ backup + bí mật) trên tài khoản/vùng khác trong RTO; diễn tập ≥ 1 lần/năm. → Kiểm: drill "mất tài khoản/vùng" có thời gian đo ≤ RTO. · Nguồn: NIST SP 800-34r1; [`infrastructure-as-code.md`](infrastructure-as-code.md)
- [ ] `OPS-DR-012` **MUST@L** Dữ liệu người dùng tải lên (object storage) có versioning + replication; xoá mềm với thời gian khôi phục (vd 30 ngày) trước khi xoá cứng, trừ yêu cầu xoá theo luật. → Kiểm: bucket versioning + lifecycle; test xoá rồi khôi phục file. · Nguồn: [`../08-backend/files-and-media.md`](../08-backend/files-and-media.md); [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md)
- [ ] `OPS-DR-013` **MUST@L** Multi-region: replica ở vùng thứ hai với RPO ≤ 5 phút, failover có runbook và diễn tập hàng năm; DNS/traffic chuyển được trong RTO; xung đột dữ liệu (nếu active-active) có ADR. → Kiểm: drill failover vùng với thời gian; ADR multi-region. · Nguồn: NIST SP 800-34r1 (alternate site)
- [ ] `OPS-DR-014` **MUST@L** Backup/bản sao chịu ràng buộc lưu trú dữ liệu (data residency) theo luật áp dụng; vùng offsite được chọn có chủ đích và ghi ở 16. → Kiểm: vùng bucket DR trong IaC khớp bảng pháp lý. · Nguồn: [`../16-compliance-privacy/vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md)
- [ ] `OPS-DR-015` **SHOULD** Kịch bản DR theo loại thảm hoạ — mất một vùng, mất tài khoản cloud/bị khoá, ransomware/xoá hàng loạt, mất nhà cung cấp SaaS chính (auth, email, thanh toán) — mỗi kịch bản có mức ưu tiên dịch vụ (cái gì lên trước, cái gì chấp nhận degrade) và người ra quyết định. → Kiểm: `docs/ops/DR-PLAN.md` có ≥ 4 kịch bản; tabletop ≥ 1 kịch bản/năm (xem `OPS-IR-012`). · Nguồn: NIST SP 800-34r1 (contingency scenarios)
- [ ] `OPS-DR-016` **SHOULD** Retention backup theo bảng có lý do (vận hành 30 ngày, tháng 12 tháng, năm theo luật) và tự động xoá sau hạn; không giữ mãi mãi. → Kiểm: lifecycle policy trong IaC khớp bảng; chi phí storage backup theo dõi. · Nguồn: [`cost-management.md`](cost-management.md); tối thiểu hoá dữ liệu (16)
- [ ] `OPS-DR-017` **SHOULD** Truyền thông khi DR: mẫu thông báo khách/nội bộ, kênh dự phòng khi kênh chính (Slack/email/SSO) cũng nằm trong vùng sự cố, danh sách liên hệ ngoài băng (out-of-band) kiểm hàng quý. → Kiểm: `DR-PLAN.md` mục truyền thông; ngày kiểm liên hệ. · Nguồn: NIST SP 800-34r1; [`incident-response.md`](incident-response.md)
- [ ] `OPS-DR-018` **SHOULD** Ứng dụng desktop/mobile/CLI/IoT lưu dữ liệu cục bộ: có export/import hoặc đồng bộ, kiểm toàn vẹn file, hướng dẫn người dùng sao lưu; cập nhật firmware/app không mất dữ liệu (test). → Kiểm: test nâng cấp giữ dữ liệu; tính năng export. · Nguồn: P11; hồ sơ desktop/mobile/embedded
- [ ] `OPS-DR-019` **SHOULD** Bộ nhớ/trạng thái của agent (memory store, vector index, outbox) nằm trong phạm vi backup và khôi phục nhất quán với CSDL chính (cùng thời điểm hoặc có thể dựng lại từ nguồn). → Kiểm: BACKUP-SCOPE có mục agent state; drill khôi phục kiểm nhất quán. · Nguồn: [`../13-ai-engineering/rag-and-knowledge.md`](../13-ai-engineering/rag-and-knowledge.md)
- [ ] `OPS-DR-020` **MAY** Chaos "xoá nhầm" trên staging (xoá bảng/bucket) để đo thời gian khôi phục thật và kiểm quyền xoá. → Kiểm: biên bản game day. · Nguồn: SRE Book
- [ ] `OPS-DR-021` **MAY** Backup bản sao lạnh ngoài cloud chính (nhà cung cấp khác/offline) cho dữ liệu sống còn. → Kiểm: lịch export + checksum. · Nguồn: CISA 3-2-1

## Bẫy thường gặp

1. **"Backup success" trong log nhưng chưa bao giờ restore** → file rỗng/hỏng/thiếu WAL khi cần. Tránh: `OPS-DR-005/017`.
2. **Snapshot cùng tài khoản với production** → xoá nhầm project/tài khoản bị khoá/ransomware mất cả hai. Tránh: offsite khác tài khoản (`OPS-DR-003/007`).
3. **Quên khoá mã hoá**: backup mã hoá bằng khoá chỉ có ở production đã mất. Tránh: `OPS-DR-004` (escrow khoá).
4. **Chỉ backup DB**, quên upload của người dùng, bí mật, state IaC, bộ nhớ agent. Tránh: BACKUP-SCOPE (`OPS-DR-002`).
5. **Khôi phục sai thứ tự** (app lên trước khi bí mật/KMS và CSDL sẵn sàng) → app ghi dữ liệu rác, phải làm lại từ đầu. Tránh: `OPS-DR-009`; lỗi PITR/WAL cấp CSDL xem bẫy ở 09.
6. **Restore vào production để "thử"** → ghi đè dữ liệu thật. Luôn restore vào môi trường tạm.
7. **RTO trên giấy 1 giờ, thực tế 1 ngày** vì runbook thiếu bước dựng hạ tầng/xoay bí mật. Tránh: drill toàn môi trường (`OPS-DR-011`).
8. **Retention vô hạn** → chi phí tăng và vi phạm tối thiểu hoá dữ liệu; **retention 7 ngày** → lỗi logic phát hiện sau 2 tuần không khôi phục được. Tránh: bảng retention có lý do.
9. **Xoá mềm không có xoá cứng** → yêu cầu xoá dữ liệu cá nhân không thực hiện được trọn vẹn (kể cả trong backup — ghi chính sách).
10. **Active-active đa vùng "cho an toàn"** không xử lý xung đột → dữ liệu lệch hai vùng. Active-passive trước; ADR nếu cần active-active.

## Cổng tự động

| Việc | Công cụ (license) | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Phạm vi backup khớp IaC | script đối chiếu `BACKUP-SCOPE.md` với tài nguyên dữ liệu trong state | — | CI IaC | kho không có mục = đỏ |
| Backup chạy & tươi | metric `backup_last_success_timestamp` | alert `time() - ts > RPO` | runtime | nổ = page/ticket theo SEV |
| Toàn vẹn (ngoài CSDL) | checksum / `restic check` / so object count & etag sau replication | sau mỗi lần | job backup | fail = alert; CSDL → `DB-BACKUP-009` |
| Drill toàn hệ thống | pipeline DR: IaC apply tài khoản sạch → restore → smoke | theo lịch (M năm, L quý) | CI/cron | RTO đo > mục tiêu = NO-GO |
| Bất biến & tách quyền | checkov/conftest trên IaC bucket | Object Lock bật; policy xoá tách | CI IaC | thiếu = đỏ |
| Mã hoá | checkov `CKV_*_ENCRYPTION` | — | CI IaC | thiếu = đỏ |
| Drill có bằng chứng | script đọc `dr-drills.md` | ngày drill gần nhất ≤ 90 ngày (M) | CI lịch | quá hạn = cảnh báo; GO/NO-GO yêu cầu |
| Snapshot trước migration | bước pipeline | id snapshot vào log/PR | deploy | thiếu = dừng |

## Nguồn

- NIST SP 800-34 Rev. 1 — Contingency Planning Guide for Federal Information Systems (11/2010; BIA, RPO/RTO, alternate site): <https://csrc.nist.gov/pubs/sp/800/34/r1/upd1/final> — xác minh 2026-10-13 (định nghĩa RPO/RTO nằm trong PDF, chưa trích nguyên văn).
- CISA/CERT (Carnegie Mellon) — "Data Backup Options" (2012): quy tắc 3-2-1 "3 copies, 2 media types, 1 offsite": <https://www.cisa.gov/sites/default/files/publications/data_backup_options.pdf> — xác minh 2026-10-13 (đọc PDF bằng pdftotext).
- PITR/WAL cấp CSDL: nguồn và yêu cầu ở [`../09-database/backup-and-recovery.md`](../09-database/backup-and-recovery.md) (`DB-BACKUP-005`), không lặp ở đây.
- Google SRE Book — Data Integrity (kiểm backup bằng restore liên tục) — (chưa fetch lại 2026-10-13).
- Lifecycle G8 của khung ([`../00-method/lifecycle.md`](../00-method/lifecycle.md)): "backup đã thử khôi phục"; catalog `seeker19110/stored` 09 §1.3 ([BLOCKER] backup có test restore), đọc 2026-10-13.
- (chưa xác minh 2026-10-13) pgBackRest, Barman, restic, Velero, Litestream phiên bản/license; CISA ransomware guidance — xác minh trước khi dùng.
