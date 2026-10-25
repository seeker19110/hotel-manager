# Hướng dẫn làm toàn bộ việc còn lại — Hotel Manager

> Lập 2026-10-24, sau khi merge #131 (`main` = `d504ee7`). Còn **89 MUST** mở; agent không tự làm được mục nào trong số này.
> Mỗi mục cần một trong bốn thứ: tài khoản/quyền GitHub, tiền/hạ tầng, quyết định sản phẩm/pháp lý, hoặc kiểm tay.
> Mỗi nhóm có ba phần:
> - **Bạn làm:** việc của bạn.
> - **Rồi nhắn agent:** câu gửi phiên agent sau khi bạn làm xong, để agent làm phần trong repo và tick kèm bằng chứng.
> - **Kiểm:** cách tự xác nhận.
>
> Chi tiết gốc nằm ở `docs/autopilot/BLUEPRINT-GAPS.md`, mục "Kết quả đợt 9 (a)".

Thứ tự đề xuất: **0 → A → B → C → D → E**. Bước sau phụ thuộc bước trước; trong cùng một bước, các nhóm làm song song được.

---

## Bước 0 — Hạn gấp (làm trong tuần này)

### 0.1 Luật grype — **đã xử lý** (2026-10-25, D-110)
- Caddy và SeaweedFS giờ **tự dựng** từ mã nguồn bằng Go đã vá trên Alpine cập nhật (`deploy/caddy/`, `deploy/seaweedfs/`, ADR-0006), nên đã gỡ 24 luật bỏ qua của hai image này, gồm toàn bộ luật Critical.
- Còn 5 luật High, đều không vào bản chạy production:
  - npm đi kèm image node, hạn **2026-11-01** và **2026-11-08**;
  - `zod` 3 chỉ dùng trong lighthouse của CI, hạn **2026-11-08**.

  Đến hạn, agent kiểm image node mới hoặc gia hạn kèm lý do (D-067).
- **Bạn làm:** không cần làm gì. Khi có VPS (Bước C1), image production phải dựng từ chính các Dockerfile này: `docker compose build`.

### 0.2 `release-please` đỏ trên `main` từ #93
1. GitHub → Settings → Developer settings → Fine-grained tokens. Sửa token đang dùng làm secret `RELEASE_PLEASE_TOKEN` (hoặc tạo token mới), chỉ cho repo `hotel-manager`:
   - **Contents: Read and write**
   - **Pull requests: Read and write**
2. Repo → Settings → Secrets and variables → Actions → cập nhật `RELEASE_PLEASE_TOKEN`.
3. Repo → Settings → Actions → General → bật **Allow GitHub Actions to create and approve pull requests**.
4. Actions → workflow **Release** → *Run workflow* trên `main`.
5. Xoá nhánh mồ côi `release-please--branches--main--components--hotel-manager` nếu nó còn và bạn không cần.
- **Kiểm:** workflow Release xanh; có Release PR mới do release-please mở.

---

## Bước A — Việc trong GitHub, mỗi việc ≤ 30 phút (11 MUST)

### A1. Nhãn, Dependabot, CODEOWNERS — 5 mục
`LOOP-STOP-005, WF-REVIEW-007, OPS-MAINT-005, BASE-DEP-007, XC-OSS-005`
1. Issues → Labels → tạo nhãn `major` (các nhãn `risk:*` đã có).
2. Settings → Code security → bật **Dependabot alerts**, **Dependabot security updates**. `.github/dependabot.yml` đã có trong repo. Đợi PR Dependabot đầu tiên (BASE-DEP-007 cần thấy ít nhất một PR bot).
3. **Quyết D-060**, chọn một:
   - (a) Giữ như hiện nay (đề xuất khi còn làm một mình): CODEOWNERS có, không bắt code-owner review. Mục WF-REVIEW-007/LOOP-STOP-005 sẽ ghi **miễn**, kèm dòng `Duyệt:` của bạn.
   - (b) Có tài khoản thứ hai: bật `require_code_owner_review` và `required_approving_review_count ≥ 1` trong ruleset `main`.
- **Rồi nhắn agent:** `D-060 chọn (a)` hoặc `(b), đã bật`; `đã tạo nhãn major, đã bật Dependabot`.

### A2. Tag phát hành annotated — 1 mục
`BASE-REPO-006`
- release-please tạo tag thường (lightweight), còn mục này đòi tag **annotated**.
- **Bạn quyết:** cho agent thêm bước tạo lại tag annotated trong `release.yml` sau khi release-please tạo Release (đề xuất), hay chuyển sang tự tạo tag tay mỗi lần phát hành.
- **Điều kiện:** phải xong 0.2 trước.
- **Rồi nhắn agent:** `BASE-REPO-006: làm bước tag annotated trong release.yml`.

### A3. LICENSE, SECURITY, file cộng đồng — 5 mục
`BASE-REPO-004, CMP-LIC-001, XC-OSS-001, BASE-SEC-009, XC-OSS-004`
1. **Quyết giấy phép:**
   - **Proprietary**: ghi tên chủ sở hữu (cá nhân hay công ty, tên chính xác). Đề xuất chọn cách này cho SaaS thương mại.
   - Hoặc một giấy phép OSI, nếu muốn mở mã.
2. Quyết repo **public hay private**.
3. Cho **địa chỉ email nhận báo lỗ hổng**, có thể là địa chỉ riêng như `security@…`.
4. Settings → Code security → bật **Private vulnerability reporting**.
- **Rồi nhắn agent:** `License: Proprietary, chủ sở hữu <tên>; email bảo mật <…>; đã bật PVR`. Agent viết `LICENSE`, trường `license` trong `package.json`, `SECURITY.md`, `security.txt`, `CONTRIBUTING`/CoC/SUPPORT, `THIRD_PARTY_NOTICES` (CI so khác = 0).

### A4. Duyệt ngoại lệ giấy phép — 1 mục
`CMP-LIC-004`
- `@img/sharp-libvips-linux-x64` dùng LGPL-3.0, liên kết động qua sharp của Next. Hạn ngoại lệ 2026-12-31.
- Bạn chọn: **duyệt** (đề xuất: liên kết động, không sửa thư viện) hoặc **thay sharp**.
- `parse-cache-control` (BSD, chỉ dùng trong CI) có hạn 2027-04-18, chỉ cần xác nhận.
- **Rồi nhắn agent:** `Duyệt ngoại lệ LGPL sharp tới <ngày>; xác nhận parse-cache-control`.

### A5. Duyệt biến môi trường — 3 mục
`BASE-CFG-002, FE-BUILD-005, DB-SEC-002`
- Agent bị chặn sửa `.env*`. Bạn tự thêm vào `.env.example` hai dòng sau (không chứa mật khẩu thật):
  ```
  WORKER_DATABASE_URL=postgres://hm_worker:CHANGE_ME@localhost:5432/hotel
  MIGRATION_DATABASE_URL=postgres://hm_migrator:CHANGE_ME@localhost:5432/hotel
  ```
  Commit lên một nhánh rồi mở PR, hoặc nhắn agent để agent tạo PR từ phần còn lại.
- **Rồi nhắn agent:** `đã duyệt 2 biến env`. Agent tiếp tục:
  - đưa các `process.env` còn lại vào schema;
  - tách biến client/server;
  - thêm test build khi thiếu env;
  - cho app/worker/migration dùng vai trò CSDL riêng.

### A6. Hook / ADR — 2 mục
`ARC-ADR-004, XC-DOCAI-005`
- Phần còn thiếu nằm trong `.claude/hooks/guard.py`, mà agent không được sửa hook.
- Chọn một:
  - (a) Ghi **miễn** kèm `Duyệt:` (đề xuất; khung ADR-0018 đã bỏ lớp hỏi khi sửa ADR).
  - (b) Bạn tự sửa `guard.py`: thêm luật hỏi khi sửa ADR đã *accepted*, và ghép chuỗi regex `curl … | sh` để file hướng dẫn không chứa nguyên văn lệnh tải-và-chạy.
- **Rồi nhắn agent:** `ARC-ADR-004, XC-DOCAI-005: miễn, Duyệt 2026-..`.

---

## Bước B — Quyết định sản phẩm và pháp lý (28 MUST; cần trước khi có dữ liệu thật)

### B1. Pháp lý, quyền riêng tư — 12 mục
`PM-RISK-007, CMP-INTL-002, CMP-INTL-006, CMP-VN-004, CMP-VN-006, CMP-AUDIT-003, CMP-AUDIT-007, CMP-AUDIT-010, IND-SAAS-010, OPS-IR-010, STD-PRIV-005, XC-GREEN-007`

Nên có luật sư hoặc người phụ trách pháp lý.
1. **Đối chiếu văn bản gốc:**
   - NĐ 13/2023;
   - Luật Bảo vệ dữ liệu cá nhân 2025;
   - NĐ 356/2025;
   - TT 50/2024 và TT 17/2024.

   Hiện `docs/research/` chỉ dựa trên nguồn thứ cấp. Ghi số hiệu, ngày hiệu lực và URL.
2. **DPIA** (đánh giá tác động) và **hồ sơ chuyển dữ liệu ra nước ngoài** (nếu dùng cloud/SMTP ngoài VN).
3. **Số ngày lưu** cho từng loại dữ liệu: hợp đồng, CCCD, log, thông báo, ảnh… Agent dùng các số này để viết job tự xoá (STD-PRIV-005, XC-GREEN-007).
4. **`legal_basis`** cho từng hoạt động xử lý (CCCD là dữ liệu nhạy cảm).
5. **DPA mẫu** và danh sách sub-processor: VPS, SMTP, sao lưu…
6. Chỉ định **DPO / đầu mối pháp lý**; làm tabletop sự cố vi phạm dữ liệu một lần, có biên bản (Mẫu 08, thông báo Bộ Công an trong 72 giờ).
- **Rồi nhắn agent:** dán số liệu hoặc đường dẫn tài liệu. Agent ghi vào `docs/privacy/`, `docs/compliance/` (ROPA, vendors, sổ sự cố) và viết job tự xoá.

### B2. Quyết định sản phẩm rồi mới code — 16 mục
`CMP-RIGHTS-001/004/007, CMP-VN-001/007, CMP-INTL-007, CMP-PRIV-005, CMP-AUDIT-002, STD-PRIV-004, IND-SAAS-006/008/009, UX-CONTENT-005, PM-METRIC-003/005/006`

1. **Danh mục mục đích xin đồng ý.** Ví dụ: (1) quản lý hợp đồng, bắt buộc; (2) gửi thông báo nhắc phí; (3) marketing, tuỳ chọn. Kèm văn bản hiển thị, do pháp lý duyệt.
   - Việc này mở khoá cả cụm khoảng 10 mục: đồng ý / rút đồng ý / xoá / DSAR / xoá tài khoản / xoá tenant.
   - Agent viết phần đó, kèm test E2E.
2. **Gói và giá (F-015):** tên gói, hạn mức theo gói (số phòng, người dùng, dung lượng), luồng đăng ký/huỷ. Phục vụ IND-SAAS-008 và UX-CONTENT-005.
3. **Truy cập hỗ trợ tạm (IND-SAAS-009):** cho phép nhân viên hỗ trợ đăng nhập thay chủ trọ không, giới hạn bao lâu, chủ trọ có thấy log không.
   - Chạm auth, nên **bạn merge**.
4. **Analytics (PM-METRIC-003/005/006)**, chọn một:
   - (a) Không dùng SDK analytics; đo từ `audit_events`. Đề xuất cách này, ghi miễn phần SDK.
   - (b) Dùng `track()` có schema, kèm thời hạn lưu N tháng.
- **Rồi nhắn agent:** `B2: mục đích = …; gói = …; IND-SAAS-009 = có/không …; analytics (a)`.

---

## Bước C — Hạ tầng thật (41 MUST; tốn tiền, cần tài khoản)

### C1. VPS, domain, staging, production — 25 mục
`BASE-ERR-011, STD-SEC-007, FE-PERF-001, WF-ENV-006/008/010/012, WF-REL-004/007, SEC-INFRA-003, SEC-LOG-006, SEC-SECRET-005, OPS-DEPLOY-001/002/004, OPS-IAC-001, PRF-WEB-005/008/009, PM-PRIO-003, IND-SAAS-011, IND-SAAS-014, QA-PERF-002, CMP-PRIV-008, XC-GREEN-002`

1. **Mua:**
   - **2 VPS đặt tại Việt Nam**, staging và production. Theo ADR-0002, mỗi máy tối thiểu 2 vCPU / 4 GB.
   - **Domain.**
   - **Registry image:** GHCR có sẵn với GitHub.
2. GitHub → Settings → Environments:
   - Tạo `staging`.
   - Tạo `production`, với required reviewer **khác người kích**, và deployment branch chỉ `main` và tag `v*`.
3. **Kho bí mật:** Docker secrets hoặc sops+age. Khoá giữ ngoài repo.
4. **Tường lửa:** chỉ mở 80/443; SSH chỉ bằng khoá, không mở ra `0.0.0.0/0`. Bật NTP.
5. **SMTP relay** (D-010) và **ClamAV** trên VPS.
6. **GlitchTip** (tự host) để thu lỗi và source map riêng tư; **kho log tập trung** (Loki hoặc tương đương).
7. Cho agent quyền deploy (SSH key deploy, hoặc runner tự host) qua mục **Ủy quyền production** trong `docs/autopilot/PLAN.md`. Ghi rõ được làm gì và không được làm gì.
- **Rồi nhắn agent:** `C1: VPS staging <IP>, prod <IP>, domain <…>; environments đã tạo; ủy quyền: …`. Agent viết:
  - IaC;
  - pipeline deploy theo digest (cùng image cho staging và prod);
  - smoke test sau deploy, rollback một lệnh;
  - job k6 nightly trên staging;
  - quét log staging tìm PII;
  - ngân sách chi phí.
- **Bạn diễn tập:** rollback < 15 phút trên production (hoặc bản sao của nó); migration chạy trên bản sao dữ liệu.
- **Sau 28 ngày có người dùng thật:** đo Core Web Vitals thực địa (FE-PERF-001).

### C2. Sao lưu khác máy, khôi phục, giám sát — 13 mục
`DB-BACKUP-001/002/003/004, OPS-DR-003/004/007/008, OPS-SLO-006, WF-DOC-008, IND-SAAS-013, IND-SAAS-015, IND-FIN-011`

1. **Chốt RPO/RTO.** Đề xuất trong `PROJECT.md` §5: CSDL mất tối đa 15 phút, khôi phục trong 4 giờ; file 24 giờ.
2. **Kho sao lưu ở nhà cung cấp khác** (bucket S3-compatible, mã hoá):
   - Tài khoản ghi chỉ có quyền `PutObject`.
   - Vai trò xoá tách riêng, có MFA.
   - Điền `deploy/pgbackrest.conf.example`.
   - Cất `PGBACKREST_REPO_CIPHER_PASS` ở nơi riêng (escrow).
3. **Kho WORM ≥ 10 năm** cho chứng từ tài chính (IND-FIN-011).
4. **Prometheus + Alertmanager** cùng **kênh trực** (Telegram/Zalo/email); dùng `deploy/prometheus/alerts.yml`.
5. **Diễn tập** (người **không phải** tác giả làm, ghi ngày):
   - bắn thử từng alert → `docs/ops/alert-drills.md`;
   - khôi phục toàn bộ và khôi phục một tenant → `docs/ops/restore-drills.md`.
6. **SLO theo gói** và status page (cần B2 mục 2 trước).
- **Rồi nhắn agent:** `C2: RPO/RTO = …; bucket <…>; kênh trực <…>; đã diễn tập <ngày>`. Agent cập nhật runbook, `last_drilled`, rồi tick.

### C3. Bàn giao tài khoản, gia hạn — 3 mục
`PM-HANDOVER-004, PM-HANDOVER-005, PM-HANDOVER-009`
- Khi mua VPS/domain/SMTP, đặt chủ sở hữu là **tài khoản tổ chức** (không dùng tài khoản cá nhân), và bật nhắc gia hạn.
- **Rồi nhắn agent:** gửi danh sách dịch vụ, ngày hết hạn, người gia hạn. Agent lập:
  - `docs/handover/renewals.md` (nhắc trước ≥ 30 ngày);
  - checklist offboarding (thu hồi quyền trong ngày, xoay secret).

---

## Bước D — Kiểm tay trên thiết bị thật (3 MUST)
`STD-A11Y-004, PM-SPEC-004, WF-SDD-003`
1. Kiểm tay kịch bản SPEC-pwa **S-002, S-003, S-016**:
   - Chrome Android;
   - Safari iOS ≥ 16.4;
   - ma trận 5 thiết bị.
2. Đi luồng chính chỉ bằng **bàn phím**, rồi bằng **trình đọc màn hình** (TalkBack hoặc VoiceOver).
3. Ghi biên bản (người, ngày, thiết bị, luồng, kết quả) vào `docs/qa/` và `GO-NO-GO.md`.
- **Rồi nhắn agent:** `D xong, biên bản ở docs/qa/<file>`. Agent xoá S-NNN khỏi `scripts/spec-coverage.baseline.json` rồi tick.

---

## Bước E — Phát hành chạy thật (G7)
1. Quyết từng đề xuất **"Khi chạy thật"** trong `docs/autopilot/DECISIONS.md` (18 đề xuất, GO-NO-GO 4b).
2. Nhắn agent: **`/autopilot` hoặc "tiếp tục"**. Agent chạy `loop resume`, tick các mục đã đủ bằng chứng, rồi chạy `release-check`. Khi không còn NO-GO và còn 0 MUST mở, agent cập nhật `GO-NO-GO.md`.

---

## Bảng tổng (89)

| Bước | Nhóm | Số MUST | Cần gì |
|---|---|---|---|
| A1 | Nhãn / Dependabot / D-060 | 5 | 15 phút GitHub + một quyết định |
| A2 | Tag annotated | 1 | quyết định (sau 0.2) |
| A3 | LICENSE / SECURITY | 5 | quyết giấy phép + email |
| A4 | Ngoại lệ giấy phép | 1 | duyệt |
| A5 | Biến env | 3 | thêm 2 dòng `.env.example` |
| A6 | Hook / ADR | 2 | miễn hoặc sửa hook |
| B1 | Pháp lý | 12 | luật sư / DPO |
| B2 | Quyết định sản phẩm | 16 | danh mục đồng ý, gói giá, analytics |
| C1 | Hạ tầng | 25 | VPS ×2, domain, SMTP, ClamAV |
| C2 | Sao lưu / giám sát | 13 | bucket nhà cung cấp khác, kênh trực, diễn tập |
| C3 | Bàn giao | 3 | danh sách gia hạn |
| D | Kiểm tay | 3 | điện thoại thật, trình đọc màn hình |
| | **Tổng** | **89** | |

**Làm nhanh nhất:** Bước 0 và Bước A (khoảng 1–2 giờ), gửi agent một tin gom hết các câu trả lời. Việc đó đóng được tới 17 MUST mà chưa tốn tiền hạ tầng.
