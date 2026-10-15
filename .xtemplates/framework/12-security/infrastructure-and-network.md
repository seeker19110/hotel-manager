---
title: Hạ tầng & mạng: least privilege, egress, TLS, sandbox, container
kind: module
prefix: SEC-INFRA
applies_to: [web-app, api-service, ai-agent, agentic-system, data-ml, monorepo, blockchain, static-site, mobile-app, desktop-app, embedded-iot]
updated: 2026-10-14
---

# Hạ tầng & mạng: least privilege, egress, TLS, sandbox, container

> Lớp phòng thủ dưới ứng dụng: IAM tối thiểu, mạng private + egress allowlist, TLS hiện đại, container không root/không docker.sock,
> sandbox thật (gVisor/Firecracker) cho code không tin, WAF/DDoS cơ bản. Cách viết IaC thuộc
> [`../15-operations/infrastructure-as-code.md`](../15-operations/infrastructure-as-code.md); đây là **nội dung** cấu hình phải đạt.

## Nguyên tắc

- **Zero trust**: không tin vì "ở trong mạng nội bộ"; mọi service↔service xác thực và phân quyền (NIST SP 800-207).
- **Quyền tối thiểu theo workload**: mỗi service một identity (IAM role/service account) với policy hẹp; không khoá admin dùng chung; không `*:*`.
- **Deny-by-default hai chiều**: ingress chỉ mở cổng cần; **egress allowlist theo tên miền/IP** — đây là lớp chặn exfiltration và callback của
  prompt injection/supply chain mà prompt hay WAF không làm được.
- **Mặc định an toàn, không fail-open**: không admin mặc định, không bind `0.0.0.0` khi thiếu auth, không mount `docker.sock`, không telemetry gửi
  dữ liệu khi chưa opt-in.
- **"Tiến trình con không phải sandbox"**: cách ly code không tin (code do agent sinh, plugin, upload) cần ranh giới nhân (gVisor) hoặc VM
  (Firecracker/microVM) + hạn tài nguyên + egress riêng.
- **TLS ở mọi chặng**: TLS 1.3 ưu tiên, 1.2 tối thiểu; 1.0/1.1 bị cấm (RFC 8996); nội bộ dùng mTLS/service mesh hoặc mạng private + xác thực.
- **Bảo mật đo bằng cấu hình thật**: CIS Benchmark/Pod Security Standards/checkov đọc file và cluster, không đọc tài liệu.

## Quyết định

| Nhu cầu | Mặc định | Thay thế + điều kiện |
|---|---|---|
| Chạy ứng dụng | PaaS/managed container (ít bề mặt vận hành) với IAM role riêng | Kubernetes khi ≥ M và có đội vận hành; áp Pod Security **Restricted** cho namespace ứng dụng |
| Cách ly code không tin (agent chạy lệnh, plugin, eval người dùng) | **gVisor** (`runsc`, Apache-2.0) cho container; **Firecracker** microVM (Apache-2.0) khi cần cách ly mạnh/đa tenant | Sandbox của nhà cung cấp (E2B/Modal/Managed Agents environment) khi không tự vận hành; **không** dùng `subprocess`/`chroot`/Docker thường làm sandbox cho code đối kháng |
| Egress | Deny-all + allowlist domain qua proxy/NAT có log (cloud firewall, Squid, nftables + DNS filter) | Trong sandbox agent: proxy riêng với allowlist hẹp + credential broker (xem [`secrets-management.md`](secrets-management.md)) |
| TLS cạnh (edge) | Mozilla "Intermediate" (TLS 1.2 + 1.3) cho công chúng; HSTS | "Modern" (chỉ TLS 1.3) cho API nội bộ/ứng dụng mới không cần client cũ |
| Nội bộ service↔service | Mạng private + xác thực ứng dụng (OIDC/mTLS) | Service mesh (Istio/Linkerd) khi > ~10 service cần mTLS/authz đồng nhất |
| WAF/DDoS | WAF của CDN/cloud với rule managed (OWASP CRS) ở chế độ log → chặn dần; rate limit ở edge | Tự host ModSecurity/Coraza + CRS khi không dùng CDN; chống DDoS lớp 3/4 dựa vào nhà cung cấp |
| Bridge/daemon cục bộ (dev tool, agent bridge) | Bind `127.0.0.1` + token; kiểm `Host`/`Origin`/`Sec-Fetch-Site`; tự bật auth khi bind ra ngoài | Unix socket với quyền file khi cùng máy |
| Quét cấu hình | checkov (IaC) + CIS Benchmark (OS/Docker/K8s, qua kube-bench/docker-bench) | Trivy `config`/`k8s` khi đã dùng Trivy; cloud-native (AWS Config/Security Hub) bổ sung |

## Checklist

- [ ] `SEC-INFRA-001` **MUST** Mỗi service/job có identity riêng với IAM policy tối thiểu; không policy `Action: "*"`/`Resource: "*"` ngoài break-glass có ghi lý do. → Kiểm: checkov/`iam-policy` lint = 0 wildcard; danh sách role ↔ service trong IaC. · Nguồn: NIST SP 800-207; CIS Benchmark cloud (IAM)
- [ ] `SEC-INFRA-002` **MUST** CSDL, cache, queue, kho bí mật không có địa chỉ public; chỉ reachable từ subnet/SG của ứng dụng. → Kiểm: IaC không `publicly_accessible = true`; `nmap`/cloud config scan từ ngoài → cổng đóng; checkov `CKV_AWS_17`/tương đương = 0. · Nguồn: CIS Benchmark cloud; catalog stored 07 (không publish cổng DB)
- [ ] `SEC-INFRA-003` **MUST** Ingress mở đúng cổng cần (443, và 80 chỉ để redirect); không mở SSH/RDP/DB ra `0.0.0.0/0`. → Kiểm: security group/firewall trong IaC; checkov rule cổng mở toàn cầu = 0. · Nguồn: CIS Benchmark cloud (networking)
- [ ] `SEC-INFRA-004` **MUST@L** TLS: chỉ 1.2 và 1.3 (ưu tiên 1.3), cipher theo Mozilla Intermediate; không TLS 1.0/1.1; chứng chỉ tự động gia hạn (ACME) và có cảnh báo trước hết hạn ≥ 14 ngày. → Kiểm: `testssl.sh`/`sslyze` → không có 1.0/1.1, grade A; cron/cert-manager renew; alert `cert_expiry_days < 14`. · Nguồn: RFC 8996 (BCP 195); RFC 9846 (TLS 1.3); Mozilla TLS guidelines 6.0
- [ ] `SEC-INFRA-005` **MUST@L** Container chạy **non-root**, filesystem gốc **read-only** (ghi vào volume/tmpfs được chỉ định), drop mọi capability (`ALL`, thêm lại tối thiểu), `allowPrivilegeEscalation: false`, seccomp `RuntimeDefault`. → Kiểm: Dockerfile có `USER` không root; K8s namespace label `pod-security.kubernetes.io/enforce: restricted`; `docker run --read-only --cap-drop ALL …` trong compose/manifest; checkov/kube-score = 0 vi phạm. · Nguồn: K8s Pod Security Standards (Restricted); NIST SP 800-190 §4; CIS Docker Benchmark
- [ ] `SEC-INFRA-006` **MUST@L** Không mount `docker.sock`/host PID/network/hostPath vào container ứng dụng hay agent; không `privileged`. → Kiểm: `rg "docker.sock|privileged: true|hostPID|hostNetwork|hostPath"` trong manifest/compose = 0 ngoài allowlist có review. · Nguồn: NIST SP 800-190; CIS Docker Benchmark; catalog stored 12 §3i
- [ ] `SEC-INFRA-007` **MUST@L** Code không tin (lệnh do agent sinh, plugin/skill bên thứ ba, code người dùng) chạy trong sandbox cách ly nhân/VM (gVisor/Firecracker/sandbox nhà cung cấp) với giới hạn CPU/RAM/thời gian/disk và egress riêng; `subprocess` thường không được tính là sandbox. → Kiểm: runtime class `runsc`/microVM trong cấu hình; test thoát sandbox cơ bản (đọc `/proc/1/environ` host, gọi `169.254.169.254`, ghi ngoài workspace) đều bị chặn; ADR ghi lựa chọn. · Nguồn: catalog stored 12 §4 quy tắc 4 & 7, 03 §8b; OWASP ASI05
- [ ] `SEC-INFRA-008` **MUST@L** Egress deny-by-default với allowlist domain/IP cho workload production và sandbox agent; kết nối bị chặn được log và có cảnh báo tổng hợp. → Kiểm: cấu hình firewall/proxy trong IaC; test từ pod gọi domain ngoài allowlist → bị chặn và có dòng log; alert `egress_denied_total` tăng bất thường. · Nguồn: khung cũ spec C5-FR-05; catalog stored 12 §3g; NIST SP 800-207
- [ ] `SEC-INFRA-009` **MUST@L** Metadata endpoint cloud (`169.254.169.254`) không truy cập được từ container ứng dụng/sandbox hoặc chỉ qua IMDSv2 với hop limit 1. → Kiểm: `curl -m 2 http://169.254.169.254/` từ trong container → fail; IaC đặt `http_tokens = "required"`, `http_put_response_hop_limit = 1`. · Nguồn: OWASP SSRF CS; CIS Benchmark AWS
- [ ] `SEC-INFRA-010` **MUST** Không tài khoản/mật khẩu mặc định (admin/admin, `postgres` không mật khẩu, dashboard không auth); dịch vụ quản trị (Grafana, pgAdmin, queue UI, `/metrics`) đứng sau xác thực và không public. → Kiểm: scan cấu hình: mọi dịch vụ quản trị có auth; test đăng nhập mặc định thất bại; `/metrics` trả 401/403 từ ngoài. · Nguồn: OWASP Top 10:2025 A02; catalog stored 23 §8.1
- [ ] `SEC-INFRA-011` **MUST@L** Daemon/bridge cục bộ (dev server của agent, MCP bridge, hot-reload) bind `127.0.0.1` mặc định, yêu cầu token, kiểm `Host` (chống DNS rebinding) và `Origin`/`Sec-Fetch-Site` lạ → 403; bind ra `0.0.0.0` chỉ khi có auth và cờ tường minh. → Kiểm: test khởi động mặc định → chỉ lắng nghe loopback (`ss -ltnp`); request với `Host: evil.example` → 403; thiếu token → 401. · Nguồn: catalog stored 12 §3b, 23 §8.1 (Hermes-Agents mẫu tốt; ai-gateway fail-open)
- [ ] `SEC-INFRA-012` **MUST@L** Image container tối giản (distroless/alpine/slim), chỉ chứa runtime cần; không shell/compiler/package manager trong image production khi không cần; không secret trong layer. → Kiểm: `dive`/`syft` liệt kê package; `docker history` không có `.env`; scan image = 0 critical. · Nguồn: NIST SP 800-190 §4.1
- [ ] `SEC-INFRA-013` **MUST@L** Giới hạn tài nguyên (CPU/RAM/PID/disk) cho mọi container/job để một tiến trình lỗi hoặc vòng lặp agent không hạ cả node. → Kiểm: manifest có `resources.limits`/compose `deploy.resources`; kube-score/checkov = 0 thiếu limits. · Nguồn: NIST SP 800-190; OWASP LLM 2026 LLM06 Unbounded Consumption
- [ ] `SEC-INFRA-014` **MUST@L** WAF với rule managed (OWASP CRS hoặc tương đương) và rate limit ở edge cho mọi endpoint public; bắt đầu ở chế độ log 1–2 tuần rồi chuyển chặn. → Kiểm: cấu hình WAF trong IaC; test payload mẫu (`' OR 1=1`, `<script>`) → bị chặn/log; dashboard WAF có dữ liệu. · Nguồn: OWASP CRS docs (chưa fetch lại 2026-10-13); OWASP Top 10:2025 A05
- [ ] `SEC-INFRA-015` **MUST@L** Truy cập quản trị (SSH, console, kubectl) qua bastion/SSO + MFA, không mật khẩu, có phiên ghi log; không SSH key dùng chung. → Kiểm: `PasswordAuthentication no`; IAM yêu cầu MFA cho vai trò admin; session log (SSM/Teleport) bật. · Nguồn: CIS Benchmark OS/cloud; NIST SP 800-207
- [ ] `SEC-INFRA-016` **MUST@L** mTLS hoặc xác thực OIDC cho mọi gọi service↔service nội bộ; network policy K8s deny-all mặc định giữa namespace. → Kiểm: `NetworkPolicy` default-deny tồn tại mỗi namespace; mesh/`PeerAuthentication STRICT`; test pod lạ gọi service → bị từ chối. · Nguồn: NIST SP 800-207; K8s NetworkPolicy docs
- [ ] `SEC-INFRA-017` **MUST@L** Quét tuân thủ CIS Benchmark cho OS/K8s/Docker/cloud theo lịch (kube-bench, docker-bench-security, cloud config scan) và theo dõi điểm theo thời gian. → Kiểm: job lịch tuần, báo cáo lưu; mục Level 1 fail = ticket có hạn. · Nguồn: CIS Benchmarks
- [ ] `SEC-INFRA-018` **SHOULD** Telemetry/crash report của tool và dịch vụ tự host **tắt mặc định** hoặc opt-in tường minh; không gửi URL/task/code ra ngoài. → Kiểm: cấu hình env (`DO_NOT_TRACK=1`, `*_TELEMETRY_DISABLED=1`) trong image/compose; egress allowlist chặn domain telemetry. · Nguồn: catalog stored 11 §1c, 12 §3i
- [ ] `SEC-INFRA-019` **SHOULD** OS/host tự động vá bảo mật (unattended-upgrades/managed node image) và reboot theo cửa sổ; node image tái tạo (immutable) thay vì vá tại chỗ khi dùng K8s/ASG. → Kiểm: cấu hình auto-update; tuổi image node < 30 ngày. · Nguồn: CIS Benchmark OS
- [ ] `SEC-INFRA-020` **SHOULD** DNS cho egress đi qua resolver kiểm soát được (log + chặn domain độc), không DoH tự do từ container. → Kiểm: `resolv.conf` trỏ resolver nội bộ; firewall chặn 53/853/DoH ra ngoài. · Nguồn: NIST SP 800-207
- [ ] `SEC-INFRA-021` **SHOULD** Môi trường staging cách ly tài khoản/dự án cloud riêng với production; không chia sẻ IAM/role/kho bí mật. → Kiểm: hai account/project id khác nhau trong IaC; không cross-account role từ staging sang prod. · Nguồn: [`../10-workflow/environments-and-config.md`](../10-workflow/environments-and-config.md)
- [ ] `SEC-INFRA-022` **SHOULD** Có kiểm thử thoát sandbox/escalation cơ bản trong CI cho môi trường chạy agent (đọc file ngoài workspace, gọi metadata, gọi domain ngoài allowlist, fork bomb bị giới hạn). → Kiểm: bộ test `tests/sandbox/` chạy trong job riêng, mọi ca bị chặn. · Nguồn: OWASP ASI05; khung cũ spec C2-FR-08
- [ ] `SEC-INFRA-023` **MAY** Dùng CDN/anycast + cache cho nội dung tĩnh để hấp thụ DDoS lớp 7 cơ bản; bật "under attack"/challenge khi cần. → Kiểm: cấu hình CDN; smoke test qua CDN. · Nguồn: nhà cung cấp CDN (phòng thủ)
- [ ] `SEC-INFRA-024` **MAY** Ký và verify image node/VM (Secure Boot, attestation) cho hạ tầng xử lý dữ liệu nhạy cảm. → Kiểm: cấu hình attestation; log verify. · Nguồn: NIST SP 800-190

## Bẫy thường gặp

1. **"Nội bộ nên không cần auth"** → một SSRF/một pod bị chiếm là thấy hết. Zero trust: service nội bộ vẫn xác thực (`SEC-INFRA-016`).
2. **Docker = sandbox.** Container chia sẻ nhân host; mount `docker.sock` là root host. Code đối kháng cần gVisor/microVM (`SEC-INFRA-006/007`).
3. **Gateway mở `0.0.0.0` và chỉ *cảnh báo* khi thiếu token** (ví dụ thật, catalog 23 §8.1) → chat, `/mcp`, `/metrics` mở cho internet. Tránh: fail-closed + loopback mặc định (`SEC-INFRA-011`).
4. **Egress mở toàn bộ** vì "dev cần cài package" → prompt injection gửi dữ liệu ra ngoài qua `curl`. Tránh: allowlist registry/proxy riêng, log chặn.
5. **Chứng chỉ hết hạn vào cuối tuần** vì không có cảnh báo và renew thủ công. Tránh: ACME tự động + alert 14 ngày (`SEC-INFRA-004`).
6. **IAM `*` để "làm cho chạy"** rồi để nguyên. Tránh: checkov wildcard = đỏ; review quyền theo quý.
7. **WAF bật chế độ chặn ngày đầu** → chặn người dùng thật, đội tắt WAF luôn. Tránh: log trước, chặn sau (`SEC-INFRA-014`).
8. **`/metrics`, dashboard queue, pgAdmin public không auth** — thấy nhiều ở repo cá nhân. Tránh: `SEC-INFRA-010`.
9. **Telemetry mặc định** của tool dev gửi task/URL ra ngoài (ví dụ `chrome-devtools-mcp`, codegraph theo catalog 11/16). Tránh: `SEC-INFRA-018`.
10. **Resource limit không đặt** → vòng lặp agent/leak bộ nhớ hạ cả node, kéo theo dịch vụ khác (OWASP LLM 2026 LLM06). Tránh: `SEC-INFRA-013`.

## Cổng tự động

| Việc | Công cụ (license) | Lệnh | Đặt ở | Ngưỡng |
|---|---|---|---|---|
| IaC misconfig (IAM wildcard, cổng mở, public DB, IMDSv1) | checkov 3.3.28 (Apache-2.0) | `checkov -d infra --framework terraform,kubernetes,dockerfile` | CI PR | HIGH/CRITICAL = đỏ |
| Dockerfile/compose | hadolint (GPL-3.0) + conftest | `hadolint Dockerfile`; policy cấm `privileged`, `docker.sock` | pre-commit + CI | vi phạm = đỏ |
| K8s manifest | kube-score / Pod Security Admission `restricted` | `kube-score score manifests/*.yaml`; namespace label enforce | CI + cluster | critical = đỏ; PSA từ chối pod |
| TLS | testssl.sh (GPL-2.0) hoặc sslyze (AGPL-3.0) | `testssl.sh --severity HIGH https://host` | CI đêm + sau deploy | TLS 1.0/1.1 hoặc HIGH = đỏ |
| CIS host/K8s/Docker | kube-bench, docker-bench-security (Apache-2.0) | theo lịch tuần | job lịch | Level 1 fail = ticket |
| Image | OSV-Scanner v2.7.0 / Trivy (ghim SHA + checksum) | `osv-scanner scan image <ref>` | CI build | critical = đỏ |
| Egress/metadata/sandbox | test tích hợp `tests/sandbox/` | gọi domain ngoài allowlist, `169.254.169.254`, đọc ngoài workspace | CI job riêng | bất kỳ ca thành công = đỏ |
| Loopback bridge | test khởi động + `ss -ltnp` | kiểm địa chỉ bind, `Host`/`Origin` lạ → 403 | job test | bind `0.0.0.0` không cờ = đỏ |
| Cert expiry | exporter/cron | alert `cert_expiry_days < 14` | observability | cảnh báo |

## Nguồn

- NIST SP 800-207 Zero Trust Architecture (08/2020): <https://csrc.nist.gov/pubs/sp/800/207/final> — xác minh 2026-10-13.
- NIST SP 800-190 Application Container Security Guide (09/2017): <https://csrc.nist.gov/pubs/sp/800/190/final> — xác minh 2026-10-13.
- Kubernetes Pod Security Standards (Privileged/Baseline/Restricted): <https://kubernetes.io/docs/concepts/security/pod-security-standards/> — xác minh 2026-10-13 (chi tiết Restricted: runAsNonRoot, drop ALL, seccomp RuntimeDefault, allowPrivilegeEscalation=false — phần cuối trang bị cắt khi fetch, đối chiếu lại khi dùng).
- RFC 8996 Deprecating TLS 1.0 and TLS 1.1 (BCP 195): <https://www.rfc-editor.org/rfc/rfc8996> — xác minh 2026-10-13. RFC 9846 TLS 1.3 (obsoletes RFC 8446, RFC 5246): <https://www.rfc-editor.org/info/rfc9846> — xác minh 2026-10-13.
- Mozilla Server Side TLS guidelines v6.0 (Modern = TLS 1.3; Intermediate = TLS 1.2+1.3): <https://ssl-config.mozilla.org/guidelines/latest.json> — xác minh 2026-10-13.
- CIS Benchmarks (cloud, Docker, Kubernetes, OS…): <https://www.cisecurity.org/cis-benchmarks> — xác minh 2026-10-13 (tải cần đăng ký — chưa xác minh điều kiện).
- gVisor (`runsc`, application kernel, Apache-2.0): <https://gvisor.dev/docs/> — xác minh 2026-10-13. Firecracker microVM (Apache-2.0): <https://firecracker-microvm.github.io/> — xác minh 2026-10-13.
- OWASP SSRF Prevention CS (dải IP nội bộ, IMDSv2): <https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html> — xác minh 2026-10-13.
- Catalog `seeker19110/stored` 12 §3b (bridge loopback), §3i (mặc định rủi ro), §4 quy tắc 4/7; 23 §8.1 (Hermes-Agents, ai-gateway); 11 §1c (telemetry) — đọc 2026-10-13. Khung cũ spec §A4.5 C5-FR-05 (egress allowlist), commit `1b80fe4`.
- (chưa xác minh 2026-10-13) OWASP CRS, hadolint/kube-score/testssl.sh phiên bản & license — xác minh trước khi dùng.
