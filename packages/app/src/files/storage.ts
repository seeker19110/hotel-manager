// Object storage S3-tương thích tự host (SeaweedFS — ADR-0002). Bucket riêng tư; đọc chỉ qua URL ký ngắn hạn.
import { AwsClient } from "aws4fetch";

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** URL ký tối đa 5 phút (ADR-0002, TM-06). */
export const MAX_SIGNED_URL_SECONDS = 300;

export class ObjectStorage {
  readonly #aws: AwsClient;
  readonly #cfg: StorageConfig;

  constructor(cfg: StorageConfig) {
    this.#cfg = cfg;
    this.#aws = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: "s3",
      region: cfg.region,
    });
  }

  #url(key: string): string {
    const k = key
      .split("/")
      .map((p) => encodeURIComponent(p))
      .join("/");
    return `${this.#cfg.endpoint.replace(/\/$/, "")}/${this.#cfg.bucket}/${k}`;
  }

  async ensureBucket(): Promise<void> {
    const res = await this.#aws.fetch(`${this.#cfg.endpoint.replace(/\/$/, "")}/${this.#cfg.bucket}`, {
      method: "PUT",
    });
    if (!res.ok && res.status !== 409) throw new Error(`Không tạo được bucket: HTTP ${res.status}`);
  }

  /** Kiểm kho còn trả lời và bucket tồn tại (`/api/ready`). */
  async ping(): Promise<void> {
    const res = await this.#aws.fetch(`${this.#cfg.endpoint.replace(/\/$/, "")}/${this.#cfg.bucket}`, {
      method: "HEAD",
    });
    if (!res.ok) throw new Error(`Kho object không sẵn sàng: HTTP ${res.status}`);
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const res = await this.#aws.fetch(this.#url(key), {
      method: "PUT",
      // Bản sao nền ArrayBuffer: kiểu BodyInit của lib DOM (apps/web) không nhận Uint8Array<ArrayBufferLike>.
      body: new Uint8Array(body),
      headers: { "content-type": contentType, "content-length": String(body.byteLength) },
    });
    if (!res.ok) throw new Error(`Ghi object lỗi: HTTP ${res.status}`);
  }

  async delete(key: string): Promise<void> {
    const res = await this.#aws.fetch(this.#url(key), { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`Xoá object lỗi: HTTP ${res.status}`);
  }

  /** URL GET ký sẵn, hết hạn sau `seconds` (≤ 300). Chỉ gọi SAU khi đã kiểm quyền. */
  async signedGetUrl(key: string, seconds = MAX_SIGNED_URL_SECONDS): Promise<string> {
    const ttl = Math.min(Math.max(1, Math.floor(seconds)), MAX_SIGNED_URL_SECONDS);
    const u = new URL(this.#url(key));
    u.searchParams.set("X-Amz-Expires", String(ttl));
    const signed = await this.#aws.sign(u.toString(), { method: "GET", aws: { signQuery: true } });
    return signed.url;
  }
}
