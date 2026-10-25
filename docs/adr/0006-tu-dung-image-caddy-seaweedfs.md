---
status: accepted
implementation-status: implemented
date: 2026-10-25
decision-makers: chủ dự án ("tự dựng image vá cho caddy và seaweedfs", 2026-10-25); phiên chính (chi tiết kỹ thuật, D-110)
consulted: .grype.yaml + docs/ops/VULN-SLA.md (D-067, D-094, D-109); cấu hình image chính thức caddy:2.11.7-alpine và chrislusf/seaweedfs:4.48 (registry, 2026-10-25); seaweedfs/seaweedfs@4.48 docker/Dockerfile.go_build, docker/entrypoint.sh; caddyserver/caddy@v2.11.7 cmd/caddy/main.go
informed: đội phát triển
---

# ADR-0006: Tự dựng image Caddy và SeaweedFS từ mã nguồn bằng Go đã vá

Bổ sung [ADR-0002](0002-self-host-auth-storage-backup.md) (chọn Caddy và SeaweedFS — không đổi). ADR-0002 ghi compose ghim digest
`chrislusf/seaweedfs:4.48`; từ ADR này hai dịch vụ dựng tại chỗ như `deploy/postgres` (ADR-0002 không sửa nội dung).

## Bối cảnh

- Image chính thức `caddy:2.11.7-alpine` và `chrislusf/seaweedfs:4.48` chứa nhị phân dựng bằng Go 1.26.8, `golang.org/x/net` v0.58/0.59.
  Chúng dính GO-2026-6612 (Critical, HTTP/2 server) cùng 9 mã High. Alpine trong image cũng chưa vá zlib (CVE-2026-85091) và
  brotli-libs (CVE-2026-111497, Critical).
- Từ 2026-10-18, `image-scan` chỉ xanh nhờ 24 luật bỏ qua có hạn (D-067). Đã gia hạn hai lần (D-094, D-109). Thượng nguồn:
  - Caddy chưa có bản sau v2.11.7; tag dựng lại vẫn tải nhị phân cũ.
  - SeaweedFS 4.49 đã gắn tag nhưng chưa có image.
- Quá hạn thì `image-scan` (required check) chặn mọi merge, mà production không được chạy image có lỗ hổng Critical đã có bản sửa.

## Quyết định

Tự dựng hai image trong repo, multi-stage, mọi `FROM` ghim digest:

- **`deploy/caddy/`**
  - Biên dịch Caddy v2.11.7 với các module chuẩn: `main.go` chép nguyên `cmd/caddy/main.go` của tag.
  - `go.mod`/`go.sum` trong repo (`go mod verify`), `golang.org/x/net` v0.61.0, dựng bằng `golang:1.26.10-alpine3.24`.
  - Chạy trên `alpine:3.24.3` + `apk upgrade`; `setcap cap_net_bind_service` như image chính thức.
  - Biến XDG, cổng, WORKDIR, CMD giữ như image chính thức.
- **`deploy/seaweedfs/`**
  - Clone tag 4.48 và kiểm đúng commit `530be3e` (khớp nhãn revision của image chính thức).
  - `go get golang.org/x/net@v0.61.0` + `go mod verify`; biên dịch `weed` như `docker/Dockerfile.go_build` thượng nguồn (`CGO_ENABLED=0`, không build tag).
  - Runtime `alpine:3.24.3` + `apk upgrade` + `su-exec`. `entrypoint.sh`/`filer.toml` lấy từ chính commit đó, user `seaweed` (uid 1000).
  - Chỉ lấy `weed`: compose chạy `server`, không cần `weed-volume`/`weed-worker` (Rust), fuse, curl.
- **Nối vào hệ thống:**
  - `deploy/compose.yaml` dùng `build: ./caddy`, `build: ./seaweedfs`.
  - `image-scan` (supply-chain.yml) và job `assets` (release.yml) dựng từ Dockerfile rồi quét/sinh SBOM chính image đó.
  - Dependabot theo dõi `docker` (digest image nền) và `gomod` (`deploy/caddy`).
  - `eol-check` đọc Caddy từ `deploy/caddy/go.mod`, Go và Alpine từ `FROM`.
- Gỡ 24 luật bỏ qua của hai image. Kiểm cục bộ bằng grype v0.118.0 (cùng bản CI):
  - nhị phân `weed`: 0 lỗ hổng có bản sửa;
  - nhị phân `caddy`: chỉ còn 1 Medium (`go-chi/chi` v5.3.2), dưới ngưỡng chặn;
  - `alpine:3.24.3`: 0.

## Các phương án đã cân nhắc

1. **Dựng từ mã nguồn bằng Go đã vá (chọn).** Vá cả nhị phân Go lẫn OS. Giữ đúng phiên bản ứng dụng (v2.11.7, 4.48 commit cũ) nên
   không đổi hành vi. Đổi lại phải tự bảo trì hai Dockerfile, và CI dựng SeaweedFS từ mã nguồn mất thêm vài phút trong job `image-scan`.
2. **Image dẫn xuất `FROM <chính thức> + apk upgrade`.** Đơn giản, nhưng chỉ vá zlib/brotli. Nhị phân Go 1.26.8 vẫn dính
   GO-2026-6612 Critical, nên vẫn phải gia hạn ngoại lệ.
3. **Tiếp tục gia hạn ngoại lệ, chờ thượng nguồn.** Đã gia hạn hai lần; không có ngày ra bản vá; không được lên production như vậy.
4. **Nâng lên SeaweedFS 4.49 (mã nguồn).** Vá bằng thượng nguồn, nhưng đổi phiên bản ứng dụng ngoài phạm vi vá lỗ hổng. Để Dependabot
   hoặc PR nâng riêng làm khi image chính thức có.

## Điều kiện xem lại

- Thượng nguồn phát hành image dựng bằng Go ≥ 1.26.9 / x/net ≥ 0.60 trên Alpine đã vá. Khi đó cân nhắc quay lại image chính thức
  (bớt mã tự bảo trì), với điều kiện `image-scan` xanh không cần ngoại lệ.
- Nâng Caddy hoặc SeaweedFS lên phiên bản mới: sửa `go.mod`/`main.go` (Caddy) hoặc `SEAWEEDFS_VERSION`/`SEAWEEDFS_COMMIT`, cùng PR.
- Job `image-scan (seaweedfs)` gần chạm trần 20 phút: cân nhắc cache hoặc tách bước dựng.

## Hệ quả

- Image chạy thật được quét và sinh SBOM đúng thứ được dựng; ngoại lệ grype chỉ còn cho npm đi kèm image node và `zod` 3 của CI.
- Dựng image cần mạng tới `github.com` (clone SeaweedFS) và `proxy.golang.org`/`sum.golang.org` (module Go) lúc build.
- Đường lùi: trả `image:` chính thức (digest cũ) trong compose, ma trận `image-scan` và release.yml, rồi khôi phục các luật bỏ qua
  có hạn (lịch sử git của `.grype.yaml`). Không có dữ liệu cần chuyển: volume `seaweed`, `caddy_data`, `caddy_config` giữ nguyên
  đường dẫn và uid như image chính thức.
