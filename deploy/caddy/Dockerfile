# Caddy tự dựng (D-110): nhị phân phát hành v2.11.7 và image `caddy:2.11.7-alpine` dựng bằng Go 1.26.8 (GO-2026-6612 …) trên Alpine
# chưa vá (zlib, brotli-libs) và thượng nguồn chưa dựng lại. Ở đây biên dịch đúng v2.11.7 với các module chuẩn — `main.go` chép
# nguyên từ caddyserver/caddy@v2.11.7 cmd/caddy (Apache-2.0) — bằng Go 1.26.10, `golang.org/x/net` v0.61.0 (go.mod/go.sum trong thư
# mục này, kiểm bằng `go mod verify`), rồi đặt lên Alpine 3.24 đã cập nhật. Cấu hình chạy giống image chính thức (biến XDG, cổng,
# WORKDIR, CMD) nên deploy/compose.yaml không đổi cách dùng. Nâng Caddy: sửa go.mod (`go get github.com/caddyserver/caddy/v2@vX`),
# chép lại main.go của tag đó, `go mod tidy`.
FROM golang:1.26.10-alpine3.24@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/caddy .

FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
# `apk upgrade`: lấy bản vá Alpine mới nhất mỗi lần dựng (image-scan quét đúng image vừa dựng). mailcap = /etc/mime.types cho file_server.
RUN apk upgrade --no-cache \
 && apk add --no-cache ca-certificates libcap mailcap \
 && mkdir -p /config/caddy /data/caddy /etc/caddy /usr/share/caddy \
 && chmod 1777 /config/caddy /data/caddy
# Chép + setcap trong MỘT layer (BuildKit bind mount từ stage build): `COPY` rồi `RUN setcap` ghi nhị phân 58 MB thêm lần nữa
# (image 125 MB > ngân sách 80 MB). Nghe 80/443 không cần root đầy đủ (như image chính thức); `caddy version` hỏng là dựng hỏng.
RUN --mount=type=bind,from=build,source=/out/caddy,target=/tmp/caddy \
    install -m 0755 /tmp/caddy /usr/bin/caddy \
 && setcap cap_net_bind_service=+ep /usr/bin/caddy \
 && caddy version
ENV XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/data
LABEL org.opencontainers.image.title="hm-caddy" \
      org.opencontainers.image.version="v2.11.7" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/caddyserver/caddy"
EXPOSE 80 443 443/udp 2019
WORKDIR /srv
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
