---
title: DPIA — Hotel Manager
kind: dpia
version: 0.1.1
updated: 2026-10-25
status: "NHÁP KỸ THUẬT — chờ DPO/pháp lý rà, ký và nộp; chưa được dùng dữ liệu thật (PROJECT.md §6)"
---

# DPIA — Hotel Manager (SaaS quản lý nhà trọ/nhà nghỉ/khách sạn nhỏ) · phiên bản 0.1.1 · 2026-10-25

> Soạn theo mẫu khung (`.xtemplates/framework/templates/DPIA.md`) từ hiện trạng hệ thống: `docs/privacy/data-map.yaml` (từng cột),
> `docs/privacy/ROPA.md` (hoạt động), `docs/design/THREAT-MODEL.md` (rủi ro, biện pháp). **Không phải tư vấn pháp lý.** Mọi số điều,
> thời hạn nộp và biểu mẫu là (chưa xác minh) cho tới khi pháp lý đối chiếu văn bản gốc ở `PROJECT.md` §Khung pháp lý.

| Trường | Giá trị |
|---|---|
| Vai trò của tổ chức | Với dữ liệu người thuê/khách của từng cơ sở: **Bên Xử lý** thay mặt chủ cơ sở (Bên Kiểm soát) theo DPA (`docs/legal/DPA.md`). Với tài khoản nhân viên và vận hành nền tảng: **Bên Kiểm soát** (chưa xác minh — cần pháp lý) |
| Thông tin liên hệ tổ chức | chủ sở hữu `LICENSE` (seeker19110) — pháp nhân, địa chỉ, người đại diện: (chưa có — chủ dự án điền) |
| Người phụ trách bảo vệ dữ liệu (DPO) | (chưa gán — chủ dự án) |
| Căn cứ lập | Luật 91/2025/QH15 Đ.21–22 (gửi trong 60 ngày từ ngày đầu xử lý, cập nhật 6 tháng — đã đọc gốc); NĐ 356/2025/NĐ-CP Mẫu 02a/02b, Mẫu 10; Đ.38.2–3 Luật 91 + Đ.41 NĐ 356: miễn cho hộ kinh doanh/DN siêu nhỏ **không** áp dụng khi xử lý dữ liệu nhạy cảm (giấy tờ) hoặc kinh doanh dịch vụ xử lý dữ liệu; GDPR Art. 35 nếu có chủ thể EU |
| Trạng thái nộp | chưa nộp — hạn tính từ ngày bắt đầu xử lý dữ liệu thật (chưa bắt đầu) |
| Lần cập nhật kế tiếp | 6 tháng sau khi nộp, hoặc trong 10 ngày khi đổi mục đích/bên xử lý/vị trí lưu trữ (chưa xác minh) — `docs/privacy/CHANGELOG.md` nhắc |

## 1. Mô tả hoạt động xử lý
| Mục đích xử lý | Loại dữ liệu (cơ bản / nhạy cảm) | Chủ thể dữ liệu | Nguồn thu thập | Căn cứ pháp lý (đề xuất) |
|---|---|---|---|---|
| HĐ-01 Quản lý hồ sơ người thuê/khách | cơ bản: họ tên, SĐT, email, địa chỉ, quốc tịch (`persons.*`) | người thuê, khách lưu trú, người ở cùng; không chủ đích thu thập trẻ em (người ở cùng có thể là trẻ em — chưa xác minh) | nhân viên cơ sở nhập; nhập Excel/CSV | thực hiện hợp đồng thuê/lưu trú |
| HĐ-02 Giấy tờ nhận dạng cho thông báo lưu trú | nhạy cảm (theo luật VN — chưa xác minh): số CCCD/hộ chiếu mã hoá, ảnh giấy tờ (`identity_documents.*`, `files`) | khách lưu trú, người thuê | nhân viên chụp/nhập | nghĩa vụ pháp lý (thông báo lưu trú) |
| HĐ-03 Thu tiền, công nợ, cọc, đối soát | cơ bản + tài chính: số tài khoản nhận, nội dung chuyển khoản | người thuê, khách, người chuyển khoản | nhân viên; sao kê ngân hàng (CSV) | thực hiện hợp đồng; lưu chứng từ kế toán (nghĩa vụ pháp lý) |
| HĐ-04 Tài khoản, xác thực | email, mật khẩu băm Argon2id, phiên, IP/UA | nhân viên, người thuê | chủ thể tự khai | thực hiện hợp đồng dịch vụ |
| HĐ-05 Thông báo, email | email, tên, nội dung thông báo (đã che SĐT/CCCD/số tài khoản) | người thuê, nhân viên | hệ thống | thực hiện hợp đồng; **đồng ý** cho mục đích không bắt buộc (bản ghi đồng ý — Lát D đợt 23) |
| HĐ-06 Nhập dữ liệu Excel/CSV | như HĐ-01, HĐ-03 | người thuê | file của chủ cơ sở | thực hiện hợp đồng dịch vụ |
| HĐ-07 Báo cáo, xuất dữ liệu | như HĐ-01, HĐ-03 (không số giấy tờ/ảnh) | người thuê, khách | hệ thống | thực hiện hợp đồng dịch vụ |
| HĐ-08 Nhật ký kiểm toán, an ninh | người thực hiện, IP/UA, hành động | nhân viên, người thuê | hệ thống | an ninh hệ thống (cần pháp lý chọn cơ sở theo luật VN — data-map) |
| HĐ-09 Sao lưu, khôi phục | toàn bộ, ở dạng mã hoá | mọi chủ thể trên | hệ thống | an ninh hệ thống |

## 2. Sơ đồ luồng dữ liệu theo vai trò
```text
[Chủ thể: người thuê/khách] --cung cấp tại quầy/qua chủ cơ sở--> [Bên Kiểm soát: chủ cơ sở (khách hàng)]
    --nhập vào--> [Bên Xử lý: Hotel Manager — VPS tại VN: web, worker, Postgres, SeaweedFS, clamd]
        --> [Bên xử lý phụ: kho sao lưu khác máy (VN, đề xuất), SMTP relay (chưa chọn — có thể ngoài VN)]
        --> [Bên thứ ba nhận: cơ quan công an (thông báo lưu trú — do chủ cơ sở gửi, hệ thống không tự gửi)]
    Chuyển ra nước ngoài: KHÔNG ở thiết kế hiện tại; nếu SMTP relay đặt ngoài VN ⇒ cần hồ sơ đánh giá tác động chuyển dữ liệu riêng.
[Chủ thể: nhân viên] --đăng ký/lời mời--> [Bên Kiểm soát: Hotel Manager]
```

## 3. Bên nhận dữ liệu và chuyển xuyên biên giới
Nguồn: `docs/compliance/vendors.yaml`, `docs/legal/subprocessors.md`.

| Bên nhận | Vai trò | Dữ liệu | Mục đích | Quốc gia lưu trữ | Hợp đồng/DPA |
|---|---|---|---|---|---|
| Nhà cung cấp VPS | bên xử lý phụ | toàn bộ | lưu trữ, chạy dịch vụ | VN | chưa chọn |
| Kho sao lưu khác máy | bên xử lý phụ | toàn bộ (mã hoá) | sao lưu | VN (đề xuất) | chưa chọn |
| SMTP relay | bên xử lý phụ | email, tên, nội dung thông báo | gửi email | chưa chọn | chưa chọn |

## 4. Đồng ý và quyền chủ thể
- Đồng ý: bản ghi đồng ý chỉ ghi thêm theo từng mục đích (mục đích, phiên bản văn bản, thời điểm, kênh, dấu vân tay giao diện) — triển khai ở Lát D đợt 23 (CMP-RIGHTS-001, CMP-VN-001); mục đích theo hợp đồng không dựa trên đồng ý.
- Quyền chủ thể (truy cập/xuất, chỉnh sửa, xoá, rút đồng ý, hạn chế): luồng trong ứng dụng có E2E `rights-access`, `rights-delete`, `rights-withdraw-consent` (Lát D đợt 23); thời hạn xử lý cấu hình theo vùng (VN theo NĐ 356/2025 — chưa xác minh).
- Trẻ em: hệ thống không có luồng riêng; người ở cùng là trẻ em do chủ cơ sở nhập — cần pháp lý xác định yêu cầu đồng ý người giám hộ (chưa xác minh).

## 5. Thời hạn xử lý, lưu trữ và xoá
Chi tiết từng cột: `docs/privacy/data-map.yaml` (`retention`); chính sách: `docs/ops/retention-policy.md`.

| Dữ liệu | Thời hạn (đề xuất) | Căn cứ | Cơ chế xoá/ẩn danh | Bằng chứng |
|---|---|---|---|---|
| Dòng nhập Excel/CSV | 30 ngày sau commit/huỷ | tối thiểu hoá | job `import.retention` | `packages/app/src/retention/` + test DB |
| File xuất | 15 phút liên kết, xoá ≤ 24 giờ | tối thiểu hoá | job `exports.expire` | test DB |
| Hàng đợi, nhật ký gửi | 90/180 ngày | vận hành | job `events.retention` | `docs/ops/retention-policy.md` |
| Giấy tờ nhận dạng + ảnh | 12 tháng sau quan hệ lưu trú/thuê cuối (RET-17, đề xuất) | nghĩa vụ lưu trú | job `privacy.retention` ẩn danh + xoá ảnh | `packages/app/src/retention/personal.db.test.ts` |
| Hồ sơ người thuê/khách | 10 năm sau quan hệ cuối (RET-18, đề xuất) | hợp đồng; chứng từ tiền | job `privacy.retention` ẩn danh, giữ dòng và sổ tiền | `packages/app/src/retention/personal.db.test.ts` |
| Phiên, mã xác minh, link khách, thông báo | 1–180 ngày (RET-11…RET-15) | tối thiểu hoá | job `privacy.retention` xoá | `packages/app/src/retention/personal.db.test.ts` |
| Lời mời (`invitations`, email người được mời), `audit_events.before/after` (có thể chứa PII) | chưa có job dọn (lời mời); audit theo RET-06 | tối thiểu hoá; trách nhiệm giải trình | chờ quyết hạn cùng pháp lý | `docs/ops/retention-policy.md` §Điều chưa có |
| Chứng từ tiền | 10 năm (Luật Kế toán — chưa xác minh điều) | nghĩa vụ pháp lý | giữ, che PII không bắt buộc khi xoá tài khoản | Lát D đợt 23 |

## 6. Biện pháp bảo vệ
| Biện pháp | Mô tả | Bằng chứng |
|---|---|---|
| Mã hoá khi truyền / lưu | TLS (Caddy, HSTS); số giấy tờ AES-256-GCM + blind index; sao lưu mã hoá phía client | `docs/design/THREAT-MODEL.md` TM-09, TM-20; `packages/app/src/crypto/` |
| Kiểm soát truy cập, quyền tối thiểu | RLS theo tổ chức, phân quyền theo vai trò, role CSDL không superuser | THREAT-MODEL TM-01…TM-04; test cô lập tenant |
| Log kiểm toán truy cập dữ liệu nhạy cảm | `audit_events` chỉ ghi thêm (trigger chặn sửa/xoá), có IP/UA | migration `0003_command_pipeline`, `0049_audit_source` |
| Backup, khôi phục, xoá đúng hạn | pgBackRest PITR, diễn tập dữ liệu giả ở CI; job dọn theo hạn | `docs/ops/runbooks/restore.md`, `docs/ops/retention-policy.md` |
| Quy trình sự cố & thông báo vi phạm | 72 giờ (VN), bảng theo vùng, mẫu thông báo, sổ sự cố | `docs/ops/runbooks/data-breach.md`, `docs/ops/incidents/` |

## 7. Đánh giá rủi ro và biện pháp giảm thiểu
| ID | Rủi ro cho chủ thể dữ liệu | Khả năng | Mức độ nghiêm trọng | Biện pháp | Rủi ro còn lại | Trạng thái |
|---|---|---|---|---|---|---|
| DP-01 | Lộ số/ảnh giấy tờ do truy cập trái phép hoặc lỗi cô lập tổ chức | TB | Cao | RLS + test cô lập; mã hoá số giấy tờ; ảnh trong bucket riêng tư, URL ký ≤ 5 phút; TM-01, TM-05 | Thấp | giảm thiểu (chờ pentest khi có staging) |
| DP-02 | Dùng dữ liệu ngoài mục đích đã thông báo (ví dụ gửi email không bắt buộc khi chưa đồng ý) | TB | TB | bản ghi đồng ý theo mục đích; gửi kiểm đồng ý (Lát D) | Thấp | đang làm |
| DP-03 | Giữ dữ liệu quá hạn | Cao | TB | job dọn/ẩn danh theo hạn (Lát C) | TB cho tới khi pháp lý chốt hạn | đang làm |
| DP-04 | Không đáp ứng quyền chủ thể đúng hạn | TB | TB | luồng DSAR trong ứng dụng + đo quá hạn (Lát D) | Thấp | đang làm |
| DP-05 | Lộ bản sao lưu | Thấp | Cao | mã hoá phía client, khoá ngoài máy, quyền xoá tách riêng (TM-20) | Thấp | chờ hạ tầng |
| DP-06 | Chuyển dữ liệu ra nước ngoài qua SMTP relay | TB | TB | chọn relay tại VN hoặc lập hồ sơ chuyển dữ liệu; che PII trong mẫu email | TB | chờ chủ dự án chọn relay |
| DP-07 | Lộ PII qua log | TB | TB | luật Semgrep cấm log object người dùng; quét PII log E2E (CMP-PRIV-008) | Thấp | giảm thiểu (chờ quét log staging) |

## 8. Tự đánh giá tuân thủ
| Yêu cầu | Đạt / Chưa / N/A | Bằng chứng |
|---|---|---|
| Thông báo xử lý cho chủ thể trước khi xử lý | Chưa | văn bản chính sách quyền riêng tư cần pháp lý soạn; cơ chế hiển thị + bản ghi phiên bản ở Lát D |
| Đồng ý hợp lệ cho từng mục đích | Chưa | Lát D đợt 23 |
| Hợp đồng với Bên Xử lý có điều khoản bảo vệ dữ liệu | Chưa | `docs/legal/DPA.md` bản mẫu — chờ pháp lý |
| Hồ sơ nộp đúng hạn, cập nhật đúng nhịp | Chưa | chưa nộp; `docs/privacy/CHANGELOG.md` nhắc 6 tháng |
| Chuyển dữ liệu ra nước ngoài có hồ sơ riêng | N/A (thiết kế hiện tại) | phụ thuộc vị trí SMTP relay |

## 9. Tài liệu đính kèm
- `docs/privacy/ROPA.md`, `docs/privacy/data-map.yaml`, `docs/privacy/processors.md`, `docs/compliance/vendors.yaml`
- `docs/legal/DPA.md`, `docs/legal/subprocessors.md`
- `docs/ops/runbooks/data-breach.md`, `docs/ops/incidents/README.md`
- Mẫu nộp cơ quan (Mẫu 10 kèm NĐ 356/2025 — chưa xác minh): chưa điền

## 10. Ký
| Vai trò | Tên | Ngày |
|---|---|---|
| Người lập (DPO) | (chưa gán) | |
| Đại diện pháp nhân | (chưa gán) | |
| Luật sư rà | (chưa có) | |

## Lịch sử cập nhật
| Phiên bản | Ngày | Lý do | Đã nộp bản cập nhật? |
|---|---|---|---|
| 0.1.0 | 2026-10-25 | Nháp kỹ thuật đầu tiên (PLAN đợt 23, T-2307) | Chưa |
| 0.1.1 | 2026-10-25 | §5: job hạn lưu RET-11…RET-18 (T-2308); nêu khoảng trống lời mời/audit | Chưa |
