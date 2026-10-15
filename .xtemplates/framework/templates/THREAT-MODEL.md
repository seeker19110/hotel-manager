---
title: Mẫu THREAT-MODEL
kind: template
updated: 2026-10-13
---

# Mẫu THREAT-MODEL.md

> **Ai viết:** kiến trúc sư/người xây cùng AI; người chịu trách nhiệm bảo mật duyệt. **Giai đoạn:** G4 Design; cập nhật khi thêm thành phần, luồng dữ liệu hoặc bên thứ ba.
> **Cổng dùng:** G4 ("threat model có biện pháp cho mỗi mối đe doạ mức cao"), G7 GO/NO-GO, `SEC-TM-*` ở [`../12-security/threat-modeling.md`](../12-security/threat-modeling.md).
> **Cách làm:** liệt kê tài sản → vẽ luồng dữ liệu và ranh giới tin cậy → với **mỗi luồng** rà 6 loại STRIDE → mỗi mối đe doạ có mức, biện pháp, **bằng chứng kiểm được** (test/cấu hình/scanner), trạng thái.
> Mối đe doạ mức Cao không có biện pháp + bằng chứng = BLOCKER ở GO/NO-GO.

````markdown
# THREAT-MODEL — <Tên hệ thống> · phiên bản <n> · <YYYY-MM-DD>

> Chủ: <tên> · Duyệt: <tên> ngày <YYYY-MM-DD> · Phạm vi: <thành phần/luồng được rà> · Ngoài phạm vi: <...> (lý do)

## 1. Tài sản (cái gì cần bảo vệ)
| ID | Tài sản | Phân loại | Ảnh hưởng nếu lộ / sửa / mất |
|---|---|---|---|
| A-01 | Dữ liệu cá nhân người dùng (email, ...) | nhạy cảm | <pháp lý, uy tín> |
| A-02 | Khoá API / secret | bí mật | |
| A-03 | Dữ liệu giao dịch | toàn vẹn | |

## 2. Thành phần, ranh giới tin cậy, luồng dữ liệu
```text
[Trình duyệt/App] --(1) HTTPS--> [API] --(2)--> [CSDL]
       |                           |--(3)--> [Dịch vụ bên thứ ba: <tên>]
       |--(4)--> [CDN/Static]      |--(5)--> [Hàng đợi/Job]
Ranh giới tin cậy: TB1 = Internet ↔ API · TB2 = API ↔ CSDL · TB3 = API ↔ bên thứ ba
```
| Luồng | Từ → Đến | Dữ liệu | Qua ranh giới | Xác thực/mã hoá |
|---|---|---|---|---|
| 1 | Client → API | thông tin đăng nhập, dữ liệu người dùng | TB1 | TLS, session/token |
| 2 | API → CSDL | mọi dữ liệu | TB2 | tài khoản tối thiểu quyền |
| 3 | API → bên thứ ba | <dữ liệu gửi đi> | TB3 | khoá API, DPA |

## 3. Kẻ tấn công giả định
| Ai | Năng lực | Mục tiêu |
|---|---|---|
| Người lạ trên Internet | gửi request tuỳ ý, tự động | lấy dữ liệu, phá dịch vụ |
| Người dùng đã đăng nhập | hợp lệ nhưng ác ý | xem/sửa dữ liệu người khác, vượt quyền |
| Bên thứ ba bị xâm nhập | kiểm soát dịch vụ 3 | tiêm dữ liệu, lộ dữ liệu |
| Nội dung không tin cậy cho AI (nếu có) | prompt injection qua tài liệu/web/tool | đổi hành vi agent |

## 4. Mối đe doạ theo luồng (STRIDE)
| ID | Luồng | STRIDE | Mối đe doạ cụ thể | Mức (Cao/TB/Thấp) | Biện pháp | Bằng chứng (test/cấu hình/scanner) | Trạng thái |
|---|---|---|---|---|---|---|---|
| TM-01 | 1 | S Spoofing | đoán/đánh cắp session | Cao | cookie HttpOnly+Secure+SameSite, xoay session sau đăng nhập, MFA cho admin | test `tests/auth/session.test.*`; header check CI | <mở/đã giảm/chấp nhận> |
| TM-02 | 1 | T Tampering | sửa payload vượt validate client | Cao | validate ở server bằng schema | test gửi payload sai → 400 | |
| TM-03 | 2 | I Information disclosure | truy vấn chéo tenant / IDOR | Cao | kiểm quyền server, RLS/ACL | test "A đọc của B" → 403 | |
| TM-04 | 1 | R Repudiation | không chứng minh được ai làm gì | TB | log kiểm toán có user, thời gian, hành động | query log kiểm toán cho hành động mẫu | |
| TM-05 | 1 | D Denial of service | spam endpoint tốn tài nguyên | TB | rate limit, timeout, kích thước body | test vượt giới hạn → 429 | |
| TM-06 | 3 | E Elevation of privilege | khoá bên thứ ba có quyền quá rộng | Cao | khoá phạm vi tối thiểu, xoay định kỳ | ảnh chụp phạm vi khoá; lịch xoay | |

## 5. Giả định và chấp nhận rủi ro
- <giả định, vd: nhà cung cấp cloud bảo vệ lớp hạ tầng> — kiểm: <...>
- Chấp nhận: TM-<NN> — lý do — người chấp nhận — ngày — xem lại: <ngày>

## 6. Hành động còn mở
| Mối đe doạ | Việc | Task/PR | Hạn |
|---|---|---|---|

## Lịch sử
| Phiên bản | Ngày | Thay đổi | Lý do |
|---|---|---|---|
````
