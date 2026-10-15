# PROJECT.md — Hotel Manager: nền tảng quản lý phòng trọ, nhà nghỉ, khách sạn nhỏ

> Cổng G0: chờ duyệt (người dùng) · Cổng G1: chờ duyệt · Phiên bản tài liệu: 1 (2026-10-15)
> Nguồn gốc: *Kế hoạch webapp PWA quản lý phòng trọ – khách sạn* v1.0 (15/10/2026) + workbook *Backlog và ngân sách quản lý lưu trú* (99 gói việc).
> Tài liệu này rút gọn kế hoạch thành đầu ra G0–G1 của khung; chi tiết nghiệp vụ nằm ở `docs/specs/`, thiết kế ở `docs/design/`.

## 0. Loại dự án & hồ sơ
- Hồ sơ: `web-app` (web responsive + PWA, portal người thuê/khách).
- Gói ngành: `saas-multitenant` (nhiều tổ chức, nhiều cơ sở, cách ly tenant) + `fintech` (ghi nhận tiền thật, cọc, phân bổ, đối soát, webhook ngân hàng).
  Khung chưa có gói ngành "lưu trú/khách sạn". Yêu cầu riêng của ngành lấy từ kế hoạch gốc và nằm trong SPEC.
- Quy mô: **M**. Lý do: pilot dùng người dùng thật, tiền thật và dữ liệu cá nhân, trong đó ảnh CCCD là dữ liệu nhạy cảm theo NĐ 356/2025. Đội nhỏ (4 FTE).
- Blueprint: `python3 .xtemplates/scripts/xt.py compose --profile web-app --industry saas-multitenant --industry fintech --scale M --out BLUEPRINT.md`

## 1. Vấn đề & người dùng
- **Vấn đề:** chủ trọ, nhà nghỉ và khách sạn nhỏ ở Việt Nam đang quản lý phòng, điện nước, cọc, công nợ và ca lễ tân bằng Excel, sổ tay và Zalo. Vì vậy họ mất nhiều giờ để lập kỳ thu, khó biết ai còn nợ, cọc nào phải hoàn, có phòng bị bán trùng và tiền lệch giữa các ca.
- **Người dùng mục tiêu:** chủ có 10–100 phòng ở 1–5 cơ sở (trọ, căn hộ mini, nhà nghỉ, khách sạn độc lập nhỏ, căn hộ dịch vụ), cùng nhân viên của họ (quản lý, lễ tân, kế toán, buồng phòng, kỹ thuật). Người dùng phụ là người thuê và khách lưu trú.
- **JTBD:**
  - Chủ trọ: khi đến kỳ thu, tôi muốn chốt điện nước và phát hành phiếu có kiểm tra trước, để thu đúng và biết ngay ai còn nợ.
  - Lễ tân: khi khách đến, tôi muốn nhận phòng dưới 2 phút mà không lo trùng phòng, để quầy không ùn và ca tiền khớp.
- **Hiện trạng:** Excel, sổ thu tiền, ca giấy. Baseline thời gian lập kỳ thu và check-in **chưa đo**. Thu ở tuần 1–2 bằng quan sát 6–10 người vận hành (T001 trong backlog).
- **Bằng chứng nhu cầu:** chưa có. Cổng tiếp tục sau tuần 2 dựa trên kết quả quan sát (kế hoạch §02, §23).
- **Đối thủ / tham chiếu** (xem ngày 15/10/2026, theo kế hoạch gốc S01–S04):

| Tên | URL | Họ mạnh ở | Mình khác gì (cần kiểm chứng) |
|---|---|---|---|
| LOZIDO | quanlytro.me | Trọ: hợp đồng, điện nước, cọc, app người thuê | Thuê tháng và lưu trú ngắn trên **cùng** quỹ phòng |
| ezCloudhotel | ezcloud.vn | Khách sạn: giờ/ngày, ca, buồng phòng, kênh | Mobile-first cho cơ sở nhỏ, chuyển từ Excel |
| KiotViet lưu trú | kiotviet.vn | Giá gói 220k/490k/990k | Benchmark giá; chưa suy ra khả năng chi trả |
| Cloudbeds | cloudbeds.com | Tách vệ sinh khỏi tồn bán | Học mô hình trạng thái |

## 2. Chỉ số thành công (mục tiêu nghiệm thu nội bộ, chưa phải số đã đạt)
| ID | Chỉ số (công thức) | Baseline | Mục tiêu | Hạn | Sự kiện đo |
|---|---|---|---|---|---|
| M-01 | Thời gian lập một kỳ thu cho một cơ sở (phút, từ tạo kỳ đến phát hành) so với cách làm hiện tại của chính cơ sở đó | chưa đo — tuần 1–2 | giảm ≥ 50% | tuần 16 | `billing_period.created` → `billing_period.issued` |
| M-02 | Tỷ lệ người tham gia tự hoàn thành 5 tác vụ chính sau hướng dẫn | chưa đo | ≥ 90% | tuần 12 | phiên UAT có ghi hình/ghi chép |
| M-03 | Trung vị thời gian check-in trực tiếp khi đã đủ thông tin khách | chưa đo | < 2 phút | tuần 16 | `stay.check_in_started` → `stay.checked_in` |
| M-04 | Số sai lệch tiền hoặc tồn phòng không giải thích được sau đối chiếu | — | 0 | liên tục | báo cáo đối soát / `reconciliation_break` |
| M-05 | Tỷ lệ cơ sở pilot dùng hằng tuần (≥ 1 tác vụ lõi mỗi tuần) | — | theo dõi; dùng cho quyết định sau tuần 12–16 | tuần 16 | sự kiện tác vụ lõi theo `property_id` |

Mục tiêu pilot: ≥ 6 cơ sở (3 trọ, 2 khách sạn, 1 căn hộ dịch vụ). Tuần 12 chỉ mở cho cơ sở đã đạt cổng. Mô hình lai bắt đầu thử từ tuần 16.

## 3. Phạm vi (MoSCoW) — Must = pilot tuần 12; Should = V1 tuần 24
| ID | Tính năng | Mức | Spec | Backlog gốc |
|---|---|---|---|---|
| F-001 | Tổ chức, cơ sở, phòng; thành viên, vai trò, phạm vi cơ sở; MFA nhân viên nhạy cảm | Must | `docs/specs/SPEC-access-and-property.md` | T002, T005, T010–T013, T017 |
| F-002 | Lịch tài nguyên: allocation chống chồng ở DB, hold có hạn, block bảo trì, trạng thái phòng 3 chiều | Must | `docs/specs/SPEC-inventory-allocation.md` | T018–T022, T024 |
| F-003 | Hợp đồng thuê: phiên bản điều khoản, người ở, bàn giao, gia hạn, thanh lý | Must | `docs/specs/SPEC-lease.md` | T025–T027, T031, T032 |
| F-004 | Dịch vụ định kỳ, công tơ, kỳ thu xem trước → phát hành | Must | `docs/specs/SPEC-metering-billing.md` | T028–T030 |
| F-005 | Sổ tiền: phiếu, nhận tiền, phân bổ, cọc, hoàn/đảo, QR, đối soát thủ công, chốt kỳ | Must | `docs/specs/SPEC-ledger-payments.md` | T033–T040 |
| F-006 | Khách sạn cơ bản: loại phòng, giá ngày/đêm, booking trực tiếp có giữ chỗ, nhận/trả phòng, folio, cọc | Must | `docs/specs/SPEC-reservation-stay.md` | T049–T054, T056 |
| F-007 | Buồng phòng và phiếu sự cố/sửa chữa tối thiểu | Must | `docs/specs/SPEC-housekeeping-maintenance.md` | T045, T055 |
| F-008 | Portal người thuê/khách: xem kỳ thu, hợp đồng, cọc; gửi yêu cầu | Must | `docs/specs/SPEC-portal.md` | T044 |
| F-009 | PWA: cài đặt, app shell, báo rõ khi mất mạng (pilot chỉ chạy online) | Must | `docs/specs/SPEC-pwa.md` | T041, T042, T048 |
| F-010 | Import Excel/CSV có xem trước, lỗi từng dòng, chống import lặp | Must | `docs/specs/SPEC-import.md` | T023 |
| F-011 | Thông báo trong app + email qua outbox; nhắc quá hạn | Must | `docs/specs/SPEC-notifications.md` | T015, T046, T047 |
| F-012 | Nhật ký audit, báo cáo thu/nợ/cọc, xuất dữ liệu | Must | `docs/specs/SPEC-audit-reporting.md` | T014, T039 |
| F-013 | Giá giờ, sớm/muộn, dịch vụ, booking nhiều dòng, chuyển phòng, ca quầy, night audit | Should | (viết ở đợt V1) | T057–T065 |
| F-014 | Offline nháp (công tơ, phiếu việc, buồng phòng) có xử lý xung đột | Should | (đợt V1) | T043 |
| F-015 | Vòng đời thuê bao SaaS, gói, quota; hỗ trợ truy cập tạm thời | Should | (đợt V1) | T069–T071, T097, T098 |
| F-016 | Adapter một ngân hàng/HĐĐT khi có hợp đồng; booking engine phạm vi hẹp | Could | (đợt V1) | T072 |

Nỗ lực: các gói P0 trong backlog là 224/343 ngày công, tức **65% nằm ở Must**, vượt ngưỡng ≤ 60% mà khung khuyến nghị (`PM-*`). Tôi đề xuất giữ nguyên vì kế hoạch gốc đã tách V1 ra khỏi pilot. Nếu trễ thì cắt F-007, F-008 và F-011 xuống mức tối thiểu trước; không cắt test tiền/tồn (kế hoạch §19).

### Không làm (Won't — trong V1)
- Bán theo giường; bán theo loại phòng khi chưa gán phòng cụ thể. Lý do: MVP gán phòng ngay để bảo đảm chống trùng bằng constraint.
- OTA/channel manager, khoá thông minh/IoT, AI (trừ thử OCR công tơ có người duyệt), Zalo, ký điện tử. Lý do: cần hợp đồng đối tác và bằng chứng nhu cầu sau tuần 24.
- Resort lớn, POS nhà hàng, tiệc, kế toán tổng hợp/sổ cái pháp định, payroll, marketplace, app native.
- Tự động khai báo lưu trú với cơ quan nhà nước. V1 chỉ nhắc hạn và xuất đúng mẫu đã xác minh.
- Lưu số thẻ/CVV.

## 4. Luồng người dùng chính (bắt buộc có E2E)
1. **R-001 Kỳ thu trọ:** tạo kỳ → nhập công tơ theo tầng → cảnh báo bất thường → duyệt → xem trước từng phòng và tổng → phát hành phiếu → người thuê xem trên portal → thu (QR + xác nhận có chứng cứ) → phân bổ → công nợ cập nhật.
2. **R-002 Vòng đời hợp đồng:** phòng trống → giữ chỗ → cọc → hợp đồng + người ở → bàn giao (tài sản, chỉ số đầu) → thu theo kỳ → gia hạn hoặc thanh lý (chốt nợ, khấu trừ/hoàn cọc).
3. **R-003 Khách sạn trực tiếp:** tìm phòng theo thời gian → báo giá → giữ chỗ có hạn → xác nhận/cọc → gán phòng → nhận phòng → ghi dịch vụ → rà folio → thanh toán → trả phòng → tạo việc dọn.
4. **R-004 Tranh chấp phòng cuối:** hai lễ tân cùng giữ một phòng trong cùng khoảng thời gian → đúng một người thành công, người còn lại nhận thông báo hết phòng.
5. **R-005 Chuyển dữ liệu:** import phòng, người ở, số dư cọc/nợ đầu kỳ từ Excel → xem trước → xác nhận → đối chiếu tổng.

## 5. Yêu cầu phi chức năng
| Nhóm | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| Hiệu năng API | p95 < 800 ms cho API thường; p95 tạo giữ phòng < 1,5 s ở tải kiểm thử | Kế hoạch §17 | k6 với bộ dữ liệu 100 tổ chức, 5.000 phòng, 200 phiên đồng thời |
| Hiệu năng web | LCP p75 < 2,5 s trên thiết bị và mạng mục tiêu | Kế hoạch §17; Core Web Vitals | Lighthouse CI + RUM |
| Đồng thời | 100 lệnh tranh một phòng → tối đa 1 allocation; cùng payload gửi 100 lần → 1 hiệu lực | Kế hoạch §13 | test tích hợp trên Postgres thật |
| Sẵn sàng | SLO 99,9%/tháng cho luồng server lõi (chưa phải SLA) | Kế hoạch §17 | uptime + error budget |
| Phục hồi | Production: RPO DB ≤ 15 phút, RTO ≤ 4 giờ, file RPO ≤ 24 giờ — chỉ công bố sau diễn tập | Kế hoạch §17 | diễn tập restore |
| Bảo mật | Khung blueprint M + ASVS 5.0 L2 cho luồng tiền/quyền | blueprint | CI + pentest có trọng tâm (tuần 21–22) |
| Tiếp cận | WCAG 2.2 AA cho luồng chính; vùng chạm ≥ 44 CSS px | Kế hoạch §09 | axe trong E2E + kiểm tay |
| Thiết bị | Safari iPhone (iOS ≥ 16.4), Chrome Android, Chrome/Edge desktop, chế độ cài PWA | Kế hoạch §10 | ma trận E2E + thiết bị thật |
| Ngôn ngữ/định dạng | Tiếng Việt; VND số nguyên; múi giờ cơ sở (mặc định Asia/Ho_Chi_Minh) | Kế hoạch §12 | test đơn vị |

## 6. Dữ liệu & pháp lý
- **Dữ liệu cá nhân:** có. Dữ liệu cơ bản gồm họ tên, SĐT, email, địa chỉ. Ảnh/số CCCD và hộ chiếu là dữ liệu **nhạy cảm** theo NĐ 356/2025 → giảm thu thập, che, lưu file riêng tư, cấm cache offline.
- **Tiền thật:** có ghi nhận tiền (QR chuyển khoản, tiền mặt, cọc). Hệ thống **không giữ tiền** và không chạm dữ liệu thẻ.
- **Luật áp dụng** (danh sách xác minh ở `docs/research/2026-10-15-stack-va-phap-ly.md`): Luật BVDLCN 91/2025/QH15 + NĐ 356/2025/NĐ-CP; Luật Cư trú 68/2020/QH14 (thông báo lưu trú); quy định khai báo tạm trú cho người nước ngoài; NĐ về hoá đơn điện tử (kế hoạch ghi NĐ 254/2026, cần đối chiếu); quy định giá bán điện cho người thuê nhà; Luật An ninh mạng 116/2025.
- **DPIA:** bắt buộc trước khi dùng dữ liệu thật → `docs/DPIA.md` (T-0xx trong PLAN, cần người phụ trách pháp lý duyệt).

## 7. Stack & kiến trúc (tóm tắt — chi tiết ở ADR-0001)
Modular monolith TypeScript: Next.js (web + API) và một worker Node chạy chung codebase; PostgreSQL 17 **tự host** (sao lưu pgBackRest có PITR); đăng nhập + MFA bằng Better Auth trong app; file ở SeaweedFS; Caddy; email qua SMTP relay; SQL migrations; hàng đợi bền và outbox nằm trong Postgres. Chi tiết: ADR-0001 và ADR-0002 (tự host).

## 8. Giả định, rủi ro, ràng buộc
| Giả định nguy hiểm | Cách kiểm chứng | Hạn | RK |
|---|---|---|---|
| Chủ trọ sẵn sàng trả 149–499k/tháng | pilot trả tiền, phỏng vấn | tuần 12–24 | R11 |
| Thuê tháng và lưu trú ngắn dùng chung một mô hình allocation mà không trộn vòng đời | test xung đột + UAT mô hình lai | tuần 16 | R06 |
| Quy tắc prorata, làm tròn và giờ kinh doanh có thể cấu hình mà không cần mã riêng cho từng cơ sở | quan sát 6–10 cơ sở + mẫu hoá đơn | tuần 2 | R08 |
| Đội 4 FTE đủ cho pilot tuần 12 | burn-down theo mốc | tuần 10 | R08 |

- **Ràng buộc cứng:** không gửi dữ liệu thật vào môi trường dev; tiền VND là số nguyên; một nguồn sự thật cho tồn và tiền trong giai đoạn chạy song song.
- **Ngân sách** (giả định kế hoạch): 798 triệu – 1,33 tỷ đồng cho 24 tuần, 4 FTE, đã gồm 20% dự phòng; hạ tầng pilot 80–180 USD/tháng.
- **Hạn:** chưa có hạn thật. Các tuần là tương đối, tính từ ngày đội khởi động.

## 9. Các bên
| Vai trò | Tên | Quyết định gì |
|---|---|---|
| Product Owner | (chưa gán) | phạm vi, ngưỡng nghiệm thu, quy tắc nghiệp vụ |
| Tech Lead | (chưa gán) | schema, transaction, sổ giao dịch |
| Pháp lý/kế toán | (chưa gán) | PII, ghi nhận doanh thu, thuế, khai báo lưu trú |
| Đại diện pilot | (chưa gán) | UAT, xác nhận số dư chuyển đổi |

## 10. Câu hỏi mở
Danh sách đầy đủ ở mục "Câu hỏi mở" của từng SPEC. Các câu chặn chính:
- [ ] Quy tắc prorata cho kỳ đầu/cuối lẻ ngày (theo ngày thực của tháng hay chia 30) — [chặn F-004] — hỏi: PO
- [ ] Quy tắc làm tròn tiền (đến 1 đ hay 1.000 đ; làm tròn từng dòng hay tổng) — [chặn F-004/F-005] — hỏi: PO + kế toán
- [ ] Giờ nhận/trả phòng và giờ chốt ngày kinh doanh mặc định — [chặn F-006] — hỏi: PO
- [ ] Ghi nhận doanh thu (khi phát hành phiếu hay khi kỳ kết thúc) — [không chặn pilot, chặn báo cáo doanh thu] — hỏi: kế toán
- [ ] Giấy phép mã nguồn của sản phẩm — [không chặn] — hỏi: chủ dự án
