---
title: Chuẩn dữ liệu & quyền riêng tư (ISO 27701, GDPR, PDPL VN, NIST Privacy)
kind: standard
prefix: STD-PRIV
applies_to: [all]
updated: 2026-10-14
---

# Chuẩn dữ liệu & quyền riêng tư (ISO 27701, GDPR, PDPL VN, NIST Privacy)

> Phiên bản/văn bản hiện hành về bảo vệ dữ liệu cá nhân, chọn khung nào theo thị trường và loại dữ liệu, và bằng
> chứng máy để chứng minh tuân thủ. Nghĩa vụ chi tiết theo luật ở [`../16-compliance-privacy/`](../16-compliance-privacy/README.md)
> (Việt Nam: [`vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md)); kiểm soát kỹ thuật ở
> [`../09-database/sensitive-data-and-access.md`](../09-database/sensitive-data-and-access.md).

## Nguyên tắc

- **Luật thắng chuẩn.** ISO 27701/NIST PF là cách tổ chức; GDPR/Luật BVDLCN là nghĩa vụ. Khai báo luật áp dụng trước, chuẩn sau.
- **Dữ liệu cá nhân phải nhìn thấy được trong code.** Không chứng minh tuân thủ được nếu không biết cột nào là PII: kiểm kê dữ liệu là file trong repo, đối chiếu máy với schema.
- **Quyền của chủ thể là tính năng có test.** Truy cập, xoá, rút đồng ý… là endpoint/luồng có E2E, không phải quy trình thủ công "khi có yêu cầu".
- **Văn bản luật luôn kèm số hiệu + ngày hiệu lực + "kiểm tra văn bản sửa đổi".** Luật Việt Nam đổi nhanh (Nghị định 13/2023 → Luật 91/2025 + Nghị định 356/2025 từ 01/01/2026).

## Quyết định

| Tình huống | Văn bản/chuẩn bắt buộc khai báo | Bổ sung | Bằng chứng tối thiểu |
|---|---|---|---|
| Người dùng tại Việt Nam (mọi quy mô) | **Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15** (hiệu lực 01/01/2026) + **NĐ 356/2025/NĐ-CP** (hướng dẫn, hiệu lực 01/01/2026) | — | Kiểm kê dữ liệu; phân loại cơ bản/nhạy cảm; hồ sơ đánh giá tác động khi có dữ liệu nhạy cảm/chuyển xuyên biên giới |
| Người dùng tại EU/EEA (dù công ty ở VN) | **GDPR — Regulation (EU) 2016/679** | ISO/IEC 27701 khi L | Lawful basis per processing; DPIA (Art. 35) khi rủi ro cao; quyền chủ thể (Art. 15–22) có test |
| Khách hàng doanh nghiệp Mỹ | NIST Privacy Framework 1.0 (profile) | SOC 2 (ngoài phạm vi file này) | Profile + bảng ánh xạ kiểm soát |
| Ngành bị quản lý (y tế, tài chính, trẻ em) | luật ngành (xem gói ngành) + luật chung | ISO/IEC 27701 PIMS | DPIA bắt buộc; mã hoá at-rest; residency |
| Dữ liệu cá nhân chỉ của nhân viên nội bộ (S) | Luật 91/2025 vẫn áp dụng | — | Kiểm kê + thời hạn lưu |

Mặc định: **Luật 91/2025/QH15 + NĐ 356/2025/NĐ-CP + (GDPR nếu có người dùng EU)**; ISO/IEC 27701 chỉ khi L hoặc khách hàng yêu cầu chứng nhận.

## Bảng phiên bản hiện hành (xác minh 2026-10-13; văn bản VN đối chiếu nhà [`vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) 2026-10-14)

| Văn bản / chuẩn | Phiên bản | Hiệu lực / phát hành | URL | Áp dụng khi | Chứng minh tuân thủ |
|---|---|---|---|---|---|
| Luật Bảo vệ dữ liệu cá nhân (Việt Nam) | **91/2025/QH15** (Quốc hội thông qua 26/06/2025) | **01/01/2026** | <https://vanban.chinhphu.vn/?pageid=27160&docid=214590> · <https://bocongan.gov.vn/chinh-sach-phap-luat/co-so-du-lieu-van-ban/luat-bao-ve-du-lieu-ca-nhan-1753688803> | Mọi xử lý dữ liệu cá nhân người Việt Nam | Kiểm kê + phân loại; hồ sơ đánh giá tác động; đăng ký chuyển xuyên biên giới; **kiểm tra nghị định hướng dẫn/sửa đổi** |
| Nghị định 356/2025/NĐ-CP (hướng dẫn Luật 91/2025) | ký 31/12/2025 | **01/01/2026** — **thay NĐ 13/2023/NĐ-CP** | <https://vanban.chinhphu.vn/?pageid=27160&docid=216387> | Cùng phạm vi Luật 91/2025 | Hồ sơ đánh giá tác động xử lý + chuyển dữ liệu ra nước ngoài theo mẫu mới; chi tiết và số điều: [`vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) |
| Nghị định 13/2023/NĐ-CP | — | 01/07/2023 · **hết hiệu lực 01/01/2026** (bị NĐ 356/2025 thay) | <https://luatvietnam.vn/bai-viet-lien-quan/13-2023-nd-cp-249791.html> | Chỉ tra cứu lịch sử/hồ sơ đã nộp | Không trích trong tài liệu mới (cổng `rg "13/2023"` ở nhà 16) |
| GDPR | Regulation (EU) 2016/679 | áp dụng từ 25/05/2018 (**chưa xác minh trực tiếp** — eur-lex không trả nội dung ngày 2026-10-13) | <https://eur-lex.europa.eu/eli/reg/2016/679/oj> | Người dùng EU/EEA | RoPA (Art. 30), DPIA (Art. 35), quyền chủ thể có test |
| ISO/IEC 27701 | 2019 (bản mới 2025 **chưa xác minh** — iso.org trả 403) | 2019-08 | <https://www.iso.org/standard/71670.html> | L, chứng nhận PIMS | SoA mở rộng từ ISO 27001 |
| NIST Privacy Framework | **1.0** (1.1 đang Initial Public Draft) | 2020-01 | <https://www.nist.gov/privacy-framework> | Khách hàng Mỹ | Profile + bảng Core |

## Checklist

- [ ] `STD-PRIV-001` **MUST** Khai báo luật và chuẩn quyền riêng tư áp dụng (số hiệu + ngày hiệu lực) trong `PROJECT.md`. → Kiểm: `grep -E "91/2025/QH15|2016/679" PROJECT.md` khớp ít nhất 1. · Nguồn: Luật 91/2025/QH15; GDPR
- [ ] `STD-PRIV-002` **MUST@M** Có kiểm kê dữ liệu cá nhân (`docs/compliance/data-inventory.csv`: hệ thống, bảng/cột, loại cơ bản/nhạy cảm, mục đích, cơ sở pháp lý, thời hạn lưu) đối chiếu máy với schema. → Kiểm: script so cột gắn nhãn `pii` trong schema/migration với inventory, 0 cột thiếu. · Nguồn: Luật 91/2025/QH15 (phân loại dữ liệu); GDPR Art. 30
- [ ] `STD-PRIV-003` **MUST@L** Có hồ sơ đánh giá tác động (DPIA theo [`../templates/DPIA.md`](../templates/DPIA.md)) khi xử lý dữ liệu nhạy cảm, dữ liệu trẻ em, hoặc chuyển xuyên biên giới; ký trước khi lên production. → Kiểm: `docs/compliance/DPIA.md` tồn tại và có `approved_by` khi inventory có hàng `sensitive=true`. · Nguồn: GDPR Art. 35; Luật 91/2025/QH15 Đ.21–22 + NĐ 356/2025/NĐ-CP ([`vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md))
- [ ] `STD-PRIV-004` **MUST@M** Quyền chủ thể (truy cập, xoá, rút đồng ý, hạn chế xử lý) là luồng có E2E test. → Kiểm: test đặt tên `rights-access`, `rights-delete`, `rights-withdraw-consent` chạy trong CI. · Nguồn: Luật 91/2025/QH15 Đ.4 kh.1; GDPR Art. 15–21
- [ ] `STD-PRIV-005` **MUST@M** Thời hạn lưu theo từng loại dữ liệu được job tự động thực thi. → Kiểm: job xoá/ẩn danh có lịch; test seed bản ghi quá hạn → sau job không còn. · Nguồn: GDPR Art. 5(1)(e); Luật 91/2025/QH15 (xoá khi hết mục đích)
- [ ] `STD-PRIV-006` **MUST@L** Sự kiện đồng ý được ghi (chủ thể, mục đích, phiên bản thông báo, thời điểm, kênh) và có thể xuất. → Kiểm: bảng/log `consent_events` với cột `notice_version`; test ghi + truy xuất. · Nguồn: GDPR Art. 7(1); Luật 91/2025/QH15 (sự đồng ý)
- [ ] `STD-PRIV-007` **MUST@L** Danh mục chuyển dữ liệu xuyên biên giới (dịch vụ, quốc gia, loại dữ liệu, cơ sở pháp lý) có trong repo và đối chiếu với dependency SaaS. → Kiểm: `docs/compliance/cross-border.csv` liệt kê mọi nhà cung cấp trong `.env.example`/IaC có domain ngoài VN. · Nguồn: Luật 91/2025/QH15 (chuyển dữ liệu ra nước ngoài); GDPR Ch. V
- [ ] `STD-PRIV-008` **MUST@L** ISO/IEC 27701: SoA PIMS mở rộng từ SoA ISO 27001, mỗi kiểm soát áp dụng có bằng chứng. → Kiểm: `docs/compliance/soa-pims.csv` không hàng applicable nào thiếu `evidence`. · Nguồn: ISO/IEC 27701
- [ ] `STD-PRIV-009` **SHOULD** Thông báo quyền riêng tư công khai, có phiên bản trong repo và khớp phiên bản đang phục vụ. → Kiểm: `curl -s https://<domain>/privacy` chứa `version:` trùng hash/ngày trong `docs/legal/privacy-notice.md`.
- [ ] `STD-PRIV-010` **SHOULD** Khách hàng Mỹ: profile NIST Privacy Framework 1.0 (Identify/Govern/Control/Communicate/Protect) có bảng ánh xạ. → Kiểm: `docs/compliance/nist-pf-profile.md` tồn tại.
- [ ] `STD-PRIV-011` **SHOULD** Rà lại bảng văn bản luật ≤ 6 tháng, ghi "ngày xác minh" và văn bản sửa đổi/thay thế. → Kiểm: script cảnh báo khi `verified_at` > 180 ngày.
- [ ] `STD-PRIV-012` **MAY** Viện dẫn ISO/IEC 29100 (privacy framework) làm từ vựng chung khi làm việc với đối tác quốc tế (phiên bản **chưa xác minh**).

## Bẫy thường gặp

- **Dẫn Nghị định 13/2023 như văn bản hiện hành sau 01/01/2026.** NĐ 13/2023 đã bị NĐ 356/2025/NĐ-CP thay từ 01/01/2026; văn bản gốc là Luật 91/2025/QH15. Cách tránh: dẫn Luật 91/2025 + NĐ 356/2025 theo bảng ở [`vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md); chạy cổng `rg "13/2023"` của nhà; rà bảng 6 tháng.
- **"Ở Việt Nam nên không cần GDPR".** GDPR áp theo nơi ở của chủ thể; có người dùng EU là áp. Cách tránh: STD-PRIV-001 khai cả hai khi có traffic EU.
- **Giả danh hoá (pseudonymised) gọi là ẩn danh.** Dữ liệu còn khoá nối vẫn là dữ liệu cá nhân. Cách tránh: inventory ghi rõ kỹ thuật; test dữ liệu dùng dữ liệu tổng hợp (xem [`../14-testing-quality/test-data-and-fixtures.md`](../14-testing-quality/test-data-and-fixtures.md)).
- **PII lọt vào log/trace** (email trong URL, body request được log). Cách tránh: redaction tại logger — [`../01-baseline/errors-and-logging.md`](../01-baseline/errors-and-logging.md).
- **Đồng ý gộp một ô "tôi đồng ý tất cả".** Không tách mục đích → không hợp lệ. Cách tránh: `consent_events` theo mục đích (STD-PRIV-006).
- **Chuyển dữ liệu qua SaaS mà không biết.** Analytics, error tracking, email đều là chuyển xuyên biên giới. Cách tránh: STD-PRIV-007 đối chiếu máy với `.env.example`/IaC.
- **Mức phạt bị bỏ qua khi ước lượng rủi ro.** Theo Luật 91/2025 (nguồn thứ cấp bocongan.gov.vn, đọc 2026-10-13): tới 5% doanh thu năm liền kề với vi phạm chuyển xuyên biên giới, 10 lần khoản thu với mua bán dữ liệu — xác minh tại văn bản gốc trước khi trích vào tài liệu dự án.

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| Script đối chiếu inventory ↔ schema (tự viết; mẫu `p3_gate.py` trong catalog 23 §3.3) | `python3 scripts/check-pii-inventory.py --schema db/schema.sql --inventory docs/compliance/data-inventory.csv` | CI | 0 cột `pii` thiếu hàng |
| OPA/conftest (Apache-2.0) | `conftest test infra/ -p policy/storage.rego` (data-class, residency, mã hoá at-rest) | CI | 0 deny |
| gitleaks (MIT) | `gitleaks detect --log-opts=--all` (bắt dump dữ liệu thật commit nhầm) | CI + weekly | 0 finding |
| Microsoft Presidio (MIT) hoặc regex PII | quét mẫu log/fixture: `presidio-analyzer` trên `tests/fixtures/**` | CI nightly | 0 PII thật trong fixture/log mẫu |
| Job retention | `make retention-dry-run` → đếm bản ghi quá hạn | cron ngày | 0 bản ghi quá hạn còn lại |
| E2E quyền chủ thể | `playwright test --grep @rights` | CI | 100% xanh |

## Nguồn

- Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15 (thông qua 26/06/2025, hiệu lực 01/01/2026): <https://vanban.chinhphu.vn/?pageid=27160&docid=214590> · Bộ Công an: <https://bocongan.gov.vn/chinh-sach-phap-luat/co-so-du-lieu-van-ban/luat-bao-ve-du-lieu-ca-nhan-1753688803> — xác minh 2026-10-13 qua cổng Bộ Công an (bản gốc trên vanban.chinhphu.vn chưa mở được nội dung); kiểm tra văn bản hướng dẫn/sửa đổi trước khi áp dụng
- Nghị định 356/2025/NĐ-CP (31/12/2025, hiệu lực 01/01/2026, thay NĐ 13/2023/NĐ-CP): <https://vanban.chinhphu.vn/?pageid=27160&docid=216387> — theo nhà [`vietnam-data-law.md`](../16-compliance-privacy/vietnam-data-law.md) (xác minh 2026-10-13); NĐ 13/2023/NĐ-CP (hiệu lực 01/07/2023) **đã bị thay thế từ 01/01/2026** — chỉ tra cứu lịch sử. Đính chính 2026-10-14: bản trước ghi "tình trạng thay thế chưa xác minh".
- GDPR Regulation (EU) 2016/679: <https://eur-lex.europa.eu/eli/reg/2016/679/oj> — **(chưa xác minh trực tiếp — eur-lex không trả nội dung ngày 2026-10-13)**
- ISO/IEC 27701: <https://www.iso.org/standard/71670.html> — **(chưa xác minh — iso.org trả 403 ngày 2026-10-13)**
- NIST Privacy Framework 1.0 (1.1 IPD): <https://www.nist.gov/privacy-framework> — xác minh 2026-10-13
- Catalog `seeker19110/stored` mục 23 §3.3 (qlkh: OPA storage.rego fail-closed, `p3_gate.py`, DPIA dữ liệu trẻ em) — đọc 2026-10-13.
