# PROJECT.md — Hotel Manager: nền tảng quản lý phòng trọ, nhà nghỉ, khách sạn nhỏ

> Cổng G0: duyệt bởi chủ dự án 2026-10-15 · Cổng G1: duyệt 2026-10-15 · Phiên bản tài liệu: 1 (2026-10-15)
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

Nỗ lực: các gói P0 trong backlog là 224/343 ngày công, tức **65% nằm ở Must**, vượt ngưỡng ≤ 60% mà khung khuyến nghị.

> **Lệch kế hoạch gốc — chủ dự án đã chọn (ghi ở [`SCOPE.md`](SCOPE.md)).** Kế hoạch §04/§19 để gia hạn/thanh lý đầy đủ, phân bổ thanh toán, khoá kỳ và portal mở rộng (hợp đồng, công tơ, tiến độ) ở **V1**, nghiệm thu tuần 13–16; pilot tuần 12 xử lý các việc đó bằng chứng từ tối thiểu có người duyệt. Bảng trên đang theo **backlog** (các gói T031, T032, T035, T040, T044 là P0 tuần 9–12). Hai nguồn của chính kế hoạch lệch nhau; **chủ dự án chọn theo backlog (2026-10-15)** — pilot đầy đủ hơn, rủi ro trễ cao hơn. Nếu trễ: cắt F-007, F-008, F-011 xuống tối thiểu trước; không cắt test tiền/tồn (kế hoạch §19).

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

## 5. Yêu cầu phi chức năng (theo đặc tính chất lượng ISO/IEC 25010:2023)
Chín đặc tính của ISO/IEC 25010:2023; mỗi hàng có ngưỡng đo được hoặc ghi rõ "không áp dụng". Ngưỡng là mục tiêu nghiệm thu, chưa phải số đã đạt; số đã đo nằm ở `docs/ops/SLO.md` và kết quả CI.

| Đặc tính (25010:2023) | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| Hiệu năng (performance efficiency) | API thường p95 < 800 ms; tạo giữ phòng p95 < 1,5 s ở tải kiểm thử; web LCP p75 < 2,5 s trên thiết bị và mạng mục tiêu | Kế hoạch §17; Core Web Vitals | k6 với bộ dữ liệu 100 tổ chức, 5.000 phòng, 200 phiên đồng thời; Lighthouse CI + RUM (chưa có — `docs/autopilot/BLUEPRINT-GAPS.md`) |
| Độ tin cậy (reliability) | SLO 99,9%/tháng cho luồng server lõi (chưa phải SLA); production: RPO DB ≤ 15 phút, RTO ≤ 4 giờ, RPO file ≤ 24 giờ — chỉ công bố sau diễn tập | Kế hoạch §17 | uptime + error budget (`docs/ops/SLO.md`); diễn tập restore (`scripts/db-backup-restore-check.sh`) |
| Bảo mật (security) | ASVS 5.0.0 L2 cho luồng tiền/quyền; 0 truy cập chéo tổ chức | blueprint M; kế hoạch §16 | CI + bộ kiểm cách ly tenant + pentest có trọng tâm (tuần 21–22) |
| Phù hợp chức năng (functional suitability) | 100 lệnh tranh một phòng → tối đa 1 allocation; cùng payload gửi 100 lần → 1 hiệu lực; tiền VND số nguyên; múi giờ cơ sở (mặc định Asia/Ho_Chi_Minh) | Kế hoạch §12, §13 | test tích hợp trên Postgres thật; test đơn vị |
| Khả năng tương tác với người dùng (interaction capability) | WCAG 2.2 AA cho luồng chính; vùng chạm ≥ 44 CSS px; tiếng Việt | Kế hoạch §09, §12 | axe trong E2E + kiểm tay |
| Tương thích (compatibility) | Cùng tồn tại với hạ tầng tự host (Postgres 17, SeaweedFS, Caddy) theo phiên bản ghim; webhook/CSV theo hợp đồng `docs/design/API-CONTRACT.md` | ADR-0002 | test hợp đồng + `apps/web/openapi.json` sinh từ nguồn |
| Khả năng bảo trì (maintainability) | 0 vòng phụ thuộc mới giữa module `packages/app`; typecheck/lint 0 lỗi; mọi ADR đủ mục bắt buộc | ADR-0001 | `arch-guards.test.ts`, cổng `lint`/`typecheck`, `scripts/process-docs.test.mjs` |
| Tính linh hoạt (flexibility) | Safari iPhone (iOS ≥ 16.4), Chrome Android, Chrome/Edge desktop, chế độ cài PWA | Kế hoạch §10 | ma trận E2E + thiết bị thật |
| An toàn (safety) | Không áp dụng — V1 không điều khiển thiết bị vật lý (khoá thông minh/IoT nằm ngoài V1, mục "Không làm"); xem lại khi thêm IoT | PROJECT §3 | — |

## 6. Dữ liệu & pháp lý
- **Dữ liệu cá nhân:** có. Dữ liệu cơ bản gồm họ tên, SĐT, email, địa chỉ. Ảnh/số CCCD và hộ chiếu được xếp là dữ liệu **nhạy cảm** theo NĐ 356/2025 [T — nguồn thứ cấp, chưa đối chiếu văn bản gốc; thiết kế vẫn bảo vệ ở mức nhạy cảm] → giảm thu thập, che, lưu file riêng tư, cấm cache offline.
- **Phân loại dữ liệu** (BASE-SEC-013). Phân loại **theo từng cột** nằm ở [`docs/privacy/data-map.yaml`](docs/privacy/data-map.yaml) (mục đích, cơ sở pháp lý đề xuất, hạn giữ, nơi lưu, bên xử lý); test `packages/app/src/privacy/data-map.db.test.ts` đối chiếu với catalog CSDL — cột có tên mẫu PII chưa khai thì đỏ. Giá trị phân loại dùng trong sổ đó:

| Lớp (`classification`) | Gồm | Xử lý bắt buộc | Ví dụ |
|---|---|---|---|
| `nhay_cam` | số và ảnh giấy tờ nhận dạng, số tài khoản nhận tiền | mã hoá AES-256-GCM tầng ứng dụng (D-004) hoặc file riêng tư ở bucket không công khai; chỉ hiển thị bản che; không vào log; không cache offline | `identity_documents.doc_number_enc`, ảnh giấy tờ |
| `xac_thuc` | mật khẩu đã băm, secret TOTP, mã dự phòng, token và băm token | không bao giờ trả ra API/log; chỉ lưu dạng băm hoặc do Better Auth quản lý; xoay theo `docs/ops/runbooks/secret-leak.md` | `auth.account.password`, `guest_access_links.token_hash` |
| `co_ban` | họ tên, SĐT, email, địa chỉ | RLS theo tổ chức; che SĐT/email trong log và thông báo; ẩn danh hoá khi xoá người (`persons.anonymized_at`) | `persons.full_name`, `persons.phone` |
| không phải PII (`not_pii`) | cột trùng tên mẫu PII nhưng không chứa dữ liệu cá nhân, kèm lý do | không cần | khai ở mục `not_pii` của sổ |

  Tối thiểu hoá: không lưu ảnh giấy tờ khi lưu trú (D-002); hạn giữ từng cột ghi ở sổ, nhiều hạn chưa chốt vì chờ DPIA (`docs/RISKS.md` RK-019).
- **Tiền thật:** có ghi nhận tiền (QR chuyển khoản, tiền mặt, cọc). Hệ thống **không giữ tiền** và không chạm dữ liệu thẻ.
- **Luật áp dụng:** bảng "Khung pháp lý" ngay dưới (PM-RISK-007, tra nguồn sống 2026-10-25). Ghi chú cũ ở `docs/research/2026-10-15-stack-va-phap-ly.md` (mức [T]) chỉ còn giá trị lịch sử.

### Khung pháp lý (xác minh 2026-10-25 — kiểm tra văn bản sửa đổi trước khi dùng)
Mức bằng chứng: **gốc** = đã đọc toàn văn bản PDF ký số trên datafiles.chinhphu.vn (đúng điều ghi); **meta** = chỉ số hiệu/ngày từ vanban/congbao.chinhphu.vn; **thứ cấp** = báo/bài tổng hợp. Mọi số điều không ghi "gốc" là (chưa xác minh). **Không phải tư vấn pháp lý.**

| Văn bản | Hiệu lực | Tình trạng (2026-10-25) | Vì sao áp dụng | Mức | Nguồn |
|---|---|---|---|---|---|
| Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 (26/6/2025) | 01/01/2026 | còn hiệu lực | xử lý dữ liệu người thuê/khách/nhân viên; Đ.20 chuyển xuyên biên giới (hồ sơ trong 60 ngày), Đ.21–22 đánh giá tác động (60 ngày, cập nhật 6 tháng), Đ.23.1 báo vi phạm **72 giờ**, Đ.38.2–3 miễn cho DN nhỏ/siêu nhỏ trừ khi xử lý dữ liệu nhạy cảm hoặc kinh doanh dịch vụ xử lý dữ liệu | gốc | https://datafiles.chinhphu.vn/cpp/files/vbpq/2025/7/91qh.signed.pdf |
| NĐ 356/2025/NĐ-CP (31/12/2025) | 01/01/2026 | còn hiệu lực; Đ.42.2 chấm dứt NĐ 13/2023 | hướng dẫn Luật 91; Phụ lục: **Mẫu 08** thông báo vi phạm, Mẫu 02a/02b gửi hồ sơ đánh giá tác động, Mẫu 10 báo cáo đánh giá; thời hạn xử lý yêu cầu chủ thể (xác nhận rút đồng ý 2 ngày làm việc; dừng 15 ngày; truy cập/sửa 10 ngày; xoá 20 ngày — **thứ cấp**, số điều chưa xác minh) | gốc (Đ.9–11, 34–42, Phụ lục) | https://datafiles.chinhphu.vn/cpp/files/vbpq/2026/01/356-nd.signed.pdf |
| NĐ 330/2026/NĐ-CP (19/8/2026) | 19/8/2026 | còn hiệu lực | xử phạt vi phạm an ninh mạng và bảo vệ dữ liệu cá nhân | meta | https://vanban.chinhphu.vn/?pageid=27160&docid=219266 |
| Luật An ninh mạng 116/2025/QH15 (10/12/2025) | 01/7/2026 | còn hiệu lực; Đ.44.2 chấm dứt Luật ANM 24/2018 và Luật ATTTM 86/2015 | an ninh hệ thống thông tin, lưu trữ dữ liệu | gốc (Đ.44–45) | https://datafiles.chinhphu.vn/cpp/files/vbpq/2026/01/luat116-2025.pdf |
| NĐ 333/2026/NĐ-CP (19/8/2026) | 19/8/2026 | còn hiệu lực | Đ.19 lưu tại VN thông tin cá nhân người dùng tại VN và dữ liệu do người dùng tạo (tài khoản, email, IP đăng nhập, SĐT); Đ.20.1 lưu tối thiểu 24 tháng kể từ khi có yêu cầu; Đ.22 **nhật ký hệ thống ≥ 12 tháng** | gốc (Đ.17–20, 23–24, 28–32) | https://datafiles.chinhphu.vn/cpp/files/vbpq/2026/8/333_2026_nd-cp_19082026-signed.signed.pdf |
| Luật Cư trú 68/2020/QH14, Đ.30 sửa bởi Luật 118/2025/QH15 Đ.4.9 | 01/7/2026 | còn hiệu lực | cơ sở lưu trú thông báo lưu trú: họ tên, ngày sinh, số định danh/hộ chiếu, lý do, thời gian, địa chỉ — **trước 23 giờ** ngày bắt đầu (đến sau 23 giờ: trước 08 giờ hôm sau) | gốc (Đ.4.9 Luật 118) | https://datafiles.chinhphu.vn/cpp/files/vbpq/2026/01/luatso118.2025.pdf |
| TT 116/2026/TT-BCA (29/6/2026) | 01/7/2026 | còn hiệu lực; thay TT 55/2021, 56/2021 (thứ cấp) | chi tiết thi hành Luật Cư trú (kênh thông báo lưu trú) | meta | https://congbao.chinhphu.vn/van-ban/thong-tu-so-116-2026-tt-bca-470078.htm |
| Luật 47/2014/QH13 (người nước ngoài; sửa đến Luật 118/2025 Đ.2) | — | còn hiệu lực | khai báo tạm trú khách nước ngoài (điều cụ thể chưa xác minh) | gốc (lời dẫn) | https://datafiles.chinhphu.vn/cpp/files/vbpq/2026/01/luatso118.2025.pdf |
| Luật Kế toán 88/2015/QH13 | 01/01/2017 | còn hiệu lực (sửa đổi Đ.41 chưa xác minh) | Đ.41.5: chứng từ kế toán, sổ, báo cáo tài chính năm lưu **10 năm** ⇒ giữ chứng từ tiền khi xoá/ẩn danh | gốc (Đ.40–42) | https://datafiles.chinhphu.vn/cpp/files/vbpq/2016/01/88.signed.pdf |
| NĐ 174/2016/NĐ-CP | 01/01/2017 | còn hiệu lực (VBHN 02/VBHN-BTC — thứ cấp) | chi tiết lưu trữ tài liệu kế toán | meta | https://vanban.chinhphu.vn/default.aspx?pageid=27160&docid=187897 |
| NĐ 123/2020/NĐ-CP, sửa bởi NĐ 70/2025/NĐ-CP | 01/7/2022; 01/6/2025 | còn hiệu lực | hoá đơn, chứng từ (phiếu thu) | meta / thứ cấp | https://vanban.chinhphu.vn/?pageid=27160&docid=201365 |
| Luật Giao dịch điện tử 20/2023/QH15 | 01/7/2024 | còn hiệu lực | hợp đồng, chứng từ điện tử | meta | https://vanban.chinhphu.vn/?pageid=27160&docid=208421 |
| Luật Bảo vệ quyền lợi người tiêu dùng 19/2023/QH15 | 01/7/2024 | còn hiệu lực | người thuê/khách là người tiêu dùng của cơ sở | meta | https://vanban.chinhphu.vn/?pageid=27160&docid=208363 |
| Bộ luật Dân sự 91/2015/QH13 | 01/01/2017 | còn hiệu lực | hợp đồng thuê tài sản | thứ cấp | https://vanban.chinhphu.vn/default.aspx?pageid=27160&docid=183188 |
| Luật Nhà ở 27/2023/QH15 (hiệu lực sớm bởi Luật 43/2024) | 01/8/2024 (thứ cấp) | còn hiệu lực | cho thuê nhà ở/phòng trọ | meta | https://congbao.chinhphu.vn/van-ban/luat-so-27-2023-qh15-40856/47842.htm |
| NĐ 52/2024/NĐ-CP (thanh toán không dùng tiền mặt) | 01/7/2024 | còn hiệu lực | hiển thị VietQR, không giữ tiền — có cần giấy phép trung gian thanh toán hay không: (chưa xác minh — cần pháp lý) | meta | https://vanban.chinhphu.vn/?pageid=27160&docid=210262 |

**Đã hết hiệu lực — không dẫn làm căn cứ:** NĐ 13/2023/NĐ-CP (từ 01/01/2026, NĐ 356/2025 Đ.42.2 — gốc); Luật An ninh mạng 24/2018/QH14 (từ 01/7/2026, Luật 116/2025 Đ.44.2 — gốc); NĐ 53/2022/NĐ-CP (tình trạng chưa xác minh — NĐ 333/2026 không có điều bãi bỏ rõ). Theo dõi sửa đổi: nghị định hướng dẫn thêm của Luật 91/2025, thủ tục gửi hồ sơ đánh giá tác động của Bộ Công an, dự thảo sửa Luật Kế toán, thông tư hướng dẫn NĐ 52/2024, Luật Căn cước 26/2023 (sửa bởi Luật 118/2025 Đ.5).
- **DPIA:** bắt buộc trước khi dùng dữ liệu thật → `docs/DPIA.md` (0.1.0 nháp kỹ thuật, 2026-10-25; DPO/pháp lý rà, ký, nộp theo Mẫu 02a/02b + Mẫu 10 của NĐ 356/2025 trong 60 ngày kể từ ngày đầu xử lý — việc của **người**; chặn dữ liệu thật).

### Dữ liệu test
**Cấm** đưa dump/export dữ liệu production (hoặc dữ liệu thật của khách) vào repo, CI, staging hay máy dev. Fixture/seed chỉ dùng dữ liệu giả: email domain dành riêng (`example.test`…), SĐT dải mẫu `0100000NNN`. Danh sách cho phép và rào máy: [`docs/compliance/test-data.md`](docs/compliance/test-data.md).

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
- **Ngân sách** (giả định kế hoạch): 798 triệu – 1,33 tỷ đồng cho 24 tuần, 4 FTE, đã gồm 20% dự phòng; hạ tầng: kế hoạch gốc ước 80–180 USD/tháng theo Supabase; với tự host (ADR-0002) cần ước lại theo báo giá VPS tại VN + kho sao lưu + SMTP relay (chưa có báo giá).
- **Hạn:** chưa có hạn thật. Các tuần là tương đối, tính từ ngày đội khởi động.

## 9. Các bên
| Vai trò | Tên | Quyết định gì |
|---|---|---|
| Product Owner | (chưa gán) | phạm vi, ngưỡng nghiệm thu, quy tắc nghiệp vụ |
| Tech Lead | (chưa gán) | schema, transaction, sổ giao dịch |
| Pháp lý/kế toán | (chưa gán) | PII, ghi nhận doanh thu, thuế, khai báo lưu trú |
| Đại diện pilot | (chưa gán) | UAT, xác nhận số dư chuyển đổi |

## 10. Câu hỏi mở
Danh sách đầy đủ ở mục "Câu hỏi mở" của từng SPEC. Ba câu chặn pilot đã quyết (đóng theo PM-REQ-019):
- [x] Quy tắc prorata cho kỳ đầu/cuối lẻ ngày (theo ngày thực của tháng hay chia 30) — F-004 — **Quyết 2026-10-15 (duyệt PLAN đợt 2, chủ dự án):** `actual_days` (giá × ngày tính / ngày thực của tháng, tính cả ngày đầu và cuối); đổi được sang `fixed_30` bằng `properties.settings.prorata`; chứng từ lưu quy tắc đã dùng (SPEC-metering-billing, `docs/autopilot/archive/PLAN-dot-2.md`)
- [x] Quy tắc làm tròn tiền (đến 1 đ hay 1.000 đ; làm tròn từng dòng hay tổng) — F-004/F-005 — **Quyết 2026-10-15 (duyệt PLAN đợt 2, chủ dự án):** `HALF_UP_1` từng dòng, tổng = Σ dòng; đổi được sang `HALF_UP_1000` bằng `properties.settings.rounding`; chứng từ lưu quy tắc đã dùng
- [x] Giờ nhận/trả phòng và giờ chốt ngày kinh doanh mặc định — F-006 — **Quyết D-002 (2026-10-16, phiên chính tự duyệt):** nhận 14:00, trả 12:00 khi cơ sở chưa đặt; giờ chốt ngày = `properties.business_day_cutoff` (SPEC-reservation-stay Q-01, SPEC-access-and-property Q-01/Q-03). Chủ dự án xem lại/đổi ý lúc nào cũng được; đổi giá trị không cần migration

Còn mở, không chặn pilot:
- [ ] Ghi nhận doanh thu (khi phát hành phiếu hay khi kỳ kết thúc) — chặn báo cáo doanh thu, không chặn pilot — hỏi: kế toán
- [ ] Giấy phép mã nguồn của sản phẩm — hỏi: chủ dự án
