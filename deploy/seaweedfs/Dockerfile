# SeaweedFS tự dựng (D-110): image `chrislusf/seaweedfs:4.48` dựng bằng Go 1.26.8 với `golang.org/x/net` v0.58.0 (GO-2026-6612 …)
# trên Alpine chưa vá (zlib, brotli-libs); 4.49 chưa có image. Ở đây biên dịch đúng commit của tag 4.48 (khớp nhãn revision của image
# chính thức) theo cách của docker/Dockerfile.go_build thượng nguồn (CGO_ENABLED=0, không build tag), bằng Go 1.26.10 và
# x/net v0.61.0 (go.sum kiểm qua sum.golang.org + `go mod verify`). Chỉ lấy `weed`: compose chạy `server` (Go); bỏ hai nhị phân Rust
# (weed-volume, weed-worker) cùng fuse/curl/libssl chỉ chúng hoặc `weed mount` cần. entrypoint.sh và filer.toml lấy từ chính commit
# đó (Apache-2.0) nên `command: ["server", …]` của deploy/compose.yaml chạy như image chính thức (hạ quyền xuống user seaweed).
FROM golang:1.26.10-alpine3.24@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba AS build
ARG SEAWEEDFS_VERSION=4.48
ARG SEAWEEDFS_COMMIT=530be3e37337488ecc34d58441e0bc476e121c93
RUN apk add --no-cache git \
 && git clone --quiet --depth 1 --branch "$SEAWEEDFS_VERSION" https://github.com/seaweedfs/seaweedfs /src \
 && test "$(git -C /src rev-parse HEAD)" = "$SEAWEEDFS_COMMIT"
WORKDIR /src
RUN go get golang.org/x/net@v0.61.0 && go mod verify
RUN cd weed \
 && CGO_ENABLED=0 go build -trimpath \
      -ldflags "-extldflags -static -X github.com/seaweedfs/seaweedfs/weed/util/version.COMMIT=$(git rev-parse --short HEAD)" \
      -o /out/weed . \
 && /out/weed version

FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
# `apk upgrade`: lấy bản vá Alpine mới nhất mỗi lần dựng; su-exec cho entrypoint.sh hạ quyền.
RUN apk upgrade --no-cache \
 && apk add --no-cache su-exec \
 && addgroup -g 1000 seaweed \
 && adduser -D -u 1000 -G seaweed seaweed \
 && mkdir -p /etc/seaweedfs /data/filerldb2
COPY --from=build /out/weed /usr/bin/weed
COPY --from=build /src/docker/filer.toml /etc/seaweedfs/filer.toml
COPY --from=build /src/docker/entrypoint.sh /entrypoint.sh
RUN chown -R seaweed:seaweed /data /etc/seaweedfs && chmod 755 /entrypoint.sh
LABEL org.opencontainers.image.title="hm-seaweedfs" \
      org.opencontainers.image.version="4.48" \
      org.opencontainers.image.revision="530be3e37337488ecc34d58441e0bc476e121c93" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/seaweedfs/seaweedfs"
EXPOSE 7333 8080 18080 8333 8888 18888 9333 19333
VOLUME /data
WORKDIR /data
ENTRYPOINT ["/entrypoint.sh"]
CMD ["mini", "-dir=/data"]
