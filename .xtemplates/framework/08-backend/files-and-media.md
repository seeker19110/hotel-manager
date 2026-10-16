---
title: File, upload, lưu trữ đối tượng, xử lý ảnh/video, quét
kind: module
prefix: BE-FILE
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain]
updated: 2026-10-15
---

# File, upload, lưu trữ đối tượng, xử lý ảnh/video, quét

> Upload là nơi mã độc, bom nén, lộ dữ liệu và chi phí lưu trữ gặp nhau. Chuẩn: **upload thẳng lên object storage
> bằng presigned URL**, server chỉ cấp phép và nhận thông báo; validate kiểu bằng magic bytes + allowlist đuôi,
> giới hạn kích thước, quét malware, xử lý ảnh bằng cách giải mã–mã hoá lại (strip EXIF), lưu ngoài webroot, phục
> vụ qua handler có kiểm quyền.

## Nguyên tắc

1. **Server ứng dụng không là đường đi của byte file** ở quy mô M+: client → presigned URL → object storage;
   app chỉ ký, ghi metadata, kiểm quyền và xử lý sau.
2. **Không tin tên file, `Content-Type`, đuôi.** Chỉ tin: magic bytes + allowlist đuôi kinh doanh cần + kích
   thước đo được. Tên lưu là ID do server sinh.
3. **File đầu vào là dữ liệu không tin cậy (P6):** giải mã trong sandbox/thư viện cập nhật, giới hạn pixel/
   thời lượng/độ sâu nén, quét malware trước khi cho tải xuống công khai.
4. **Quyền trên file = quyền trên bản ghi sở hữu.** Không có URL công khai vĩnh viễn cho dữ liệu người dùng;
   presigned URL tải xuống ngắn hạn, bucket private mặc định.
5. **File có vòng đời:** metadata trong DB (ai, lúc nào, hash, kích thước, trạng thái quét), lifecycle rule xoá
   file mồ côi/hết hạn, xoá theo yêu cầu người dùng ([`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md)).

## Quyết định

| Nhu cầu | Chọn | Khi nào không |
|---|---|---|
| Lưu file người dùng | **Object storage S3-tương thích** (S3/R2/GCS/MinIO), bucket private, versioning cho dữ liệu quan trọng | Đĩa cục bộ của server (mất khi scale/replace) |
| Đường upload | **Presigned PUT/POST** với giới hạn kích thước + content-type trong chính sách ký, hết hạn ngắn (phút) | Upload qua app server chỉ khi file nhỏ (< vài MB) và cần xử lý đồng bộ |
| File lớn (> ~100 MB) | Multipart upload presigned từng phần, resumable | Một request PUT lớn |
| Phục vụ file | Private + presigned GET ngắn hạn (hoặc signed CDN URL); public chỉ cho asset thật sự công khai | Bucket public cho dữ liệu người dùng |
| Xử lý ảnh | Giải mã → resize/convert (libvips/sharp, Pillow) → mã hoá lại định dạng cho phép, không giữ metadata | Lưu nguyên file gốc làm bản phục vụ |
| Video/âm thanh | Transcode bất đồng bộ (ffmpeg trong job có timeout/giới hạn RAM) sang định dạng chuẩn; chỉ phục vụ bản đã transcode | Phục vụ file gốc người dùng tải lên |
| Quét malware | ClamAV (GPL-2.0, self-host) trong job sau upload, trạng thái `pending → clean/infected`; CDR cho PDF/Office nếu ngành yêu cầu | Bỏ qua quét vì "chỉ ảnh" |
| Tài liệu Office/PDF | Chuyển sang PDF/ảnh để xem trước; giữ bản gốc ở trạng thái "chỉ tải khi đã quét" | Render Office trực tiếp từ file người dùng trên server |

## Checklist

- [ ] `BE-FILE-001` **MUST** Validate kiểu file bằng magic bytes (libmagic/`file-type`) **và** allowlist đuôi theo nhu cầu nghiệp vụ; `Content-Type` client chỉ là gợi ý; đuôi kép/ký tự lạ bị từ chối. → Kiểm: test upload `.php` đổi tên `.png`, file PNG đuôi `.jpg`, `a.jpg.exe` → từ chối. · Nguồn: OWASP File Upload Cheat Sheet, ASVS 5.0 V5
- [ ] `BE-FILE-002` **MUST@L** Giới hạn kích thước tối đa theo loại (vd ảnh 10 MB, tài liệu 25 MB — ghi trong PROJECT.md) thực thi ở cả chính sách presigned lẫn server; kiểm trước khi đọc hết body (413). → Kiểm: test vượt giới hạn → 413/403 từ storage; chính sách ký có `content-length-range`. · Nguồn: OWASP File Upload Cheat Sheet
- [ ] `BE-FILE-003` **MUST** Tên lưu do server sinh (UUID/ULID + đuôi chuẩn hoá), không dùng tên người dùng trong đường dẫn; tên gốc chỉ lưu trong metadata đã sanitize (giới hạn độ dài, bỏ ký tự điều khiển/đường dẫn). → Kiểm: test tên `../../etc/passwd` → key lưu không chứa `..`; DB lưu tên gốc đã lọc. · Nguồn: OWASP File Upload Cheat Sheet
- [ ] `BE-FILE-004` **MUST** File lưu ngoài webroot/ở object storage private; không thực thi được (không có quyền execute, không serve qua thư mục có handler script). → Kiểm: bucket policy không public; test GET trực tiếp URL không ký → 403. · Nguồn: OWASP File Upload Cheat Sheet
- [ ] `BE-FILE-005` **MUST** Upload và tải xuống đều kiểm xác thực + phân quyền theo bản ghi sở hữu ([`authn-authz.md`](authn-authz.md)); presigned GET hết hạn ngắn (phút–giờ, tối đa theo nền tảng, S3 CLI ≤ 7 ngày), không tái dùng làm "link công khai". → Kiểm: test user B lấy presigned URL file của A → 403; URL hết hạn → 403. · Nguồn: AWS S3 presigned URLs, OWASP Authorization Cheat Sheet
- [ ] `BE-FILE-006` **MUST@L** Ảnh được giải mã và mã hoá lại (resize/convert) bằng thư viện cập nhật trước khi phục vụ; strip toàn bộ metadata (EXIF/GPS/XMP) trừ khi nghiệp vụ cần và người dùng đồng ý; giới hạn kích thước pixel đầu vào (chống decompression bomb). → Kiểm: test ảnh có GPS → bản phục vụ không còn EXIF; ảnh 30.000×30.000 px → từ chối trước khi giải mã. · Nguồn: OWASP File Upload Cheat Sheet (image rewriting)
- [ ] `BE-FILE-007` **MUST@L** Metadata file trong DB: `owner_id`/`tenant_id`, key storage, kích thước, mime đã xác minh, hash (SHA-256), `scan_status`, `created_at`; file không có bản ghi → mồ côi, có job dọn. → Kiểm: schema có các cột; job dọn mồ côi có lịch và log. · Nguồn: P5
- [ ] `BE-FILE-008` **MUST@L** Phản hồi tải xuống có `Content-Disposition` (attachment cho file người dùng), `Content-Type` từ mime đã xác minh, `X-Content-Type-Options: nosniff`; không bao giờ phục vụ HTML/SVG do người dùng tải lên cùng origin ứng dụng (dùng domain/sub-domain riêng hoặc sandbox CSP). → Kiểm: test tải SVG → `Content-Disposition: attachment` hoặc domain tách; header nosniff có mặt. · Nguồn: OWASP File Upload Cheat Sheet, [`../07-frontend/client-security.md`](../07-frontend/client-security.md)
- [ ] `BE-FILE-009` **MUST@L** Quét malware bất đồng bộ sau upload (ClamAV hoặc dịch vụ), trạng thái `pending` không cho tải công khai; `infected` → cách ly + thông báo; chữ ký virus cập nhật tự động. → Kiểm: test upload EICAR → `infected`, tải xuống bị chặn; cron `freshclam` chạy. · Nguồn: OWASP File Upload Cheat Sheet
- [ ] `BE-FILE-010` **MUST@L** Xử lý file nặng (transcode, OCR, nén) chạy trong job có timeout, giới hạn CPU/RAM/đĩa tạm, trong container/sandbox riêng, không trên tiến trình web. → Kiểm: job có timeout + limits; test file gây treo → bị huỷ, không ảnh hưởng API. · Nguồn: [`background-jobs-and-queues.md`](background-jobs-and-queues.md)
- [ ] `BE-FILE-011` **MUST@L** File nén (zip/tar): giới hạn số entry, tổng kích thước sau giải nén, tỉ lệ nén, độ sâu lồng; chặn path traversal trong entry; không giải nén đệ quy mặc định. → Kiểm: test zip bomb và entry `../x` → từ chối; Python gọi `tarfile.extractall(..., filter="data")` tường minh (mặc định từ 3.14, bản cũ hơn không lọc). · Nguồn: OWASP File Upload Cheat Sheet (archives); Python docs `tarfile` extraction filters (PEP 706)
- [ ] `BE-FILE-012` **MUST@L** Bucket: versioning hoặc soft-delete cho dữ liệu người dùng, lifecycle rule (xoá multipart dở, chuyển lớp lưu trữ lạnh, xoá theo retention), mã hoá at-rest bật, log truy cập bật; backup/replication theo [`../15-operations/backup-and-disaster-recovery.md`](../15-operations/backup-and-disaster-recovery.md). → Kiểm: IaC bucket có versioning/lifecycle/encryption/logging. · Nguồn: ASVS 5.0 V14
- [ ] `BE-FILE-013` **MUST@L** Xoá file theo yêu cầu người dùng/khi xoá bản ghi: xoá object + bản dẫn xuất (thumbnail/transcode) + cache CDN, có job dọn và bằng chứng (log) — đáp ứng quyền xoá dữ liệu. → Kiểm: test xoá bản ghi → object và dẫn xuất không còn sau job; xem [`../16-compliance-privacy/consent-and-user-rights.md`](../16-compliance-privacy/consent-and-user-rights.md).
- [ ] `BE-FILE-014` **SHOULD** Presigned upload có chính sách ràng buộc: key do server quyết, `content-length-range`, `Content-Type` cố định, hết hạn ≤ 15 phút; sau upload client gọi "confirm" để server xác minh object tồn tại + kích thước + magic bytes rồi mới tạo bản ghi `ready`. → Kiểm: test upload key khác chính sách → 403; test confirm với object không tồn tại → 404.
- [ ] `BE-FILE-015` **SHOULD** Sinh bản dẫn xuất (thumbnail, WebP/AVIF, nhiều kích thước) bất đồng bộ, đặt tên theo hash nội dung + tham số; phục vụ qua CDN với cache dài. → Kiểm: key dẫn xuất chứa hash; `Cache-Control` theo [`caching.md`](caching.md).
- [ ] `BE-FILE-016` **SHOULD** Khử trùng theo hash: cùng SHA-256 → tham chiếu lại object (dedupe) khi chính sách cho phép; hash cũng dùng để đối chiếu toàn vẹn khi khôi phục. → Kiểm: test upload cùng file 2 lần → 1 object, 2 bản ghi.
- [ ] `BE-FILE-017` **SHOULD** Giới hạn tốc độ và hạn mức upload theo người dùng/tenant (số file/ngày, tổng dung lượng) để chống lạm dụng và kiểm soát chi phí. → Kiểm: test vượt hạn mức → 429/403; dashboard dung lượng theo tenant.
- [ ] `BE-FILE-018` **SHOULD** Tải xuống file lớn dùng streaming/`Range` (206) hoặc redirect tới presigned URL; không buffer toàn bộ file trong RAM app. → Kiểm: test `Range: bytes=0-99` → 206; profile RAM khi tải 1 GB.
- [ ] `BE-FILE-019` **MAY** CDR (Content Disarm & Reconstruction) cho PDF/Office trong ngành bị quản lý; chuyển đổi sang PDF/ảnh để xem trước. → Kiểm: pipeline CDR tồn tại; file gốc chỉ tải khi đã quét.
- [ ] `BE-FILE-020` **MAY** Ký nội dung (checksum trong metadata, Content-MD5/SHA-256 khi PUT) để phát hiện hỏng trên đường truyền. → Kiểm: PUT có checksum header; storage từ chối khi lệch.

## Bẫy thường gặp

- **Tin `Content-Type` hoặc đuôi file.** Web shell `.php` đổi tên `.jpg`. Magic bytes + allowlist + lưu ngoài webroot + không execute.
- **Phục vụ SVG/HTML người dùng tải lên cùng origin.** Stored XSS qua ảnh. Tách domain hoặc `attachment` + CSP sandbox.
- **Bucket public "cho tiện".** Dữ liệu người dùng lộ qua Google. Private + presigned ngắn hạn.
- **Presigned URL 7 ngày dùng làm link chia sẻ.** Không thu hồi được, lọt log/chat. Ngắn hạn, sinh mỗi lần xem.
- **Upload qua app server rồi mới đẩy S3.** Tốn RAM/CPU app, timeout proxy, không scale. Presigned thẳng.
- **Giải mã ảnh không giới hạn pixel.** PNG 1 KB giải nén thành 4 GB RAM → OOM. Giới hạn pixel trước giải mã (`limitInputPixels`, `MAX_IMAGE_PIXELS`).
- **Giữ EXIF.** Ảnh hồ sơ chứa toạ độ GPS nhà người dùng. Strip mặc định.
- **File mồ côi tích tụ.** Upload xong nhưng form không submit → hàng TB rác. Confirm step + lifecycle + job dọn.
- **Xoá bản ghi nhưng không xoá object/thumbnail/CDN.** Vi phạm quyền xoá dữ liệu. Job xoá dẫn xuất + purge CDN có bằng chứng.
- **ffmpeg/ImageMagick chạy trên tiến trình web với file bất kỳ.** CVE giải mã → RCE trên API. Job sandbox, thư viện cập nhật, policy ImageMagick hạn chế.

## Cổng tự động

| Công cụ | Lệnh / cấu hình | Đặt ở | Ngưỡng |
|---|---|---|---|
| Test validate upload | bộ test: đuôi giả, magic bytes sai, quá kích thước, tên traversal, zip bomb, ảnh pixel khổng lồ, EICAR | CI `quality` | 0 fail |
| Test quyền file | user B tải/xoá file của A → 403/404 | CI | Pass |
| Test EXIF | upload ảnh có GPS → bản phục vụ không có tag GPS (`exiftool`/Pillow đọc) | CI | Pass |
| IaC check | checkov/conftest: bucket không public, versioning, encryption, logging, lifecycle | CI | 0 vi phạm |
| Malware scan | ClamAV 1.5.4 (GPL-2.0) `clamdscan` trong job; `freshclam` cron | prod job | 100% file qua quét trước khi public |
| Thư viện (xác minh 2026-10-13, xác minh lại trước khi dùng) | sharp 0.35.5 (Apache-2.0, libvips) · Pillow 12.3.0 (MIT-CMU) · python-magic 0.4.27 (MIT) · `file-type` npm | code | — |
| Dọn mồ côi | job so khớp object storage ↔ DB, xoá object không có bản ghi > 24 giờ | prod cron | Log số xoá |

## Nguồn

- OWASP File Upload Cheat Sheet (allowlist đuôi, không tin Content-Type, magic bytes, tên ngẫu nhiên, giới hạn kích thước kể cả sau giải nén, ngoài webroot, AV/CDR, rewrite ảnh strip metadata): <https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html> — xác minh 2026-10-13
- OWASP ASVS 5.0.0 V5 File Handling, V14 Data Protection: <https://github.com/OWASP/ASVS/tree/master/5.0/en> — xác minh 2026-10-13
- OWASP Authorization Cheat Sheet (authorization cho static resources/cloud storage): <https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html> — xác minh 2026-10-13
- Amazon S3 — Sharing objects with presigned URLs (console tối đa 12 giờ, CLI/SDK tối đa 7 ngày): <https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html> — xác minh 2026-10-13
- RFC 9110 §14 Range Requests / 206: <https://www.rfc-editor.org/rfc/rfc9110> — xác minh 2026-10-13
- Phiên bản (registry/endoflife.date, xác minh 2026-10-13): sharp 0.35.5, Pillow 12.3.0, python-magic 0.4.27, ClamAV 1.5.4 (07/08/2026).
- (chưa xác minh) `file-type` npm, ffmpeg, ImageMagick phiên bản; tài liệu `limitInputPixels` của sharp và `MAX_IMAGE_PIXELS` của Pillow — không fetch ngày 2026-10-13.
- `research/2026-10-13-stored-catalog-extraction.md` §2.5 (checklist deploy: SSRF, bảo mật file); catalog `09-engineering-checklists` §1.3.
