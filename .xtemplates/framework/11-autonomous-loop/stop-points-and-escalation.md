---
title: Điểm dừng bắt buộc, mức tin cậy T0–T4, leo thang
kind: module
prefix: LOOP-STOP
applies_to: [all]
updated: 2026-10-15
---

# Điểm dừng bắt buộc, mức tin cậy T0–T4, leo thang

> Tự động hoá chỉ an toàn khi biết **chỗ nào phải dừng** và **chỗ nào không cần dừng**. Module này là nhà của hai
> thứ: **điểm quyết định** chuyên môn mà phiên chính tự duyệt theo tiêu chí chất lượng cuối (ADR-0008), và **điểm
> dừng bắt buộc** về hành động (máy chặn được bằng hook); kèm thang tin cậy T0–T4, mức tự chủ L0–L4, vị từ "làn
> nhanh", đường leo thang khi bế tắc. Áp dụng cho mọi agent làm việc trên repo khung và dự án đích, mọi quy mô.

## Nguyên tắc

1. **Dừng là một cổng, không phải ngoại lệ** (`G-esc`): việc `blocked` mở cổng cho người; duyệt = mở lại kèm gợi ý,
   từ chối = đóng việc. Máy ghi `loop block --reason`, người quyết.
2. **Nghi ngờ thì lên làn cao hơn, không xuống.** Một việc bị xếp làn thấp sai là cách sự cố production ra đời.
3. **Quá hạn chờ không tự đi tiếp và không tự huỷ** — leo thang cho người (mặc định 24 h, nhắc giữa hạn 12 h).
4. **Fail-closed cho cổng duyệt**: điều kiện không đánh giá được tính là trượt; "gần đủ" là không đủ.
5. **Đặc quyền tách bằng code, không bằng lời dặn**: PreToolUse `deny` có hiệu lực cả ở chế độ bỏ qua hỏi quyền;
   lời dặn trong prompt không phải cơ chế bảo mật.
6. **Lỗi lần 2 đổi cách, lần 3 hỏi người; sửa mã vòng thứ 4 gần như luôn là đặc tả sai.**
7. **Quyết định chuyên môn không phải điểm dừng** (ADR-0008): chọn cách hiểu spec, công nghệ, thiết kế, duyệt kế
   hoạch → phiên chính tự duyệt theo tiêu chí chất lượng cuối và ghi lại; **hành động** không đảo ngược hoặc ra thế
   giới thật vẫn dừng. Chờ người cho một câu hỏi phiên chính tự trả lời được bằng dữ kiện là lãng phí, không phải an toàn.

## Quyết định

### Điểm quyết định — phiên chính tự duyệt theo tiêu chí chất lượng cuối (ADR-0008)

Áp dụng cho repo khung và mọi dự án đích, có hay không chạy autopilot. **Chỉ phiên chính** được tự duyệt; subagent
gặp điểm quyết định thì trả về phiên chính các phương án + dữ kiện, không tự lấp.

| Điểm quyết định | Trước ADR-0008 | Nay |
|---|---|---|
| Duyệt `PLAN.md` (cổng kế hoạch của autopilot) | Chờ người | Phiên chính tự duyệt, ghi D-NNN; người can thiệp lúc nào cũng được |
| Spec hở, nhiều cách hiểu, mâu thuẫn spec ↔ code ↔ test | `loop block "spec: …"` | Tự quyết, ghi D-NNN cạnh "Câu hỏi mở" của spec |
| Câu hỏi `[chặn]` ở G0, ưu tiên/phạm vi MVP | Hỏi người | Tự quyết; thiếu dữ kiện chỉ người có → giả định đảo ngược được |
| Chọn công nghệ/thư viện/kiến trúc, đánh đổi thiết kế/UX | Người duyệt ở cổng | Tự quyết sau `/research`; kiến trúc thì thêm ADR |
| Bảo mật/pháp lý mơ hồ (cách hiểu yêu cầu) | Dừng | Tự quyết theo cách hiểu **chặt hơn**; merge thay đổi đó vẫn theo `LOOP-STOP-005` |
| Đổi cách tiếp cận khi lỗi lặp lần 2 | Tự làm | Tự làm, ghi D-NNN |

**Tiêu chí chất lượng cuối** — xét theo thứ tự; phương án thắng ở tiêu chí trên thì thắng, không cộng điểm:

1. **Đúng và an toàn** — khớp ý định đã ghi (PROJECT/SPEC/ADR/code đang chạy); bảo mật, dữ liệu, pháp lý chọn cách hiểu chặt hơn.
2. **Giữ đường lùi** — thiếu dữ kiện chỉ người có (ý định kinh doanh, ngân sách, số liệu thật) → phương án rẻ nhất để đổi sau; ghi giả định.
3. **Bền lâu** — đơn giản, theo chuẩn và blueprint, ít phụ thuộc, test được, dễ bảo trì.
4. **Trải nghiệm cuối** — người dùng cuối, a11y, hiệu năng, vận hành được.
5. **Tốc độ/chi phí làm** — chỉ để phá hoà; không bao giờ đổi chất lượng lấy nhanh.

**Mặc định tự host — không xin thông tin chủ dự án.** Khi một phương án cần tài khoản, khoá API, thẻ thanh toán,
hợp đồng hay thông tin chỉ chủ dự án cung cấp được, phiên chính **luôn chọn phương án tự host** chạy được trong repo
(container/`docker compose`, giấy phép OSI) và ghi đề xuất dịch vụ cho lúc chạy thật bằng `--prod`:

| Nhu cầu | Khi phát triển (tự host, ví dụ) | `--prod` ghi gì |
|---|---|---|
| CSDL, cache, hàng đợi | PostgreSQL, Valkey, RabbitMQ/NATS trong compose | Dịch vụ quản lý + vùng (dữ liệu VN: [`CMP-VN-004`](../16-compliance-privacy/vietnam-data-law.md)) |
| Lưu file | Server tương thích S3 tự host | Object storage của cloud, chính sách vòng đời |
| Email/SMS/push | Bắt thư cục bộ (Mailpit), adapter giả sau interface | Nhà cung cấp gửi thật, domain + SPF/DKIM/DMARC |
| Đăng nhập | Auth trong app hoặc IdP tự host (OIDC) | IdP quản lý/SSO doanh nghiệp nếu cần |
| Thanh toán, API bên thứ ba bắt buộc | Adapter giả + contract test theo tài liệu công khai | Cổng thật, khoá sandbox → live (điểm dừng tiền thật) |
| Quan sát, analytics, feature flag | Stack OSS tự host (OpenTelemetry, flagd…) | SaaS nếu chi phí vận hành tự host cao hơn |

Bí mật cục bộ tự sinh (`.env` không commit, giá trị mẫu trong `.env.example`); thiếu khoá thật không phải lý do dừng.
Danh sách `--prod` trong `DECISIONS.md` là đầu vào của cổng G7/`GO-NO-GO.md`; đăng ký dịch vụ, nhập khoá thật, chuyển
dữ liệu vẫn là điểm dừng về hành động (tiền thật, dữ liệu thật, đối ngoại) — chủ dự án quyết lúc đó, một lần.

**Cách làm:** dữ kiện trước (đọc repo, `/research` khi cần nguồn sống) → ≥ 2 phương án → áp tiêu chí →
`xt.py loop decide --question … --option … --option … --choice N --why "<tiêu chí quyết định>" --revert "<đường lùi>" [--prod "<đề xuất khi chạy thật>"]`
(ghi `docs/autopilot/DECISIONS.md`, commit cùng thay đổi) → làm tiếp, không block, không chờ. Báo cáo cuối việc liệt kê
các D-NNN mới để người xem lại; người đổi ý → quyết định mới "thay D-NNN", không sửa mục cũ.

### Điểm dừng bắt buộc về hành động (máy chặn/hỏi trước khi làm)

Tự duyệt **không** mở các điểm dưới đây: chúng là hành động lên thế giới thật hoặc nới hàng rào, không phải lựa chọn
chuyên môn; hook `ask`/`deny` vẫn cưỡng chế bất kể chính sách trong prompt.

| Nhóm | Ví dụ | Cơ chế thật trong khung | Ai mở khoá |
|---|---|---|---|
| Thao tác không đảo ngược | `rm -rf`, `git push --force`, `reset --hard`, drop/alter phá vỡ, xoá dữ liệu | `pre-bash-guard.sh` → **deny**; `permissions.deny` | Người tự chạy tay |
| Tiền thật | Thanh toán, hoàn tiền, đổi giá, gọi API thu phí ngoài sandbox | `loop block --reason` + SPEC phải có ca test | Chủ sản phẩm |
| Dữ liệu người dùng thật | Migration trên DB production, export PII, xoá tài khoản | `pre-edit-guard.sh` ask khi sửa migration đã tồn tại; deploy → ask | Người trực + chủ dữ liệu |
| Đổi quyền / nới cổng | Sửa `eslint`/`tsconfig`/coverage/workflows/ruleset/`.claude/settings.json`/`.xtemplates/` | `pre-edit-guard.sh` → **ask** kèm lý do | Tech lead |
| Hành động đối ngoại | `gh pr merge`, `gh release`, `npm publish`, `docker push`, `terraform apply`, gửi email/thông báo, đăng bài | `pre-bash-guard.sh` → **ask**; Routine chỉ đề xuất | Người duyệt T4 |
| Merge thay đổi rủi ro cao | Chạm auth, mật mã, dữ liệu nhạy cảm, luật ngành | Luôn làn kiến trúc; `risk_tags` ≠ rỗng → thêm review bảo mật (`LOOP-STOP-005`) | Người phê duyệt bảo mật |
| Bế tắc máy | Cùng chữ ký lỗi lần 3, ngân sách/hạn hết | `loop record` tự đặt `blocked`; verdict `budget` | Người xem rồi `loop resume` |

### Thang tin cậy T0–T4 cho mỗi việc giao (stored 23 §4.5)

| Tier | Việc | Side effect cho phép | Ai chốt |
|---|---|---|---|
| T0 | Đọc, tra cứu, tóm tắt | none | Không |
| T1 | Sửa cơ học có test, docs, format | ghi repo trong worktree | Máy (Gate xanh) |
| T2 | Tính năng theo spec kín | ghi repo, mở PR | Reviewer khác tier + CI |
| T3 | Có side effect mạng/ingest, đổi hợp đồng API, publish thử | ingest-network / publish staging | Người review PR |
| T4 | Production, tiền, dữ liệu thật, ToS, xoá | account-change / publish prod | **Người** duyệt trước khi merge/chạy |

Subagent **không tự nâng tier**; `external_side_effects` là enum trong task pack (`none · ingest-network · publish · account-change`).

### Mức tự chủ L0–L4 của hệ (spec cũ §B11, rút gọn)

| Mức | Agent được | Người giữ | Điều kiện lên mức |
|---|---|---|---|
| L0 Trợ lý | Nháp spec/plan/diff | Mọi thứ | Có baseline 8 tuần |
| L1 Sinh PR | Chạy trọn tới PR + test + review report | Review và merge mọi PR | `first_pass_gate_rate ≥ 70 %` 4 tuần, lỗi lọt ≤ baseline |
| L2 Tự chủ làn nhanh | Tự merge **làn nhanh** khi cổng xanh | Duyệt spec, review mẫu ≥ 10 %, làn kiến trúc | 200 merge làn nhanh liên tiếp không lỗi nghiêm trọng (đội 1 người: 60) |
| L3 Tự chủ làn chuẩn | Trọn tính năng làn chuẩn | Chốt spec, chốt phát hành nhạy cảm | 8 tuần ở L2, `change_failure_rate ≤` baseline, can thiệp ≤ 15 % |
| L4 Trong hàng rào | Phát hành canary | Spec, giám sát, kill switch; làn kiến trúc luôn có người | Chỉ hệ rủi ro thấp, có phê duyệt quản trị |

**Đường lùi tự động:** 2 tuần liên tiếp lỗi lọt xấu hơn baseline, hoặc 1 vi phạm phân tách đặc quyền ⇒ hạ một mức.

### Vị từ "làn nhanh" (được tự merge ở L2) — đủ cả 5, thiếu một là làn chuẩn

1. Không chạm đường dẫn nhạy cảm (secret, schema/migration, gateway/auth).
2. `risk_tags` rỗng (`auth · payment · pii · crypto · upload · admin · external-api`).
3. Diff trong ≤ 1 package.
4. ≤ 150 dòng thay đổi (không tính file sinh/lockfile).
5. Có test phủ nhánh sửa và toàn bộ CI xanh.
Ngoại lệ cứng: **xác thực/phân quyền · thanh toán · mật mã luôn là làn kiến trúc**, kể cả diff 1 dòng.

## Checklist

- [ ] `LOOP-STOP-001` **MUST** Lệnh phá huỷ/không đảo ngược bị **deny** ở PreToolUse (không chỉ `ask`), sau khi tách lệnh nối `; && | ||`. → Kiểm: hook trả `permissionDecision: deny` cho `ls; rm -rf /` và `git push --force`; test hook xanh. · Nguồn: stored 12 §4 quy tắc 6
- [ ] `LOOP-STOP-002` **MUST** Hành động đối ngoại (merge, release, publish, deploy, gửi thông báo) qua `ask` hoặc `loop block`, không bao giờ tự chạy trong autopilot. → Kiểm: `.claude/settings.json` `permissions.ask` có `gh pr merge`, `npm publish`, `docker push`; log phiên không có lệnh đó chạy tự động.
- [ ] `LOOP-STOP-003` **MUST** Sửa cấu hình cổng (lint/type/coverage/workflows/ruleset/hook) và migration đã tồn tại đi qua `ask` kèm lý do ghi ở PR. → Kiểm: `pre-edit-guard.sh` trả `ask` cho `.github/workflows/x.yml` và file trong `migrations/` đã có; PR mô tả lý do. · Nguồn: stored 23 §4.3
- [ ] `LOOP-STOP-004` **MAY** Ngừng dùng 2026-10-15 — thay bằng `LOOP-STOP-018` (ADR-0008: mâu thuẫn spec/nhiều cách hiểu là điểm quyết định, phiên chính tự duyệt và ghi lại thay vì `loop block`).
- [ ] `LOOP-STOP-005` **MUST** Việc chạm tiền thật, dữ liệu người dùng thật, xác thực/phân quyền, mật mã luôn có người duyệt trước merge (T4/làn kiến trúc). → Kiểm: PR có nhãn `risk:` tương ứng và required review của người; CI chặn merge khi thiếu.
- [ ] `LOOP-STOP-006` **MUST@L** Mỗi task giao cho subagent ghi `model_tier` (T0–T4) và `external_side_effects`; subagent không tự nâng tier. → Kiểm: task pack có hai trường; test từ chối task thiếu trường. · Nguồn: stored 23 §4.5
- [ ] `LOOP-STOP-007` **MUST@L** Cổng chờ người có hạn (mặc định 24 h) và nhắc giữa hạn; quá hạn **không tự pass, không tự huỷ**. → Kiểm: cấu hình `gate_timeout_hours: 24`; test quá hạn → trạng thái `escalated`. · Nguồn: spec cũ ASC-FR-14
- [ ] `LOOP-STOP-008` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`LOOP-DESIGN-005`](loop-design.md) (trần rework 3 vòng/việc → `blocked`, người xem).
- [ ] `LOOP-STOP-009` **MUST@L** Làn nhanh (tự merge) chỉ bật ở L2 trở lên và được định nghĩa bằng vị từ máy (5 điều kiện + 3 ngoại lệ cứng); mặc định là "không phải làn nhanh". → Kiểm: script phân làn đọc `git diff --numstat` + đường dẫn + `risk_tags`; test: diff chạm `auth/` → làn kiến trúc. · Nguồn: spec cũ §B3.1a
- [ ] `LOOP-STOP-010` **MUST@L** Đường lùi tự chủ được đo: lỗi lọt nghiêm trọng qua làn nhanh → về L1 cho tới khi rà xong nguyên nhân. → Kiểm: `docs/ops/` có bảng mức hiện tại + ngày + lý do đổi; chỉ số `escaped_defect_rate` có số.
- [ ] `LOOP-STOP-011` **SHOULD** Lỗi lần 2 cùng bước → đổi cách tiếp cận trước khi thử lại; ghi vào PROGRESS mục Quyết định. → Kiểm: evidence lần 2 và 3 có `cmd`/diff khác nhau; PROGRESS có dòng "đổi cách". · Nguồn: stored 23 §6.1
- [ ] `LOOP-STOP-012` **SHOULD** Người giữ review mẫu ≥ 10 % PR ở mọi mức tự chủ để hiệu chuẩn niềm tin vào reviewer máy. → Kiểm: báo cáo tháng có tỉ lệ review mẫu. · Nguồn: spec cũ §B10
- [ ] `LOOP-STOP-013` **SHOULD** Lần đầu sửa file trong vùng rủi ro (`risk-zones.txt`) trong phiên → hook yêu cầu nêu 4 dữ kiện (mục đích, test phủ, rollback, ảnh hưởng) rồi mới cho sửa. → Kiểm: hook `risk-zone-gate` trả `deny` lần 1 kèm 4 câu hỏi, lần 2 cho qua. · Nguồn: stored 23 §4.3
- [ ] `LOOP-STOP-014` **SHOULD** Routine/cron không người trực chỉ **đề xuất** hành động đối ngoại (mở issue/PR nháp), không gửi/đăng/merge. → Kiểm: workflow lịch không có `contents: write` trừ job tách riêng tạo PR nháp. · Nguồn: stored 21 §10
- [ ] `LOOP-STOP-015` **SHOULD** Lý do `loop block` đủ để người quyết trong một lần đọc: ngữ cảnh, 2–3 lựa chọn, đề xuất, hệ quả. → Kiểm: `blocked_reason` ≥ 3 câu hoặc trỏ tới mục PROGRESS.
- [ ] `LOOP-STOP-016` **MAY** Dùng cổng "hành động trên $X" (vd > 0,5 USD mỗi lệnh gọi, > 10 USD mỗi run) hỏi lại người ngay cả khi tool được allow. → Kiểm: cấu hình ngưỡng tiền trong harness; test vượt ngưỡng → ask. · Nguồn: stored 19 §1.2
- [ ] `LOOP-STOP-017` **MAY** Mọi lần người bỏ qua một cổng được ghi vào `escalations` của việc kèm lý do, không xoá dấu vết. → Kiểm: PR/issue có mục "Bỏ qua cổng: lý do".
- [ ] `LOOP-STOP-018` **MUST@L** Điểm quyết định chuyên môn (duyệt PLAN, spec hở/nhiều cách hiểu/mâu thuẫn, chọn công nghệ, đánh đổi thiết kế, bảo mật/pháp lý mơ hồ) → phiên chính tự duyệt theo 5 tiêu chí chất lượng cuối, ghi bằng `xt.py loop decide` (≥ 2 phương án, lý do, đường lùi) rồi làm tiếp; không `loop block`, không chờ người; subagent không tự quyết. → Kiểm: `docs/autopilot/DECISIONS.md` có mục `D-NNN` cho mỗi quyết định, commit cùng thay đổi; `state.json.blocked_reason` không phải câu hỏi chuyên môn. · Nguồn: ADR-0008
- [ ] `LOOP-STOP-019` **SHOULD** Báo cáo cuối việc/bàn giao liệt kê các `D-NNN` mới trong kỳ để người xem lại; người đổi ý → quyết định mới ghi "thay D-NNN", không sửa mục cũ. → Kiểm: báo cáo cuối/PR có dòng "Quyết định tự duyệt: D-…"; `git log -p docs/autopilot/DECISIONS.md` chỉ thêm dòng. · Nguồn: ADR-0008
- [ ] `LOOP-STOP-020` **SHOULD** Phương án cần thông tin/tài khoản/khoá chỉ chủ dự án có → chọn phương án tự host chạy được trong repo (giấy phép OSI) và ghi đề xuất dịch vụ cho lúc chạy thật bằng `loop decide --prod`; không dừng xin khoá khi phát triển. → Kiểm: `docker compose up` (hoặc lệnh `xt.yaml`) chạy đủ phụ thuộc không cần khoá ngoài; `GO-NO-GO.md` liệt kê mọi dòng "Khi chạy thật" của `DECISIONS.md`. · Nguồn: ADR-0008
- [ ] `LOOP-STOP-021` **SHOULD** Việc cần người (điểm dừng về hành động) **không chặn cả vòng**: `xt.py loop defer --task <T-NNN|ID blueprint> --reason …` rồi làm việc độc lập khác; `loop block` chỉ khi mọi việc còn lại phụ thuộc nó; hết việc tự làm được → verdict `done-pending-human`, người xử lý gom một lần rồi `loop resume`. → Kiểm: `state.json.deferred` có lý do; `loop status` liệt kê "chờ người"; test `test_defer_status_hook_stop_and_resume_flow`. · Nguồn: ADR-0009

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Cổng duyệt nằm trong system prompt ("hỏi tôi trước khi xoá") | Prompt injection hoặc model nhầm → vẫn xoá | Deny/ask ở hook và `permissions`; prompt chỉ là lớp nhắc |
| Chạy mọi CLI với cờ bỏ qua quyền để "nhanh" | Mất toàn bộ điểm dừng, sandbox | Chế độ bỏ qua hỏi quyền chỉ trong VM/container dùng một lần; deny vẫn hiệu lực |
| Agent tự lấp spec hở **ngầm** | Làm sai việc nhanh hơn, không ai biết đã có lựa chọn | Spec hở → quyết định tường minh `loop decide` (D-NNN), không lấp ngầm |
| Dừng chờ người cho câu hỏi chuyên môn tự trả lời được | Vòng lặp đứng, chất lượng không tăng | Áp 5 tiêu chí chất lượng cuối, ghi D-NNN, làm tiếp |
| Dừng xin khoá API/tài khoản giữa lúc phát triển | Vòng lặp đứng chờ chủ dự án, phụ thuộc dịch vụ trước khi cần | Tự host + adapter giả; đề xuất dịch vụ ghi `--prod`, quyết ở G7 |
| Coi tự duyệt là được phép làm hành động đối ngoại | Deploy/xoá/tiền chạy không người | Tự duyệt chỉ cho lựa chọn; hành động vẫn qua hook `ask`/`deny` |
| Quá hạn chờ duyệt → tự coi là đồng ý | Thay đổi nhạy cảm lọt | Hết hạn = leo thang, không pass |
| Allowlist glob so khớp trước khi tách lệnh nối | `ls && rm -rf /` lọt qua allow `ls *` | Tách `; && \| \|\|` rồi mới so (hook của khung làm vậy) |
| Bật làn nhanh khi chưa đo được `first_pass_gate_rate` | Không biết lúc nào phải lùi | Đếm trước, bật sau |
| Coi "mục tiêu 6 tháng là L3" khi baseline chưa có | Nhắm ngưỡng chưa tồn tại | Dừng ở L2 cho đến khi có số |

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| `pre-bash-guard.sh` | PreToolUse(Bash) | `.claude/settings.json` | deny phá huỷ; ask đối ngoại/push main |
| `pre-edit-guard.sh` | PreToolUse(Edit\|Write) | `.claude/settings.json` | deny file bí mật; ask cấu hình cổng, migration cũ |
| `permissions.deny/ask` | `claude -p --permission-mode dontAsk` trong CI | settings | deny thắng allow |
| `xt.py loop block` | `xt.py loop block --reason "..."` | Agent khi gặp điểm dừng an toàn | verdict `blocked` |
| `xt.py loop defer` | `xt.py loop defer --task ID --reason …` | Agent khi việc cần người mà còn việc khác làm được | verdict `done-pending-human` khi hết việc tự làm |
| `xt.py loop decide` | `xt.py loop decide --question … --option … --option … --choice N --why … --revert …` | Phiên chính ở điểm quyết định | exit 2 khi < 2 phương án, chọn không khớp, thiếu lý do/đường lùi |
| Phân làn | script đọc `git diff --numstat` + đường dẫn + `risk_tags` | CI `pr-policy` | 5 điều kiện; mặc định làn chuẩn |
| Ruleset | `.github/rulesets/main.json` | GitHub | PR bắt buộc, required check `quality` + `protection-guard` + `gitleaks` + `dep-audit`, không bypass |

## Nguồn

- ADR-0008 (`docs/adr/0008-main-session-self-approves-decisions.md` của repo khung): phiên chính tự duyệt điểm quyết định theo tiêu chí chất lượng cuối — chủ repo yêu cầu 2026-10-15.
- `.claude/hooks/pre-bash-guard.sh`, `pre-edit-guard.sh`, `.claude/settings.json` của khung — đọc 2026-10-13.
- Claude Code docs — permission modes (`defaultMode` `auto`/`bypassPermissions` bị bỏ qua ở project settings; deny có hiệu lực mọi chế độ): <https://code.claude.com/docs/en/permission-modes> · hooks `PreToolUse` `permissionDecision`: <https://code.claude.com/docs/en/hooks> — theo `research/2026-10-13-claude-code-hooks-skills.md`, xác minh 2026-10-13.
- Khung cũ X-stored `docs/specs/AI-HARNESS-AND-COMPANY-SPEC.md` (commit `1b80fe4`) §B3.1a (làn nhanh 5 điều kiện), §B6.3 (trần rework), §B6.4 (leo thang), ASC-FR-14 (hạn cổng 24 h), §B10, §B11 (L0–L4) — đọc 2026-10-13.
- OWASP Top 10 for Agentic Applications 2026 (ASI01 Goal Hijack, ASI02 Tool Misuse, ASI03 Identity & Privilege Abuse): <https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/> — theo `research/2026-10-13-ai-agent-research.md` §5.1 [F]; trang trả 403 khi fetch lại ngày 2026-10-13.
- `seeker19110/stored` mục 12 §4 (7 quy tắc), mục 19 §1.2, mục 21 §10, mục 23 §2.3, §4.3, §4.5, §6.1 — đọc 2026-10-13.
