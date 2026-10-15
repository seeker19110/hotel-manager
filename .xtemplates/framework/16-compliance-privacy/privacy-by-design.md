---
title: Privacy by design: tối thiểu hoá, mục đích, lưu trữ, xoá, DPIA
kind: module
prefix: CMP-PRIV
applies_to: [all]
updated: 2026-10-14
---

# Privacy by design: tối thiểu hoá, mục đích, lưu trữ, xoá, DPIA

> Cách **thiết kế** để dữ liệu cá nhân được thu ít nhất, dùng đúng mục đích, giữ đúng hạn và xoá được thật — trước
> khi viết dòng code đầu tiên. Áp dụng cho mọi phần mềm có chạm tới dữ liệu của người thật (kể cả log, analytics,
> prompt gửi LLM). Nghĩa vụ pháp lý cụ thể ở [`vietnam-data-law.md`](vietnam-data-law.md) và
> [`international-privacy.md`](international-privacy.md); kiểm soát kỹ thuật ở CSDL ở
> [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md).

## Nguyên tắc

1. **Không thu thì không phải bảo vệ.** Mỗi trường dữ liệu cá nhân phải trả lời được "dùng cho mục đích nào, ai cần,
   giữ bao lâu" (GDPR Art. 5(1)(b)(c)(e); Luật 91/2025/QH15 Đ.3). Không trả lời được → bỏ trường.
2. **Mặc định riêng tư (privacy by default):** cài đặt mặc định là mức chia sẻ ít nhất; tính năng tuỳ chọn tắt sẵn
   (GDPR Art. 25; ISO/IEC 27701:2025).
3. **Dữ liệu cá nhân là tài sản có hạn dùng:** mọi bảng/bucket/topic có `retention` ghi rõ và job xoá chạy thật,
   không chỉ "chính sách".
4. **Xoá phải lan đến mọi bản sao:** CSDL, backup, cache, search index, data warehouse, log, nhà xử lý bên thứ ba.
   Không lan được → dùng crypto-shredding (xoá khoá) hoặc khử nhận dạng.
5. **Đánh giá tác động trước khi xử lý rủi ro cao**, không phải sau khi ra mắt (GDPR Art. 35; Luật 91/2025 Đ.21).
6. **Privacy là một mối đe doạ trong threat model:** dùng LINDDUN cùng STRIDE (xem
   [`../12-security/threat-modeling.md`](../12-security/threat-modeling.md)).

## Quyết định

| Tình huống | Chọn | Khi nào không dùng |
|---|---|---|
| Cần phân tích hành vi, không cần biết ai | **Ẩn danh hoá** (k-anonymity ≥ 5, tổng hợp theo nhóm) — ra khỏi phạm vi luật | Khi cần liên hệ lại người dùng → giả danh hoá |
| Cần nối dữ liệu theo người nhưng hạn chế lộ | **Giả danh hoá** (token/HMAC có khoá riêng, khoá tách khỏi dữ liệu) — vẫn là dữ liệu cá nhân | Khi bảng tra ngược nằm chung CSDL (vô nghĩa) |
| Phải xoá nhưng backup bất biến | **Crypto-shredding**: mã hoá theo khoá/người dùng, xoá = huỷ khoá | Khi không có KMS/quản lý khoá đủ tin cậy |
| Dữ liệu nhạy cảm (sức khoẻ, sinh trắc, trẻ em, tài chính) | **Tách kho + mã hoá cột + truy cập theo vai + log truy cập** | — (bắt buộc) |
| Gửi dữ liệu cho LLM/bên thứ ba | **Che (redact) PII trước khi gửi** bằng bộ phát hiện PII; hợp đồng xử lý dữ liệu | Khi nhà cung cấp đã ký DPA và nằm trong hồ sơ ĐGTĐ, vẫn tối thiểu hoá |
| Cần DPIA? | Có nếu: dữ liệu nhạy cảm, theo dõi quy mô lớn, trẻ em, quyết định tự động, công nghệ mới, ghép nhiều nguồn | Chỉ dữ liệu liên hệ cơ bản nội bộ, quy mô S → "DPIA rút gọn" 1 trang vẫn phải có |

**Mặc định khuyến nghị:** sổ dữ liệu (data map) dạng file trong repo (`docs/privacy/data-map.yaml`) + retention
trong cùng file → sinh cấu hình job xoá và mục DPIA từ đó (một nguồn sự thật — P5).

## Checklist

- [ ] `CMP-PRIV-001` **MUST** Có sổ dữ liệu cá nhân (data map) liệt kê mọi trường PII: hệ thống, bảng/cột, phân loại (thường/nhạy cảm/trẻ em), mục đích, cơ sở pháp lý, thời hạn giữ, nơi sao chép, bên nhận. → Kiểm: file `docs/privacy/data-map.yaml` tồn tại, CI chạy script đối chiếu tên cột trong schema với data map (cột PII không khai báo → fail). · Nguồn: GDPR Art. 30; ISO/IEC 27701:2025
- [ ] `CMP-PRIV-002` **MUST@L** Mỗi trường PII có `purpose` và `retention` không rỗng; trường không có mục đích bị loại khỏi schema. → Kiểm: lint data map (`retention` dạng ISO 8601 duration hoặc `until-account-deleted`), PR thêm cột PII thiếu `purpose` bị chặn. · Nguồn: GDPR Art. 5(1)(b)(e); Luật 91/2025/QH15 Đ.3
- [ ] `CMP-PRIV-003` **MUST@L** Form/API chỉ yêu cầu trường cần cho mục đích đã công bố; trường "để sau này dùng" bị cấm. → Kiểm: review schema request (OpenAPI/Zod/Pydantic) đối chiếu data map; test từ chối payload có trường PII ngoài schema (`additionalProperties: false`). · Nguồn: GDPR Art. 5(1)(c); Luật 91/2025/QH15 Đ.3
- [ ] `CMP-PRIV-004` **MUST@L** Có job xoá/khử nhận dạng theo retention chạy định kỳ cho mọi kho (CSDL, object storage, search index, warehouse, queue DLQ). → Kiểm: job có lịch (cron/worker), log lần chạy gần nhất ≤ 1 chu kỳ; test tích hợp tạo bản ghi quá hạn → sau job không còn truy vấn được. · Nguồn: GDPR Art. 5(1)(e); Luật 91/2025/QH15 Đ.14
- [ ] `CMP-PRIV-005` **MUST** Xoá tài khoản xoá/ẩn danh hoá dữ liệu ở mọi bản sao trong thời hạn công bố, kể cả bên xử lý thứ ba (gọi API xoá hoặc ticket có hạn). → Kiểm: test E2E "xoá tài khoản" rồi truy vấn từng kho (DB, cache, index, storage, analytics) trả rỗng; danh sách bên thứ ba có bằng chứng xoá. · Nguồn: GDPR Art. 17; Luật 91/2025/QH15 Đ.14
- [ ] `CMP-PRIV-006` **MUST@L** Backup không xoá được từng bản ghi → dùng crypto-shredding theo khoá người dùng/tenant hoặc backup hết hạn ≤ retention tối đa đã công bố. → Kiểm: tài liệu backup ghi cơ chế; test khôi phục backup sau khi huỷ khoá → dữ liệu không đọc được. · Nguồn: GDPR Art. 17; Art. 32
- [ ] `CMP-PRIV-007` **MUST@L** Dữ liệu nhạy cảm (sức khoẻ, sinh trắc, tài chính, trẻ em, tôn giáo, chính trị, định vị chính xác) được mã hoá ở mức cột/trường với khoá tách khỏi CSDL. → Kiểm: schema đánh dấu cột nhạy cảm; test đọc dump CSDL không thấy bản rõ; cấu hình KMS/HSM. · Nguồn: GDPR Art. 9, 32; Luật 91/2025/QH15 Đ.2, Đ.12
- [ ] `CMP-PRIV-008` **MUST** Không ghi PII vào log ứng dụng/trace/crash report (email, SĐT, số định danh, token, nội dung tin nhắn). → Kiểm: rule Semgrep/ESLint cấm log object người dùng; test đơn vị bộ lọc log che PII; quét log staging bằng bộ phát hiện PII (vd Presidio) = 0 phát hiện. · Nguồn: GDPR Art. 5(1)(f); ISO/IEC 27701:2025
- [ ] `CMP-PRIV-009` **MUST@L** DPIA được lập trước khi xử lý rủi ro cao (nhạy cảm, trẻ em, theo dõi, quyết định tự động, ghép nguồn, công nghệ mới) theo [`../templates/DPIA.md`](../templates/DPIA.md). → Kiểm: file `docs/privacy/DPIA-<tính-năng>.md` có mục rủi ro + biện pháp + người duyệt; PR tính năng thuộc nhóm rủi ro cao phải link DPIA (CI kiểm nhãn `privacy:high-risk`). · Nguồn: GDPR Art. 35; Luật 91/2025/QH15 Đ.21
- [ ] `CMP-PRIV-010` **MUST** PII bị che (redact) trước khi gửi tới LLM, dịch vụ phân tích hoặc nhà cung cấp chưa có hợp đồng xử lý dữ liệu. → Kiểm: test đơn vị lớp redaction với bộ mẫu PII tiếng Việt (SĐT, CCCD 12 số, email, địa chỉ); log request ra ngoài không chứa PII. · Nguồn: GDPR Art. 28, 44; Luật 91/2025/QH15 Đ.17, Đ.20
- [ ] `CMP-PRIV-011` **MUST@L** Giả danh hoá định danh người dùng trong data warehouse/analytics; bảng ánh xạ ngược chỉ ở hệ thống nguồn với quyền riêng. → Kiểm: schema warehouse không có cột PII trực tiếp; ACL bảng ánh xạ chỉ vai `privacy-admin`. · Nguồn: GDPR Art. 4(5), Art. 25
- [ ] `CMP-PRIV-012` **MUST@L** Cài đặt mặc định của tài khoản mới ở mức riêng tư nhất (hồ sơ không công khai, không chia sẻ với đối tác, không tiếp thị). → Kiểm: test E2E tạo tài khoản mới và đọc trạng thái từng cờ = giá trị bảo thủ. · Nguồn: GDPR Art. 25(2)
- [ ] `CMP-PRIV-013` **SHOULD** Threat model của tính năng có mục "mối đe doạ riêng tư" theo LINDDUN (linkability, identifiability, non-repudiation, detectability, disclosure, unawareness, non-compliance). → Kiểm: [`../templates/THREAT-MODEL.md`](../templates/THREAT-MODEL.md) có bảng LINDDUN với biện pháp. · Nguồn: LINDDUN; ISO/IEC 29134
- [ ] `CMP-PRIV-014` **SHOULD** Dữ liệu định vị, sinh trắc, nội dung riêng tư (tin nhắn, ảnh) được xử lý tại thiết bị (on-device) khi khả thi thay vì gửi lên máy chủ. → Kiểm: ADR nêu lý do nếu gửi lên máy chủ; data map ghi nơi xử lý. · Nguồn: GDPR Art. 25; Luật 91/2025/QH15 Đ.31
- [ ] `CMP-PRIV-015` **SHOULD** Dữ liệu test/staging không chứa PII thật; dùng dữ liệu sinh hoặc đã khử nhận dạng. → Kiểm: quét DB staging bằng bộ phát hiện PII; script seed không đọc từ production. · Nguồn: GDPR Art. 32; ISO/IEC 27701:2025
- [ ] `CMP-PRIV-016` **SHOULD** Thời hạn giữ dữ liệu được công bố trong chính sách riêng tư khớp với data map (cùng nguồn sinh ra). → Kiểm: script sinh bảng retention trong policy từ data map; diff = 0 trong CI. · Nguồn: GDPR Art. 13(2)(a); Luật 91/2025/QH15 Đ.9
- [ ] `CMP-PRIV-017` **SHOULD** Ghép (link) dữ liệu từ nhiều nguồn về một người chỉ khi mục đích ghép đã ở data map và DPIA. → Kiểm: review truy vấn JOIN giữa domain PII; data map có mục `linked_from`. · Nguồn: GDPR Art. 5(1)(b); Art. 35(3)
- [ ] `CMP-PRIV-018` **SHOULD** Dữ liệu suy luận (inferred: sở thích, điểm rủi ro, cảm xúc) được coi là PII và có retention/mục đích riêng. → Kiểm: data map liệt kê trường suy luận; người dùng xem/xoá được qua DSAR. · Nguồn: GDPR Art. 4(1), Art. 22
- [ ] `CMP-PRIV-019` **SHOULD** Trước khi thêm SDK/bên thứ ba thu dữ liệu (analytics, ads, crash), chạy đánh giá nhà cung cấp: DPA, nơi lưu, sub-processor, cơ chế xoá. → Kiểm: file `docs/privacy/processors.md` có dòng cho mỗi SDK, link DPA. · Nguồn: GDPR Art. 28; Luật 91/2025/QH15 Đ.17
- [ ] `CMP-PRIV-020` **MAY** Dùng differential privacy hoặc tổng hợp có nhiễu cho thống kê công khai từ dữ liệu người dùng. → Kiểm: tài liệu tham số epsilon và lý do. · Nguồn: NIST Privacy Framework 1.0
- [ ] `CMP-PRIV-021` **MAY** Cấp "privacy budget" cho mỗi tính năng mới: số trường PII tối đa được thêm, vượt phải qua review riêng tư. → Kiểm: CI đếm trường PII mới trong PR so với ngưỡng. · Nguồn: thực hành nội bộ
- [ ] `CMP-PRIV-022` **MAY** Hiển thị "nhãn dinh dưỡng dữ liệu" (data nutrition label) trong app: thu gì, vì sao, giữ bao lâu — sinh từ data map. → Kiểm: trang có thật và sinh tự động. · Nguồn: GDPR Art. 12 (minh bạch)

## Bẫy thường gặp

- **"Xoá mềm" mãi mãi:** `deleted_at` rồi không bao giờ purge; backup và index vẫn giữ → không phải xoá. Cách tránh: job purge có hạn + crypto-shredding cho backup.
- **PII trong log/trace/Sentry:** `logger.info(user)` dump cả object; URL chứa email/token. Cách tránh: bộ lọc log + rule lint + quét log định kỳ.
- **Analytics "ẩn danh" nhưng có user_id, IP, fingerprint:** vẫn là PII. Cách tránh: giả danh hoá bằng HMAC có khoá, tắt thu IP, không fingerprint.
- **Prompt LLM chứa toàn bộ hồ sơ khách hàng** vì "model cần ngữ cảnh". Cách tránh: redact + chỉ gửi trường cần.
- **Retention "theo quy định" nhưng không ai biết số:** chính sách nói "giữ khi cần thiết". Cách tránh: số cụ thể trong data map, sinh ra policy.
- **DPIA viết sau khi ra mắt để đối phó** → không đổi được thiết kế. Cách tránh: DPIA là đầu vào G4 (thiết kế), gắn nhãn PR.
- **Dữ liệu test chép từ production:** lộ PII cho toàn đội và CI. Cách tránh: dữ liệu sinh (faker) + quét staging.
- **Trường "ghi chú tự do" chứa đủ thứ** (sức khoẻ, CCCD): không phân loại được. Cách tránh: cảnh báo UI + quét PII trong trường tự do + retention ngắn.

## Cổng tự động

| Việc kiểm | Công cụ (giấy phép) | Lệnh/cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Cột PII không khai báo trong data map | Script nội bộ (so schema ↔ `data-map.yaml`) | `python scripts/privacy/check-data-map.py` | CI (PR) | 0 cột lệch |
| PII trong log/code | Semgrep (LGPL-2.1 cho CLI; rule registry không OSI — tự viết rule) | `semgrep --config .semgrep/pii-logging.yml` | pre-commit + CI | 0 finding |
| PII trong log/DB staging | Microsoft Presidio `presidio-analyzer` 2.2.364 (MIT, xác minh PyPI 2026-10-13) + recognizer tiếng Việt tự thêm | `python scripts/privacy/scan-logs.py` | CI nightly | 0 phát hiện mức high |
| Job xoá đã chạy | Metric `privacy_purge_last_success_timestamp` | Alert khi > 1 chu kỳ | Observability | Alert = sự cố P2 |
| Xoá tài khoản lan mọi kho | Playwright/pytest E2E | `npm run test:e2e -- --grep "delete account"` | CI (merge) | pass |
| PR rủi ro cao phải có DPIA | GitHub Action/label check | nhãn `privacy:high-risk` ⇒ link `docs/privacy/DPIA-*.md` | CI (PR) | fail nếu thiếu |

## Nguồn

- GDPR — Regulation (EU) 2016/679, Art. 4, 5, 9, 17, 25, 28, 30, 32, 35: <https://eur-lex.europa.eu/eli/reg/2016/679/oj> — xác minh gián tiếp 2026-10-13 (EUR-Lex không trả nội dung qua công cụ, đối chiếu bản sao CELEX:32016R0679 qua kết quả tìm kiếm); kiểm tra văn bản sửa đổi trước khi áp dụng.
- Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15 (thông qua 26/06/2025, hiệu lực 01/01/2026), Đ.3, Đ.9, Đ.12, Đ.14, Đ.17, Đ.20, Đ.21, Đ.31: <https://vanban.chinhphu.vn/?pageid=27160&docid=214590> — xác minh 2026-10-13; kiểm tra văn bản sửa đổi/thay thế trước khi áp dụng.
- ISO/IEC 27701:2025 (PIMS độc lập, công bố 14/10/2025, thay bản 2019): <https://www.iso.org/standard/27701> — xác minh 2026-10-13.
- NIST Privacy Framework 1.0 (01/2020; bản 1.1 còn ở dạng dự thảo IPD): <https://www.nist.gov/privacy-framework> — xác minh 2026-10-13.
- LINDDUN privacy threat modeling: <https://linddun.org/> — (chưa xác minh phiên bản tài liệu ngày 2026-10-13).
- Microsoft Presidio: <https://pypi.org/pypi/presidio-analyzer/json> — phiên bản 2.2.364, MIT, xác minh 2026-10-13.
- Mẫu DPIA của khung: [`../templates/DPIA.md`](../templates/DPIA.md).
