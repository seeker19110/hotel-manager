---
title: IaC: Terraform/Pulumi/compose, drift, review, policy-as-code
kind: module
prefix: OPS-IAC
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, static-site]
updated: 2026-10-15
---

# IaC: Terraform/Pulumi/compose, drift, review, policy-as-code

> Hạ tầng được khai báo trong code, đi qua PR có `plan`, được quét policy-as-code, có state khoá và mã hoá, và được phát hiện drift
> theo lịch. Nội dung cấu hình bảo mật phải đạt nằm ở [`../12-security/infrastructure-and-network.md`](../12-security/infrastructure-and-network.md);
> bí mật trong IaC ở [`../12-security/secrets-management.md`](../12-security/secrets-management.md).

## Nguyên tắc

- **Không sửa tay hạ tầng production**: mọi thay đổi là commit → plan trong PR → review → apply bằng CI với identity riêng. Sửa tay = drift = sự cố nhỏ.
- **Plan là bằng chứng**: PR hạ tầng kèm output `plan` (số tài nguyên add/change/destroy); `destroy` hoặc `replace` tài nguyên có dữ liệu cần người duyệt riêng.
- **State là bí mật**: state chứa output nhạy cảm → backend từ xa, mã hoá at-rest, khoá (lock), versioning, quyền hẹp; không commit state.
- **Policy-as-code chạy trước apply**: checkov/conftest/OPA đọc plan JSON — chặn public bucket, IAM `*`, cổng mở, thiếu tag, thiếu mã hoá.
- **Module nhỏ, môi trường tách**: mỗi môi trường một state/workspace và một tài khoản/dự án cloud; module tái dùng ghim phiên bản.
- **Idempotent và tái lập được**: `apply` chạy hai lần không đổi gì; môi trường mới dựng được từ code + backup trong thời gian RTO (xem [`backup-and-disaster-recovery.md`](backup-and-disaster-recovery.md)).

## Quyết định

| Nhu cầu | Mặc định | Thay thế + điều kiện |
|---|---|---|
| IaC đa cloud, khai báo HCL | **OpenTofu** v1.13.1 (**MPL-2.0**, Linux Foundation) — tương thích HCL/provider Terraform | **Terraform** (HashiCorp, **BUSL-1.1** từ 1.6; dùng được cho sản phẩm của mình, hạn chế khi xây dịch vụ cạnh tranh với HashiCorp — đọc license FAQ) khi đã có hệ sinh thái/đội quen hoặc cần tính năng chỉ có ở Terraform/HCP; ghi ADR |
| IaC bằng ngôn ngữ lập trình | **Pulumi** (Apache-2.0; TS/Python/Go/.NET) khi đội mạnh lập trình và cần logic phức tạp/test đơn vị | CDK/CDKTF khi khoá một cloud; vẫn xuất plan trước apply |
| Dev/local và dự án S | **Docker Compose** (`compose.yaml`) cho stack local; `.env.example` không giá trị thật | Compose cho production chỉ với 1 máy, có backup/monitor; ≥ M → managed container/K8s qua IaC |
| Kubernetes manifest | Helm/Kustomize commit trong repo, deploy qua GitOps (Argo CD/Flux) | `kubectl apply` tay chỉ ở dev |
| Policy-as-code | **checkov** 3.3.28 (Apache-2.0) cho Terraform/K8s/Dockerfile/CloudFormation + **conftest** v0.71.1 (Rego) cho rule riêng | Trivy `config` nếu đã dùng Trivy; OPA Gatekeeper/Kyverno trong cluster cho admission |
| State backend | Object storage có versioning + mã hoá + khoá (S3+DynamoDB, GCS, Azure Blob) hoặc HCP/Spacelift/env0 | Local state **chỉ** cho thử nghiệm bỏ đi |
| Drift | Job lịch `plan -detailed-exitcode` → cảnh báo khi exit 2; hoặc dịch vụ drift detection | Với K8s GitOps: Argo CD/Flux tự báo OutOfSync |
| Chi phí trước apply | Infracost (Apache-2.0) comment ước tính chi phí vào PR | Bỏ qua ở S; bắt buộc ≥ M (xem [`cost-management.md`](cost-management.md)) |

## Checklist

- [ ] `OPS-IAC-001` **MUST** Mọi tài nguyên cloud/hạ tầng production khai báo trong IaC trong repo; không tạo tay. → Kiểm: drift job `plan -detailed-exitcode` = 0 (không lệch); inventory cloud (CLI) đối chiếu với state: tài nguyên ngoài state = 0 (ngoại lệ có file ghi lý do). · Nguồn: NIST SSDF PO.3 (toolchain); P5
- [ ] `OPS-IAC-002` **MUST@L** PR hạ tầng đính kèm output `plan` (hoặc `pulumi preview`) tự động do CI sinh; apply chỉ chạy từ CI sau merge với plan đã lưu (`-out=plan.tfplan` → `apply plan.tfplan`). → Kiểm: workflow có job `plan` comment vào PR; job `apply` dùng artifact plan, không plan lại. · Nguồn: Terraform/OpenTofu docs (plan file); P8
- [ ] `OPS-IAC-003` **MUST** State ở backend từ xa có **khoá** (locking), **versioning**, **mã hoá at-rest**, quyền đọc/ghi hẹp (chỉ identity CI + admin); `.tfstate*` trong `.gitignore`. → Kiểm: cấu hình backend trong code; `git ls-files | grep tfstate` = 0; bucket có versioning + encryption (checkov). · Nguồn: Terraform docs — state locking; [`../12-security/secrets-management.md`](../12-security/secrets-management.md)
- [ ] `OPS-IAC-004` **MUST** Không bí mật trong IaC/compose: giá trị nhạy cảm lấy từ kho bí mật (data source) hoặc biến CI; output nhạy cảm đánh dấu `sensitive = true`. → Kiểm: checkov `CKV_SECRET_*` = 0; gitleaks quét thư mục `infra/`; grep `password = "` = 0. · Nguồn: OWASP Secrets Mgmt CS
- [ ] `OPS-IAC-005` **MUST@L** Policy-as-code chạy trên mỗi PR hạ tầng (checkov trên code + conftest/OPA trên plan JSON): chặn public storage, IAM wildcard, cổng mở `0.0.0.0/0` cho port quản trị, thiếu mã hoá, thiếu tag bắt buộc, thiếu log. → Kiểm: job policy là required check; `checkov -d infra --quiet --compact` = 0 HIGH/CRITICAL; `conftest test plan.json -p policy/` = 0 deny. · Nguồn: catalog stored 12 §3 (OPA/conftest); CIS Benchmark cloud
- [ ] `OPS-IAC-006` **MUST** Hành động phá huỷ (plan có `destroy`/`replace` tài nguyên có dữ liệu: CSDL, bucket, volume, queue) cần người duyệt riêng và `prevent_destroy`/deletion protection trên tài nguyên dữ liệu. → Kiểm: `lifecycle { prevent_destroy = true }` hoặc `deletion_protection = true` trên CSDL/bucket; CI đọc plan JSON, có `delete` tài nguyên dữ liệu → yêu cầu label `approved-destroy`. · Nguồn: P8; AGENTS.md §5 (điểm dừng bắt buộc về hành động)
- [ ] `OPS-IAC-007` **MUST@L** Mỗi môi trường (dev/staging/prod) có state riêng, tài khoản/dự án cloud riêng, identity apply riêng; không dùng `-var env=prod` trên cùng state. → Kiểm: cấu trúc `envs/<env>/` hoặc workspace + backend key khác nhau; account id khác nhau. · Nguồn: [`../10-workflow/environments-and-config.md`](../10-workflow/environments-and-config.md)
- [ ] `OPS-IAC-008` **MUST@L** Phiên bản tool và provider/module ghim: `required_version`, `required_providers` với ràng buộc + lockfile (`.terraform.lock.hcl` commit); module từ registry ghim phiên bản, từ git ghim commit. → Kiểm: lockfile commit; `rg 'source = "git::' infra | grep -v ref=` = 0; CI `init -lockfile=readonly`. · Nguồn: Terraform/OpenTofu docs (dependency lock); [`../12-security/supply-chain.md`](../12-security/supply-chain.md)
- [ ] `OPS-IAC-009` **MUST@L** Format + validate + lint trong pre-commit và CI (`fmt -check`, `validate`, tflint/pulumi lint, hadolint cho Dockerfile, `docker compose config` cho compose). → Kiểm: job lint hạ tầng là required check. · Nguồn: P9
- [ ] `OPS-IAC-010` **MUST@L** Drift detection theo lịch (≥ hàng ngày) với cảnh báo khi state ≠ thực tế; drift được xử lý bằng commit (import hoặc sửa code), không bằng sửa tay. → Kiểm: workflow `schedule` chạy `plan -detailed-exitcode`; alert khi exit 2; log xử lý drift trong PR. · Nguồn: OpenTofu/Terraform docs (`-detailed-exitcode`)
- [ ] `OPS-IAC-011` **MUST@L** Tag/label bắt buộc trên mọi tài nguyên (`env`, `service`, `owner`, `cost-center`) để phân bổ chi phí và truy trách nhiệm; policy chặn thiếu tag. → Kiểm: `default_tags` provider + conftest rule thiếu tag = deny. · Nguồn: FinOps FOCUS (phân bổ); [`cost-management.md`](cost-management.md)
- [ ] `OPS-IAC-012` **MUST@L** Ước tính chi phí thay đổi hạ tầng hiện trong PR (Infracost hoặc tương đương); tăng > ngưỡng đội chọn cần duyệt. → Kiểm: comment Infracost trên PR; ngưỡng trong cấu hình. · Nguồn: Infracost docs (chưa xác minh phiên bản 2026-10-13)
- [ ] `OPS-IAC-013` **MUST@L** Môi trường dựng lại được từ IaC + backup trên tài khoản sạch trong thời gian ≤ RTO; diễn tập ≥ 1 lần/năm có bằng chứng. → Kiểm: log diễn tập (`docs/ops/dr-drills.md`) với thời gian; xem [`backup-and-disaster-recovery.md`](backup-and-disaster-recovery.md). · Nguồn: NIST SP 800-34r1
- [ ] `OPS-IAC-014` **MUST@L** Identity apply của CI có quyền tối thiểu theo môi trường, lấy qua OIDC ngắn hạn; apply production cần approval environment; audit log ghi ai apply gì. → Kiểm: environment `production` có required reviewers; không khoá tĩnh; CloudTrail/Audit Log ghi identity CI. · Nguồn: GitHub Actions hardening (OIDC); NIST SP 800-207
- [ ] `OPS-IAC-015` **SHOULD** Module tái dùng có test (terratest/`terraform test`/pulumi unit test) và ví dụ; thay đổi module qua semver. → Kiểm: thư mục `tests/` của module; CI chạy. · Nguồn: Terraform docs `test` (chưa xác minh phiên bản tính năng)
- [ ] `OPS-IAC-016` **SHOULD** Compose/K8s manifest cho dev giống production về cấu trúc (cùng image, cùng biến) khác về kích thước; `docker compose config` hợp lệ trong CI. → Kiểm: job `compose config --quiet`; image tag giống pipeline. · Nguồn: P5
- [ ] `OPS-IAC-017` **SHOULD** Thay đổi hạ tầng có cửa sổ và kế hoạch rollback (apply ngược plan cũ/`state` version trước) ghi trong PR; thay đổi đổi mạng/DB lên lịch ngoài giờ cao điểm. → Kiểm: template PR hạ tầng có mục Rollback. · Nguồn: P8; [`deployment-strategies.md`](deployment-strategies.md)
- [ ] `OPS-IAC-018` **SHOULD** Ghim phiên bản IaC tool theo endoflife.date và nâng trong vòng hỗ trợ (ví dụ Terraform 1.13 EOL 2026-04-29, 1.14 EOL 2026-08-26; OpenTofu 1.11 EOL 2026-08-19). → Kiểm: `required_version` không thuộc cycle đã EOL (script đọc API endoflife). · Nguồn: endoflife.date (xác minh 2026-10-13)
- [ ] `OPS-IAC-019` **MAY** GitOps cho K8s (Argo CD/Flux) với auto-sync chỉ ở dev/staging, production sync thủ công/có cổng. → Kiểm: `syncPolicy` theo môi trường. · Nguồn: Argo CD/Flux docs (chưa xác minh phiên bản)
- [ ] `OPS-IAC-020` **MAY** Sơ đồ hạ tầng sinh từ IaC (`terraform graph`/Pulumi/inframap) commit cùng code để tài liệu không trôi. → Kiểm: job sinh sơ đồ; diff = 0 sau sinh. · Nguồn: P5

## Bẫy thường gặp

1. **Sửa tay "cho nhanh" lúc sự cố rồi quên** → lần apply sau xoá thay đổi tay, sự cố tái diễn. Tránh: drift job + ghi lại mọi thay đổi lúc chữa cháy ([`incident-response.md`](incident-response.md)).
2. **State local hoặc trong git** → hai người apply cùng lúc, state hỏng, bí mật lộ. Tránh: `OPS-IAC-003`.
3. **`apply` plan lại sau merge** khác với plan đã review → thay đổi không ai duyệt. Tránh: apply từ artifact plan (`OPS-IAC-002`).
4. **`force-unlock` khi "thấy kẹt"** trong khi người khác đang apply → state hỏng. Chỉ unlock lock của mình với lock ID (Terraform docs).
5. **Một state cho mọi môi trường** với biến `env` → lỗi ở dev kéo prod. Tránh: `OPS-IAC-007`.
6. **Không `prevent_destroy` trên CSDL** → đổi tên tài nguyên = destroy + create = mất dữ liệu. Tránh: `OPS-IAC-006`.
7. **Module từ git không ghim ref** → upstream đổi, plan bất ngờ. Tránh: `OPS-IAC-008`.
8. **Nhầm license**: Terraform là BUSL-1.1 (không OSI) — ổn cho sản phẩm nội bộ nhưng cần review nếu xây dịch vụ IaC/hosting; OpenTofu MPL-2.0. Ghi ADR.
9. **Policy chỉ chạy trên code, không trên plan** → giá trị từ biến/data source lọt (vd CIDR từ biến). Tránh: conftest trên plan JSON (`OPS-IAC-005`).
10. **Compose production không backup/monitor** vì "chỉ một máy". Compose ở prod vẫn cần [`backup-and-disaster-recovery.md`](backup-and-disaster-recovery.md) + [`observability.md`](observability.md).

## Cổng tự động

| Việc | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| Format/validate | `tofu fmt -check -recursive`; `tofu validate`; `pulumi preview` | — | pre-commit + CI | lỗi = đỏ |
| Lint | tflint (MPL-2.0); hadolint (GPL-3.0); `docker compose config -q` | — | pre-commit + CI | lỗi = đỏ |
| Policy trên code | checkov 3.3.28 (Apache-2.0) | `checkov -d infra --framework terraform,kubernetes,dockerfile,helm` | CI PR | HIGH/CRITICAL = đỏ |
| Policy trên plan | conftest v0.71.1 (Apache-2.0) | `tofu show -json plan.tfplan > plan.json && conftest test plan.json -p policy/` | CI PR | deny = đỏ |
| Plan trong PR | CI job + comment | `tofu plan -out=plan.tfplan -detailed-exitcode` | CI PR | destroy tài nguyên dữ liệu → cần label duyệt |
| Apply | CI job với OIDC + environment approval | `tofu apply plan.tfplan` | sau merge | chỉ từ CI |
| Drift | lịch hàng ngày | `tofu plan -detailed-exitcode` | CI `schedule` | exit 2 = cảnh báo |
| Bí mật | gitleaks + checkov secrets | `gitleaks detect -s infra` | CI | finding = đỏ |
| Chi phí | Infracost (Apache-2.0) | `infracost diff --path infra` → comment PR | CI PR | tăng > ngưỡng = cần duyệt |
| EOL tool | script đọc `https://endoflife.date/api/terraform.json` / `opentofu.json` | — | CI lịch tuần | cycle EOL = cảnh báo |

## Nguồn

- OpenTofu v1.13.1, license MPL-2.0 (LICENSE repo), dưới Linux Foundation: <https://github.com/opentofu/opentofu/releases/latest>, <https://github.com/opentofu/opentofu/blob/main/LICENSE>, <https://opentofu.org/> — xác minh 2026-10-13.
- Terraform license Business Source License 1.1: <https://github.com/hashicorp/terraform/blob/main/LICENSE> — xác minh 2026-10-13; Terraform state locking & `force-unlock`: <https://developer.hashicorp.com/terraform/language/state/locking> — xác minh 2026-10-13.
- Pulumi Apache-2.0: <https://github.com/pulumi/pulumi/blob/master/LICENSE> — xác minh 2026-10-13.
- checkov 3.3.28 (Apache-2.0): <https://pypi.org/pypi/checkov/json>; conftest v0.71.1: <https://github.com/open-policy-agent/conftest/releases/latest> — xác minh 2026-10-13 (trang GitHub không hiện năm).
- endoflife.date: Terraform 1.13 EOL 2026-04-29, 1.14 EOL 2026-08-26; OpenTofu 1.10 EOL 2026-09-30, 1.11 EOL 2026-08-19, 1.12 EOL 2027-02-01, 1.13 EOL 2027-08-01: <https://endoflife.date/api/terraform.json>, <https://endoflife.date/api/opentofu.json> — xác minh 2026-10-13.
- CIS Benchmarks (cloud): <https://www.cisecurity.org/cis-benchmarks> — xác minh 2026-10-13.
- GitHub Actions security hardening (OIDC, environment): <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions> — xác minh 2026-10-13.
- (chưa xác minh 2026-10-13) Infracost, tflint, Argo CD/Flux, Terratest phiên bản; Terraform license FAQ chi tiết — xác minh trước khi dùng.
- Catalog `seeker19110/stored` 13 §3 (Terraform BSL vs OpenTofu MPL), 12 §3 (OPA/conftest), đọc 2026-10-13.
