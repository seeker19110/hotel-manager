---
title: Điểm dừng bắt buộc, mức tin cậy T0–T4, leo thang
kind: module
prefix: LOOP-STOP
applies_to: [all]
updated: 2026-10-21
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
   hoạch → phiên chính tự duyệt theo tiêu chí chất lượng cuối và ghi lại; **hành động** không đảo ngược bị máy chặn,
   việc chạm tiền/dữ liệu người dùng thật vẫn chờ người (`loop defer`). Chờ người cho một câu hỏi phiên chính tự trả lời được bằng dữ kiện là lãng phí, không phải an toàn.

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

### Điểm dừng bắt buộc về hành động (máy chặn hoặc gom cho người — ADR-0018, ADR-0019)

Tự duyệt **không** mở các điểm dưới đây: chúng là hành động lên thế giới thật hoặc nới hàng rào, không phải lựa chọn
chuyên môn. Guard **không hỏi người** (ADR-0018): bộ luật vẫn tính `ask`, đầu ra qua `apply_policy` — lý do nguy hiểm
(`DANGER_MARKERS`) → **deny** ở mọi chế độ, còn lại → cho chạy với lớp đỡ là CI, ruleset nhánh, review.
`XT_GUARD_POLICY=strict` trả lại `ask` cho mọi dòng "cho chạy" dưới đây. Việc máy không chặn mà vẫn cần người
(cột cuối có "Người") → agent `loop defer`, gom cuối phiên (D-023).

| Nhóm | Ví dụ | Cơ chế thật trong khung (mặc định) | Ai mở khoá |
|---|---|---|---|
| Thao tác không đảo ngược | `rm -rf`, `git push --force`, `reset --hard`, push thẳng nhánh chính, xoá đệ quy ngoài dự án, `gh repo delete`, ghi ruleset qua `gh api`, `kubectl delete`, `terraform destroy`, drop/alter phá vỡ, xoá dữ liệu | `pre-bash-guard.sh` → **deny**; `permissions.deny` | Người tự chạy tay |
| Tiền thật | Thanh toán, hoàn tiền, đổi giá, gọi API thu phí ngoài sandbox, đăng ký dịch vụ trả phí | `loop defer`/`loop block --reason` + SPEC phải có ca test; PR chạm tiền → `merge-check` `hard` → merge bị **deny** (`merge_hard_exceptions: human`); việc trong `- grant:` của PLAN và còn hạn mức thì tự làm (`grant-check`, ADR-0022) | Chủ sản phẩm (qua PR ủy quyền) |
| Dữ liệu người dùng thật | Migration phá vỡ trên DB production, export PII, xoá tài khoản, gửi tin tới người dùng thật | `loop defer`; PR `risk:pii` → `hard` → merge bị **deny** (`human`); sửa migration đã tồn tại: cho chạy, §3 AGENTS.md cấm sửa migration đã áp; việc trong `- grant:` của PLAN và còn hạn mức thì tự làm (`grant-check`, ADR-0022) | Người trực + chủ dữ liệu (qua PR ủy quyền) |
| Đổi quyền / nới cổng | Sửa `eslint`/`tsconfig`/coverage/workflows/`.claude/settings.json`/`.xtemplates/`, cập nhật snapshot/baseline ảnh | `pre-edit-guard.sh` → cho chạy, lý do ghi ở commit/PR, PR không vào làn nhanh; tắt/bỏ qua hook → **deny** | Review PR |
| Tự thêm năng lực agent | `claude mcp add`, `claude plugin install`, `npx skills add`, sửa `.mcp.json`/`.claude-plugin/` (`LOOP-STOP-023`) | `pre-bash-guard.sh`/`pre-edit-guard.sh` → cho chạy; PR chỉ đổi các file đó không vào làn nhanh | Review PR |
| Hành động đối ngoại | `gh pr merge`/`gh api` merge/tool MCP merge (`pre-mcp-guard.sh`), `gh api` ghi khác, `gh release`, `npm publish`, `docker push`, `terraform apply`, đăng bài | Cho chạy; merge PR `hard` → **deny** (ADR-0019; `auto` không còn `hard`, ADR-0020); Routine chỉ đề xuất (`LOOP-STOP-014`) | CI + ruleset nhánh; người cho PR `hard` khi `human` |
| Ra khỏi máy dev | `ssh`/`scp`/`rsync` tới máy khác, `psql`/`mysql` tới máy chủ không cục bộ, `curl`/`wget` gửi dữ liệu ra ngoài, thêm phụ thuộc (`pnpm add`, `pip install <gói>`), container trên daemon máy khác | Cho chạy; gửi file bí mật/biến môi trường ra mạng, container có quyền máy chủ → **deny** | Review PR |
| Merge thay đổi rủi ro cao | Chạm auth, mật mã, dữ liệu nhạy cảm, luật ngành | Luôn làn kiến trúc; `merge-check` `hard` → agent merge/bật auto-merge bị **deny** (`merge_hard_exceptions: auto` → CI + reviewer máy, ADR-0020); push commit `hard` vào PR đã bật auto-merge → required check `merge-gate` đỏ (ADR-0023); `risk_tags` ≠ rỗng → thêm review bảo mật (`LOOP-STOP-005`) | Người phê duyệt bảo mật |
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
| L3 Tự chủ làn chuẩn | Trọn tính năng làn chuẩn | Chốt spec, chốt phát hành nhạy cảm, ngoại lệ cứng (trừ khi `merge_hard_exceptions: auto`) | 8 tuần ở L2, `change_failure_rate ≤` baseline, can thiệp ≤ 15 % — hoặc chủ dự án chọn thẳng (`merge_autonomy: L3`, ADR-0015) |
| L4 Trong hàng rào | Phát hành canary | Spec, giám sát, kill switch; làn kiến trúc luôn có người | Chỉ hệ rủi ro thấp, có phê duyệt quản trị |

**Đường lùi tự động:** 2 tuần liên tiếp lỗi lọt xấu hơn baseline, hoặc 1 vi phạm phân tách đặc quyền ⇒ hạ một mức.

Cột "Điều kiện lên mức" là lộ trình đo được; `merge_autonomy` trong `xt.yaml` là lựa chọn của chủ dự án — mẫu dự án đích
mặc định L3 (ADR-0015) và bỏ qua bậc thang theo lựa chọn đó. Ở mọi mức, ngoại lệ cứng dưới đây vẫn người merge (ADR-0016) — trừ khi nhánh đích đã commit `merge_hard_exceptions: auto` (ADR-0020; repo khung `auto`, mẫu dự án đích `human`).

### Vị từ "làn nhanh" (được tự merge ở L2) — đủ cả 5, thiếu một là làn chuẩn

1. Không chạm đường dẫn nhạy cảm (secret, schema/migration, gateway/auth).
2. `risk_tags` rỗng (`auth · payment · pii · crypto · upload · admin · external-api`).
3. Diff trong ≤ 1 package.
4. ≤ 150 dòng thay đổi (không tính file sinh/lockfile).
5. Có test phủ nhánh sửa và toàn bộ CI xanh.
Ngoại lệ cứng: **xác thực/phân quyền · thanh toán · mật mã luôn là làn kiến trúc**, kể cả diff 1 dòng và kể cả ở L3
(`xt.py merge-check` trả `hard`: thêm bí mật, nhãn `risk:pii`/`risk:admin`/`risk:secret`, `merge_risk_paths` — ADR-0016).
`xt.yaml` `merge_hard_exceptions: auto` (ADR-0020), đọc ở nhánh đích đã commit (không ở cây làm việc): `merge-check` vẫn
liệt kê lý do ở `hard_waived` nhưng `hard` rỗng — PR vẫn làn chuẩn, ở L3 merge như PR làn chuẩn khác (review sạch ở H — `LOOP-STOP-022`); thiếu khoá, giá
trị lạ, không đọc được = `human`. PR đổi chính khoá luôn người merge (không tự miễn).

### Steward theo sự kiện và Routine kích phiên (AUTO-05)

`pr-steward.yml` xét lại PR **ngay khi trạng thái đổi**, lịch 10 phút chỉ là lưới bù:

| Trigger | Khi nào | PR được xét |
|---|---|---|
| `workflow_run` (`workflows: [CI, merge-gate]`, `completed`) | Check của GitHub Actions xong (job `quality`, `merge-gate`) | `pull_requests` trong payload; trống (push lên nhánh đích, PR từ fork) → mọi PR mở |
| `check_suite: completed` | Check của app ngoài xong (GitHub **không** kích sự kiện này cho check suite do Actions tạo — chống đệ quy) | Như trên |
| `issue_comment` có dấu `xt-review v1` | Review đăng lên PR (ADR-0027) | PR của comment |
| `schedule` / `workflow_dispatch` | Lưới bù / chạy tay | Mọi PR mở hoặc `inputs.pr` |

Idempotent theo khoá **(repo, PR, head, hành động)**: payload chỉ chọn PR cần xét — head, auto-merge, check, review luôn
đọc lại từ GitHub (`pr next` như phiên agent), và `xt.py pr steward` **đọc lại PR ngay trước mỗi hành động**: PR đã
đóng/merge, head đã đổi, bật khi đã bật, tắt khi đã tắt → bỏ qua (ghi `bỏ qua <khoá> — <lý do>`, run xanh); không đọc lại
được → không làm, run đỏ để lượt sau thử lại. Vì vậy sự kiện lặp, sự kiện đến sai thứ tự (head của payload cũ hơn head
hiện tại → xét và ghim head hiện tại, ghi chú) và re-run sau restart không lặp tác dụng phụ. Nhóm `concurrency` theo PR
của sự kiện (`pr-steward-<N>`, lịch: `pr-steward-all`): GitHub chỉ giữ một lượt chờ mỗi nhóm, nhóm chung sẽ để sự kiện
của PR khác thay mất lượt đang chờ; lượt `all` chạy song song lượt của một PR an toàn nhờ bước đọc lại. Dự án đích đặt
tên workflow CI khác thì sửa `workflows:` (tên không khớp = không bao giờ kích).

**Routine kích phiên cho việc steward không làm được.** Steward chỉ bật/tắt auto-merge, merge ghim head và (có
`XT_STEWARD_TOKEN`) cập nhật nhánh; hành động `fix` (CI đỏ do mã) và `update` khi thiếu token chỉ được báo. Mẫu Routine
(research preview — hành vi và giới hạn có thể đổi):

- Trigger GitHub `pull_request.synchronize` (thêm `pull_request.opened` nếu muốn), lọc *Base branch* = nhánh mặc định,
  *Is draft* = `false`; repo của PR là repo đầu tiên của Routine để phiên bắt đầu từ head của PR.
- Prompt: chạy `python3 .xtemplates/scripts/xt.py pr next --pr <N> --json`; chỉ làm khi `action` là `fix` (đọc
  `loop ci-triage`, sửa trong phạm vi PR, qua `/gate`, push lên **nhánh head của PR** — tắt auto-merge trước, `LOOP-STOP-022`)
  hoặc `update` (cập nhật nhánh ghim head: `gh api -X PUT repos/<o>/<r>/pulls/<N>/update-branch -f expected_head_sha=<head>`);
  hành động khác → kết thúc không làm gì. Ngân sách sửa theo `self-healing-ci.md` (cùng chữ ký lỗi 3 lần → `loop defer`).
- Danh tính: Routine chạy bằng tài khoản GitHub của chủ Routine — commit/push hiện là người đó. Review từ Routine **không**
  tính là review độc lập với tác giả (`review_identity`, ADR-0027); `review` vẫn do reviewer khác danh tính/khác họ model.
- Routine mặc định push nhánh `claude/…`; prompt phải chỉ rõ nhánh head của PR, và ruleset nhánh vẫn là lớp chặn (push
  thẳng nhánh chính bị từ chối). Sự kiện vượt trần theo giờ bị bỏ — steward theo lịch vẫn báo `fix`/`update` còn treo.

**Routine tuần ở dự án đích: phát hiện lệch và mở PR nâng cấp (AUTO-06).** Mẫu (research preview), lịch tuần một lần:

- Trigger *Schedule* hằng tuần (≥ 1 giờ/lần là giới hạn của Routine); repo là dự án đích, nhánh mặc định.
- Prompt: (1) `python3 .xtemplates/scripts/xt.py doctor --drift --json` — `ok: true` và không có `outdated` → kết thúc
  không làm gì; (2) có `outdated`/`missing`: trong bản clone X-Templates mới nhất chạy
  `python3 <clone>/scripts/install.py <gốc dự án> --plan` đọc JSON, rồi `install.py` (copy-if-absent, giữ file
  `modified`, chỉ gỡ `ask` có trong `.xtemplates/manifest.json`), làm các bước "Dự án đích" của `CHANGELOG.md`, qua
  `/gate`, mở **PR nháp** từ nhánh `claude/upgrade-<tag>` (`LOOP-STOP-014`: chỉ đề xuất, không merge).
- Phạm vi: không đổi ruleset, secret hay production; `modified` là tuỳ chỉnh hợp lệ — liệt kê trong mô tả PR, không ghi đè.
  Danh tính, trần sự kiện và việc review như Routine ở trên (review không độc lập với tác giả).
- `doctor --drift --json` trả `{ok, installed, latest, manifest, drift: [{kind: file|permission|doc|version|manifest,
  state: missing|modified|outdated, subject, msg}]}`; exit 1 khi có lệch khác `modified`. `--latest vX.Y.Z` cấp tag
  không cần mạng; không cấp thì hỏi `gh api` và fail-open (không biết tag → không kết luận về phiên bản).

## Checklist

- [ ] `LOOP-STOP-001` **MUST** Lệnh phá huỷ/không đảo ngược bị **deny** ở PreToolUse (không chỉ `ask`), sau khi tách lệnh nối `; && | ||`. Lệnh lồng cũng được quét: `sh -c`/`bash -c`, `eval '…'`, backtick, `{ …; }`, `if …; then …`, heredoc/ống vào shell, `find … -delete`/`-exec rm` (gốc `/`, `~` → deny); xoá đệ quy ra ngoài gốc dự án (trừ thư mục tạm) → deny (`XT_GUARD_POLICY=strict`: ask). → Kiểm: hook trả `permissionDecision: deny` cho `ls; rm -rf /`, `git push --force`, `eval 'rm -rf ~'`, `` echo `rm -rf ~` ``, `{ rm -rf ~; }`, `find / -exec rm -rf {} +`; deny cho `rm -rf ~/x` (strict: ask); test hook xanh (`tests/test_hooks.py` `GuardStoredScanTest`). · Nguồn: stored 12 §4 quy tắc 6
- [ ] `LOOP-STOP-002` **MUST** Hành động đối ngoại (merge, release, publish, deploy, gửi thông báo) đi qua guard: bộ luật đánh dấu mọi lệnh đối ngoại; không đảo ngược (huỷ repo/bí mật/hạ tầng, push nhánh chính) và merge/bật auto-merge PR ngoại lệ cứng (`merge_hard_exceptions: human`) hoặc PR chưa có review hợp lệ ở head (`eligible`/`auto_merge_ok` false, `LOOP-STOP-022`) → **deny**; còn lại mặc định cho chạy, lớp đỡ là CI, ruleset nhánh, review (ADR-0018, ADR-0019); `XT_GUARD_POLICY=strict` → `ask`. Việc chạm tiền/dữ liệu người dùng thật → `loop defer` (D-023). Merge PR: làn nhanh khi `xt.py merge-check` trả `merge` ở mức tự chủ ≥ L2, hoặc ở L3 bật auto-merge của GitHub theo làn — làn nhanh khi mở, làn chuẩn chỉ sau review sạch ở đúng head (`xt.py pr next`, `LOOP-STOP-009`, ADR-0024/0025) — trừ ngoại lệ cứng (`LOOP-STOP-022`, ADR-0015, ADR-0016; `merge_hard_exceptions: auto` gồm cả ngoại lệ cứng — ADR-0020). → Kiểm: `.claude/settings.json` `permissions.ask` rỗng; mặc định guard trả `deny` cho `gh repo delete`, `git push origin main`, merge PR `hard` (`GuardPolicyTest`, `MergeGuardTest`); ở `strict` guard trả `ask` cho `gh pr merge` không ghim `--match-head-commit`, có `--admin`/`--repo`, hoặc `merge-check` ≠ `merge` — cùng luật cho `gh api -X PUT …/pulls/N/merge` (ghim `sha`) và tool MCP `merge_pull_request` (ghim `expectedHeadSha`), mọi `gh api` ghi khác (cả `--input`) luôn `ask`, bật auto-merge `ask` dưới L3 hoặc khi `merge-check` có `hard`; log phiên không có lệnh đối ngoại nào khác chạy tự động.
- [ ] `LOOP-STOP-003` **MUST** Sửa cấu hình cổng (lint/type/coverage/workflows/ruleset/hook) và migration đã tồn tại được guard đánh dấu — mặc định cho chạy (ADR-0018), `XT_GUARD_POLICY=strict` → `ask` — và **lý do ghi ở commit/PR**; PR đó không vào làn nhanh; tắt/bỏ qua hook → deny. → Kiểm: `pre-edit-guard.sh` trả `ask` ở `strict` cho `.github/workflows/x.yml` và file trong `migrations/` đã có; PR mô tả lý do. · Nguồn: stored 23 §4.3
- [ ] `LOOP-STOP-004` **MAY** Ngừng dùng 2026-10-15 — thay bằng `LOOP-STOP-018` (ADR-0008: mâu thuẫn spec/nhiều cách hiểu là điểm quyết định, phiên chính tự duyệt và ghi lại thay vì `loop block`).
- [ ] `LOOP-STOP-005` **MUST** Việc chạm tiền thật, dữ liệu người dùng thật, xác thực/phân quyền, mật mã luôn có người duyệt trước merge (T4/làn kiến trúc), ở mọi mức `merge_autonomy` kể cả L3 (ADR-0016) — trừ khi chủ dự án đặt `merge_hard_exceptions: auto` trong `xt.yaml` và ghi việc chấp nhận rủi ro (ADR/D-NNN của dự án; ADR-0020). → Kiểm: PR có nhãn `risk:` tương ứng và (khi `human`) required review của người; CI chặn merge khi thiếu; `xt.py merge-check` trả `hard` + `human` và guard không bật auto-merge cho PR đó; auto-merge tắt TRƯỚC mỗi push (`LOOP-STOP-022` bước (3)); lỡ push khi còn bật thì tắt ngay (MCP `disable_pr_auto_merge` hoặc `gh pr merge <N> --disable-auto`), chạy lại `merge-check` (làn `chuẩn` thì rà lại H..head) — có `hard` (commit sau chạm auth/tiền, thêm nhãn `risk:`) thì `loop defer` (AUD-SEC-036); máy đỡ: required check `merge-gate` đỏ khi head hiện tại `hard` mà auto-merge đang bật (ADR-0023).
- [ ] `LOOP-STOP-006` **MUST@L** Mỗi task giao cho subagent ghi `model_tier` (T0–T4) và `external_side_effects`; subagent không tự nâng tier. → Kiểm: task pack có hai trường; test từ chối task thiếu trường. · Nguồn: stored 23 §4.5
- [ ] `LOOP-STOP-007` **MUST@L** Cổng chờ người có hạn (mặc định 24 h) và nhắc giữa hạn; quá hạn **không tự pass, không tự huỷ**. → Kiểm: cấu hình `gate_timeout_hours: 24`; test quá hạn → trạng thái `escalated`. · Nguồn: spec cũ ASC-FR-14
- [ ] `LOOP-STOP-008` **MAY** Ngừng dùng 2026-10-14 — gộp vào [`LOOP-DESIGN-005`](loop-design.md) (trần rework 3 vòng/việc → `blocked`, người xem).
- [ ] `LOOP-STOP-009` **MUST@L** Làn nhanh (tự merge) chỉ bật ở L2 trở lên (L3: chủ dự án chọn auto-merge mọi làn — làn chuẩn sau khi review sạch, làn nhanh khi mở PR — trừ ngoại lệ cứng — ADR-0015, ADR-0016, ADR-0024) và được định nghĩa bằng vị từ máy (5 điều kiện + 3 ngoại lệ cứng); mặc định là "không phải làn nhanh". → Kiểm: `xt.py merge-check` phân làn từ `files` + nhãn `risk:` của PR (vị từ trên, `merge_risk_paths` thêm đường dẫn riêng), thiếu khoá `merge_autonomy` thì L1, mức dùng là mức thấp hơn giữa cây làm việc và nhánh đích đã commit (D-033) (mẫu `templates/xt.yaml` đặt L3); test: diff chạm `auth/` → làn chuẩn, người merge (khi `merge_hard_exceptions: human`). · Nguồn: spec cũ §B3.1a
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
- [ ] `LOOP-STOP-022` **SHOULD** Thời điểm merge PR đã mở do máy quyết: `xt.py merge-check [--pr N]` đọc PR qua REST (`gh api`, chạy được cả ở phiên chặn GraphQL; review: lần mới nhất của mỗi người, `mergeable_state` BLOCKED → `human`; BLOCKED mà ruleset của nhánh đích đòi check không có trên head — REST `rules/branches` — thì lý do là "thiếu check bắt buộc", không phải "cần review" (D-060)) (trạng thái, nháp, tiêu đề — `<type>(scope): mô tả` ≤ 72 ký tự vì thành commit squash, sai → `fix` (D-056), xung đột, CI, review, tụt sau nhánh đích, file, nhãn) → `merge` · `review` (CI/làn cho merge mà review ở head chưa hợp lệ — `eligible` false: không in lệnh merge, exit 1, bước kế là review/`pr next`; AUD-XFEAT-010) · `wait` · `update` · `fix` · `human` · `closed`; agent làm đúng bước `next` (merge bằng lệnh ghim head: `gh pr merge --match-head-commit`, hoặc khi phiên chặn GraphQL `gh api -X PUT repos/{owner}/{repo}/pulls/N/merge -f sha=…` / tool MCP `merge_pull_request` có `expectedHeadSha`; dưới L3 không bật auto-merge của GitHub — không ghim được head; ở L3 dùng "merge theo làn" (ADR-0015, ADR-0016, ADR-0024) do máy chọn bước: `xt.py pr next --pr N [--json]` (ADR-0025) đọc quyết định `merge-check`, trạng thái auto-merge của PR và review **đã đăng** trên PR (cùng nguồn với `merge-check`/`merge-gate`/guard/steward; sổ `.autopilot/reviews.json` chỉ để nhận ra review chưa đăng được → `republish-review` = chạy lại `pr reviewed`, AUD-XFEAT-011) rồi trả MỘT hành động (`enable-auto-merge` · `disable-auto-merge` · `republish-review` · `review` · `fix` · `update` · `retarget` · `defer-human` · `merge` (dưới L3: lệnh ghim head) · `wait` · `done` · `closed`) kèm `do` và `fallback` (merge ghim head khi GitHub báo PR đã sẵn sàng); luật: làn `nhanh` bật khi mở; làn `chuẩn` (PR quan trọng) chỉ bật/merge khi review sạch ở đúng head (pha `delivery_phase: build` hoãn review của PR ngoài ngoại lệ cứng thành nợ, trả trước G7 — ADR-0031) — `xt.py pr reviewed --pr N --head <SHA đủ 40 ký tự> --clean|--blocking --reviewer-model <M> --author-model <M>` ghi kết quả `reviewer` (model khác — `--clean` cùng họ model với người viết bị từ chối) rà H..head, review sạch = không còn lỗi chặn, mục "nên sửa" đã sửa hoặc trả lời lý do; tắt auto-merge TRƯỚC mỗi push hoặc gắn nhãn `risk:`; PR từng vào làn chuẩn hoặc từng có review báo lỗi chặn giữ chặt; PR chồng chờ đổi đích; verdict `human` khi auto-merge đang bật → tắt trước; dưới L3 `pr next` không bao giờ trả `enable-auto-merge` mà trả `merge` (ghim head) khi `merge-check` = `merge`; `hard` → người (`loop defer`; job CI `merge-gate` đỏ khi PR `hard` đang bật auto-merge — ADR-0023); `pr next` không gọi GitHub; `update` = `gh pr update-branch`, `wait` = chạy lại sau, `human` = báo người kèm lý do). Không có check CI nào xanh → `human`. Mở PR xong chạy nền `xt.py merge-watch --pr <N>` (30 giây/lần, ADR-0021) thay vì hỏi tay: lệnh gọi lại đúng `merge-check` và thoát khi verdict ≠ `wait`. Điều kiện "đủ review ở head" là MỘT hàm (`xt.py` `merge_eligibility`, ADR-0028): `merge-check --json` mang `review`/`eligible`/`auto_merge_ok`, `merge-gate` đỏ khi làn chuẩn đang bật auto-merge mà thiếu review sạch ở head; guard **chặn** (mã `REVIEW_MISSING`, `deny` ở chính sách mặc định, `ask` khi `XT_GUARD_POLICY=strict`) merge ghim head và bật auto-merge khi `eligible`/`auto_merge_ok` là false — pha build hoãn review (`deferred`) nên không bị chặn; merge không ghim head hoặc khi `merge-check` ≠ `merge` vì lý do khác thì guard chỉ hỏi ở `strict`, mặc định cho qua (lớp đỡ: CI, ruleset, `merge-gate`). → Kiểm: `xt.py merge-check --json` có trong log trước mỗi lệnh merge; `xt.py pr next` trước mỗi lần bật/tắt auto-merge (test `PrNextTest`); log phiên có `merge-watch` cho mỗi PR đã mở; guard chỉ `allow` khi verdict `merge`, head khớp và (MCP) repo khớp, trả `deny` khi chưa có review hợp lệ ở head (`GuardReviewMissingTest`). · Nguồn: ADR-0013, ADR-0014 của repo khung
- [ ] `LOOP-STOP-023` **MUST@L** Agent **không tự thêm năng lực cho chính nó** giữa phiên: lệnh `claude mcp add*`, `claude plugin install|enable`, `claude plugin marketplace add`, `codex mcp add`, `gemini extensions install`, `npx skills add`; ghi `.mcp.json`/`mcp.json`/`~/.claude.json`/`.claude-plugin/**`/`.codex/config.toml`/`.gemini/**` (và `.claude/{agents,skills,commands}/**` ở dự án đích) → guard đánh dấu: mặc định cho chạy (ADR-0018), `XT_GUARD_POLICY=strict` → **ask**; PR chỉ đổi các file đó không vào làn nhanh và nêu lý do. MCP server/plugin/skill chạy với quyền người dùng và nạp vào mọi lượt — thêm mới là đổi quyền. → Kiểm: test hook (`GuardStoredScanTest.test_capability_*`) và `merge_lane_reasons` (`test_merge_capability_and_infra_paths`) xanh. · Nguồn: seeker19110/stored mục 01 §3c, 19 §1d, 20 §1, 23 §6.1 (rà 2026-10-16)
- [ ] `LOOP-STOP-024` **MUST@L** Blueprint phân biệt hai nghĩa của `[~]`: `— Không áp dụng: <điều kiện kiểm được>` (mục không áp vào dự án; agent ghi được) và `— Miễn: <lý do>` (mục **có** áp dụng mà bỏ/hoãn). Mục MUST bị `Miễn` phải kèm lời chủ dự án `Duyệt: "<trích nguyên văn>" <YYYY-MM-DD>` hoặc link tới comment/issue; thiếu → `blueprint-status --strict` đỏ, autopilot không ra `done` (dùng `loop defer` để gom cho người). Câu tự viết "chủ dự án duyệt" không phải bằng chứng; im lặng không phải duyệt. → Kiểm: `xt.py blueprint-status --strict` báo `MUST \`Miễn\` thiếu \`Duyệt:\``; test `test_waiver_reason_must_be_in_note`. · Nguồn: seeker19110/stored mục 23 §6.1 (`GATE WAIVED <time> "<owner words>"`, "im lặng không phải waiver"), §4 (qlkh: chấp nhận rủi ro do `human:owner` ký) — rà 2026-10-16
- [ ] `LOOP-STOP-025` **MUST@L** `deny` hoặc `ask` bị từ chối là **kết luận**: không thử lệnh hay tool khác cho cùng hiệu ứng — đổi Edit sang Bash, bọc `bash -c`/`python -c`, viết script tạm rồi chạy, thử lại write bị từ chối. Ghi `loop defer` (còn việc khác làm được) hoặc `loop block` (mọi việc còn lại phụ thuộc nó) kèm lý do. → Kiểm: review transcript/báo cáo cuối — sau một lần bị từ chối không có lời gọi khác cùng đích; test hook cho các dạng lách phổ biến (`tests/test_hooks.py`: lệnh trong `bash -c`/heredoc/pipe vào shell — AUD-SEC-017; `eval`, backtick, `{ …; }`, `python -c`/heredoc ghi file bảo vệ — `GuardStoredScanTest`); dạng còn lại kiểm bằng review. · Nguồn: stored 20 §1.5 ("không retry write bị từ chối hay đổi tool để lách")
- [ ] `LOOP-STOP-026` **SHOULD** Muốn tự động tới production thì chủ dự án duyệt MỘT lần mục **Ủy quyền production** của `PLAN.md` (dòng `- grant: <nhóm> | khoá=giá trị`: `payments` · `data_delete` · `data_export` · `outbound_messages` · `auth_crypto` · `secrets`; mặc định chỉ sandbox) cùng khoá `merge_hard_exceptions: auto`; trước mỗi việc production agent chạy `xt.py grant-check <nhóm> khoá=giá trị` (khai đủ mọi khoá của nhóm; đọc PLAN.md ở nhánh mặc định trên GitHub qua REST, không đọc cây làm việc hay ref cục bộ) — exit 0 mới làm, exit 1 (kể cả thiếu mục) thì `loop defer`; hạn mức theo thời gian do sản phẩm cưỡng chế bằng code (idempotency, sổ cái, xoá mềm + sao lưu, canary + kill switch, giới hạn tốc độ). PR đổi hiệu lực ủy quyền của PLAN.md (so `parse_grants` đáy/đầu PR cho từng đường PLAN, kể cả đổi tên/sao chép vào) hoặc khoá `merge_hard_exceptions` luôn do người merge (`HARD_KEY_REASON`), nên ủy quyền không tự cấp được qua PR — kể cả push thêm vào PR đã bật auto-merge (auto-merge không ghim head):
  required check `merge-gate` chạy `merge-check` bằng mã của nhánh mặc định trên head hiện tại, đỏ khi `hard` mà auto-merge đang bật (ADR-0023). → Kiểm: `xt.py grant-check payments mode=live` exit 1 khi PLAN chỉ có `mode=sandbox`; `merge-check` báo `hard` cho PR đổi hiệu lực grant kể cả đổi code fence/viết hoa (`test_plan_grant_effect_changes_are_hard`) hoặc đổi tên/sao chép vào PLAN.md (`test_rename_or_copy_into_plan_is_hard`); `merge-gate` đỏ khi head đó có auto-merge (`MergeGateTest`); `grant-check` chỉ đọc REST nhánh mặc định nên sửa tại chỗ/ref cục bộ không có tác dụng (`test_within_grant_reads_default_branch_via_rest`); test `tests/test_grants.py`. · Nguồn: ADR-0022
- [ ] `LOOP-STOP-027` **MUST@L** Lệnh do model viết mà harness chạy — Gate trong `PLAN.md`, `— Kiểm:` trong blueprint (`loop record`/`loop verify`/`blueprint-status --run`), lệnh trong `xt.yaml` (sàn Gate; `dev-task.sh` ở cổng commit, `/gate`, `format_file` sau mỗi lần sửa — qua `xt.py guard-check`) — qua **cùng luật guard** như lệnh Bash của agent trước khi chạy; bị cấm thì không chạy, exit 126 kèm lý do, task đỏ. Guard lấy ở dự án rồi ở bản cài của chính `xt.py` (đổi `CLAUDE_PROJECT_DIR` không thoát được); harness đã cài (`.claude/settings.json`) mà thiếu guard → chặn như hook. Stop hook buộc chạy `loop verify` (`LOOP-DESIGN-022`), nên một Gate độc hay gõ nhầm (`git push --force …`, `rm -rf ~/…`) sẽ chạy ngoài hàng rào ở mọi phiên nếu bỏ bước này. Chưa cài harness → chạy (fail-open về luồng); guard lỗi giữa chừng → như hook (`_failure_decision`: merge/`gh api` bị chặn, lệnh khác chạy). → Kiểm: `GuardChokePointTest` (`tests/test_xt_core.py`): lệnh bị cấm ra exit 126 và file canary không được tạo. · Nguồn: seeker19110/stored mục 01 §3g (lệnh test do LLM đề xuất chạy thẳng `sh -c` — rà 2026-10-18); OWASP Top 10 for Agentic Applications 2026 — ASI05 Unexpected Code Execution (https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/, đọc 2026-10-18)
- [ ] `LOOP-STOP-028` **MUST@L** Agent không mở CLI agent khác Claude Code (codex, gemini, copilot, opencode, aider, cursor-agent, amp…) với cờ hoặc biến môi trường **tự duyệt mọi công cụ** (codex `--yolo`/`--dangerously-bypass-approvals-and-sandbox`, `-s danger-full-access`, `-a never`, `--approve-for-me`; gemini `--approval-mode=yolo`/`--yolo`; copilot `--allow-all-tools`/`--allow-all`/`--yolo`/`COPILOT_ALLOW_ALL`; opencode `--auto`; aider `--yes-always`/`AIDER_YES_ALWAYS`; cursor-agent `--force`/`--yolo`/`--approve-mcps`; amp `--dangerously-allow-all`): agent lồng không chạy hook của khung — một lệnh là ra khỏi mọi hàng rào (đường vòng của `LOOP-STOP-025`). Guard **chặn**; Claude Code lồng vẫn nạp hook của dự án nên chỉ chặn cờ tắt hook (`LOOP-HARNESS-018`). Nhận cả dạng qua `npx`/`npm exec … --`/`uvx`/`pipx run`, gói kèm `@phiên-bản`, cụm cờ ngắn (`-yp`), viết tắt cờ argparse (`aider --yes`), `export VAR=…` trước đó trong cùng lệnh, Codex `-c approval_policy=never`/`sandbox_mode=danger-full-access`. Cùng nhóm: `--no-verify`/`-c core.hooksPath=…`/`GIT_CONFIG_KEY_n=core.hooksPath` chỉ tắt git hook — cổng của khung vẫn chạy trước commit (strict: hỏi người); ghi `.git/hooks`, `.git/config` (kể cả sau `cd`, `chmod`), đặt/bỏ `core.hooksPath`, hay đặt khoá git chạy lệnh tuỳ ý — nhận theo **mẫu**: `core.{fsmonitor,sshCommand,gitProxy,pager,editor,askpass,alternateRefsCommand}`, `pager.*`, `alias.*`, `protocol.*.allow`, `gpg.*.program`, `submodule.*.update`, `sendemail.*cmd`, `init.templateDir`, mọi khoá đuôi `.path`/`.cmd`/`.command`/`.program`/`.helper`/`.textconv`/`.smudge`/`.clean`/`.driver`/`.uploadpack`/`.receivepack`, và URL `ext::` ở mọi lệnh git — bằng `git config`, `git config -f .git/config`, hay một lần `git -c k=v` → chặn, trừ giá trị khớp **nguyên văn** tập an toàn (alias không `!`, `credential.helper` store/cache/osxkeychain/manager/`/usr/…/git-credential-*`, `core.pager` cat/less [-FRSX], `core.editor` vim/nano/`code --wait`, `core.sshCommand` `ssh -i <khoá>` [-o StrictHostKeyChecking/IdentitiesOnly…], `core.fsmonitor` true/false, `merge.*.driver true`, `gpg.program gpg2`, `protocol.{http,https,ssh,git,file}.allow`; `protocol.ext.allow` chỉ `never`); giá trị khác người đặt tay: không vào commit, không có dấu vết PR, lệnh chạy về sau ngoài guard. Giới hạn đã biết (phân tích tĩnh, cùng loại lệnh trong trình thông dịch): cấu hình qua biến môi trường (`GIT_ALLOW_PROTOCOL`, `export GIT_CONFIG_*` trước lệnh), `find … -exec chmod`, tuỳ chọn pager riêng của công cụ (`delta.*.pager`) — cổng của khung vẫn chạy trước commit. Thiết lập husky/lefthook bằng tay (`git config core.hooksPath .husky`) vì thế cũng bị chặn — dùng `npx husky`/`lefthook install`/`pre-commit install`, hoặc người tự đặt. → Kiểm: `GuardStored1018Test` (`tests/test_hooks.py`). · Nguồn: seeker19110/stored mục 01 §3g.4 (runner `codex exec --full-auto`, `copilot --allow-all-tools`; model ghi được `.git/hooks`), 03 §8c; OWASP Top 10 for Agentic Applications 2026 — ASI02 Tool Misuse, ASI05 Unexpected Code Execution; cờ đọc 2026-10-18 từ docs/mã nguồn Codex CLI, Gemini CLI, Copilot CLI, opencode, aider, Cursor CLI (Amp: docs E2B/SDK, chưa thấy ở docs chính thức)
- [ ] `LOOP-STOP-029` **SHOULD** PR đủ tiêu chuẩn vào nhánh chính **không phụ thuộc phiên agent còn sống**: kết quả review ghi lên chính PR (`xt.py pr reviewed` đăng comment có dấu `xt-review v1 head=<SHA> verdict=…`, không tên model), và một job chạy trên nền tảng CI (`pr-steward.yml`: lịch ≤ 15 phút + khi có comment review) gọi cùng luật `pr next` cho mọi PR mở để bật auto-merge hoặc merge ghim head; chỉ tin dấu của người có quyền ghi repo; chỉ tự merge PR cùng repo của tác giả có quyền ghi (PR từ fork/người ngoài → người merge); PR từng vào làn chuẩn mang nhãn bền để giữ chặt; job không chạy code của PR (ADR-0027); PR tụt sau base thì job cập nhật nhánh (ghim head cũ) và review sạch mang sang head mới chỉ khi head là merge base không đổi tập thay đổi của PR (tên file, trạng thái, blob) và nhánh đích không chạm file nào của PR — khác đi thì review lại; job chạy bằng GITHUB_TOKEN không tự cập nhật nhánh vì commit đó không kích CI (D-061); nhánh đích không có check bắt buộc thì job không bật auto-merge (GitHub merge ngay lúc bật, trước khi CI xong — D-062); PR đủ điều kiện (`merge-check` = `merge`) thì `pr next` trả merge ghim head kể cả khi auto-merge đang bật mà GitHub chưa merge, và không bao giờ bảo bật auto-merge khi nhánh đích không có check bắt buộc (D-063); job chạy cả theo sự kiện (`workflow_run` của CI/`merge-gate`, `check_suite: completed`) và mỗi hành động idempotent theo (repo, PR, head, hành động) — đọc lại PR ngay trước khi làm (AUTO-05, mục *Steward theo sự kiện* ở trên). → Kiểm: `.github/workflows/pr-steward.yml` có trong repo; `python3 .xtemplates/scripts/xt.py pr steward` (không `--apply`) liệt kê mọi PR mở kèm hành động; PR làn chuẩn đã review sạch có comment dấu review ở đúng head; ở repo khung `python3 -m unittest discover -s tests -k steward_events` xanh. · Nguồn: ADR-0027 của repo khung

## Bẫy thường gặp

| Bẫy | Hậu quả | Cách tránh |
|---|---|---|
| Cổng duyệt nằm trong system prompt ("hỏi tôi trước khi xoá") | Prompt injection hoặc model nhầm → vẫn xoá | Deny/ask ở hook và `permissions`; prompt chỉ là lớp nhắc |
| Chạy mọi CLI với cờ bỏ qua quyền để "nhanh" | Mất toàn bộ điểm dừng, sandbox | Chế độ bỏ qua hỏi quyền chỉ trong VM/container dùng một lần; deny vẫn hiệu lực |
| Agent tự lấp spec hở **ngầm** | Làm sai việc nhanh hơn, không ai biết đã có lựa chọn | Spec hở → quyết định tường minh `loop decide` (D-NNN), không lấp ngầm |
| Dừng chờ người cho câu hỏi chuyên môn tự trả lời được | Vòng lặp đứng, chất lượng không tăng | Áp 5 tiêu chí chất lượng cuối, ghi D-NNN, làm tiếp |
| Dừng xin khoá API/tài khoản giữa lúc phát triển | Vòng lặp đứng chờ chủ dự án, phụ thuộc dịch vụ trước khi cần | Tự host + adapter giả; đề xuất dịch vụ ghi `--prod`, quyết ở G7 |
| Coi tự duyệt là được phép làm hành động đối ngoại | Xoá/tiền/dữ liệu người dùng thật chạy không người | Tự duyệt chỉ cho lựa chọn; không đảo ngược bị hook `deny`, tiền/dữ liệu thật và PR `hard` → `loop defer` |
| Quá hạn chờ duyệt → tự coi là đồng ý | Thay đổi nhạy cảm lọt | Hết hạn = leo thang, không pass |
| Allowlist glob so khớp trước khi tách lệnh nối | `ls && rm -rf /` lọt qua allow `ls *` | Tách `; && \| \|\|` rồi mới so (hook của khung làm vậy) |
| Bật làn nhanh khi chưa đo được `first_pass_gate_rate` | Không biết lúc nào phải lùi | Đếm trước, bật sau |
| Coi "mục tiêu 6 tháng là L3" khi baseline chưa có | Nhắm ngưỡng chưa tồn tại | Đo trước; L3 chỉ khi chủ dự án chọn rõ (ADR-0015), ngoại lệ cứng giữ người trừ khi chủ dự án merge PR đặt `auto` (ADR-0020) |
| Agent tự ghi "Miễn: chủ dự án duyệt" cho MUST | Mục bắt buộc bị bỏ mà không ai duyệt thật | `Duyệt: "<trích>" <ngày>` hoặc link; không có thì `loop defer` (`LOOP-STOP-024`) |
| Agent cài MCP server/plugin giữa phiên để "làm nhanh" | Mã bên thứ ba chạy với quyền người dùng, tự đăng ký server từ xa | PR không vào làn nhanh, nêu lý do (strict: `ask` ở hook); vendor + lock + quét trước khi dùng (`LOOP-STOP-023`, `SEC-SUPPLY-016`) |
| Bị `deny`/`ask` từ chối rồi "thử cách khác" (Edit → Bash, `bash -c`, `python -c`, script tạm) | Hàng rào thành thủ tục; hiệu ứng bị cấm vẫn xảy ra | Từ chối là kết luận: `loop defer`/`loop block` (`LOOP-STOP-025`) |
| Phiên mở ở repo A merge/bật auto-merge PR của repo B (tool MCP `owner/repo` khác) | Guard chặn: `merge-check` chỉ đọc `xt.yaml` (`merge_autonomy`, `merge_risk_paths`, `merge_hard_exceptions`) của repo phiên — quyết cho repo B bằng cấu hình repo A có thể cho agent merge ngoại lệ cứng | Mở phiên trong repo B, hoặc người merge (fail-closed có chủ đích, ADR-0019) |

## Cổng tự động

| Công cụ | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|
| `pre-bash-guard.sh` | PreToolUse(Bash) | `.claude/settings.json` | deny phá huỷ, push main, huỷ hạ tầng, merge PR `hard`; còn lại cho chạy (strict: ask đối ngoại) |
| `pre-edit-guard.sh` | PreToolUse(Edit\|Write) | `.claude/settings.json` | deny file bí mật; cấu hình cổng, migration cũ cho chạy (strict: ask) |
| `permissions.deny` | `claude -p --permission-mode dontAsk` trong CI | settings (`ask` rỗng — ADR-0018) | deny thắng allow |
| `xt.py loop block` | `xt.py loop block --reason "..."` | Agent khi gặp điểm dừng an toàn | verdict `blocked` |
| `xt.py loop defer` | `xt.py loop defer --task ID --reason …` | Agent khi việc cần người mà còn việc khác làm được | verdict `done-pending-human` khi hết việc tự làm |
| `xt.py loop decide` | `xt.py loop decide --question … --option … --option … --choice N --why … --revert …` | Phiên chính ở điểm quyết định | exit 2 khi < 2 phương án, chọn không khớp, thiếu lý do/đường lùi |
| Phân làn | `xt.py merge-check` (`merge_lane_reasons`: file PR + đường dẫn + nhãn `risk:`) | Phiên agent, `merge-gate`, `pr-steward` | 5 điều kiện; mặc định làn chuẩn |
| Ruleset | `.github/rulesets/main.json` | GitHub | PR bắt buộc, required check `quality` + `gitleaks` + `merge-gate` (ADR-0023; repo khung thêm `protection-guard`, `dep-audit`; dự án đích không đòi "up to date" — D-116, D-117), không bypass |

## Nguồn

- GitHub Docs — Events that trigger workflows (`check_suite` không kích cho check suite do GitHub Actions tạo; `workflow_run` chạy ở nhánh mặc định, có secret và token ghi): <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows> — đọc 2026-10-20.
- Claude Code docs — Routines (trigger `pull_request.*`, run bắt đầu từ head của PR, push nhánh `claude/` trừ khi prompt chỉ nhánh khác, danh tính GitHub của chủ Routine, trần sự kiện theo giờ): <https://code.claude.com/docs/en/routines> — đọc 2026-10-20.
- ADR-0008 (`docs/adr/0008-main-session-self-approves-decisions.md` của repo khung): phiên chính tự duyệt điểm quyết định theo tiêu chí chất lượng cuối — chủ repo yêu cầu 2026-10-15.
- `.claude/hooks/pre-bash-guard.sh`, `pre-edit-guard.sh`, `.claude/settings.json` của khung — đọc 2026-10-13.
- Claude Code docs — permission modes (`defaultMode` `auto`/`bypassPermissions` bị bỏ qua ở project settings; deny có hiệu lực mọi chế độ): <https://code.claude.com/docs/en/permission-modes> · hooks `PreToolUse` `permissionDecision`: <https://code.claude.com/docs/en/hooks> — theo `research/2026-10-13-claude-code-hooks-skills.md`, xác minh 2026-10-13.
- Khung cũ X-stored `docs/specs/AI-HARNESS-AND-COMPANY-SPEC.md` (commit `1b80fe4`) §B3.1a (làn nhanh 5 điều kiện), §B6.3 (trần rework), §B6.4 (leo thang), ASC-FR-14 (hạn cổng 24 h), §B10, §B11 (L0–L4) — đọc 2026-10-13.
- OWASP Top 10 for Agentic Applications 2026 (ASI01 Goal Hijack, ASI02 Tool Misuse, ASI03 Identity & Privilege Abuse): <https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/> — theo `research/2026-10-13-ai-agent-research.md` §5.1 [F]; trang trả 403 khi fetch lại ngày 2026-10-13.
- `seeker19110/stored` mục 12 §4 (7 quy tắc), mục 19 §1.2, mục 21 §10, mục 23 §2.3, §4.3, §4.5, §6.1 — đọc 2026-10-13.
- Catalog `seeker19110/stored` mục 20 §1.5 (guardrail của skill `call-prep`: "không retry write bị từ chối hay đổi tool để lách") — đọc 2026-10-16.
