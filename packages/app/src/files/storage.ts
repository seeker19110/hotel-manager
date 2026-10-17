// Object storage S3-tương thích tự host (SeaweedFS — ADR-0002). Bucket riêng tư; đọc chỉ qua URL ký ngắn hạn.
// PLAN đợt 4 T-302 (ARC-RES-001, BE-REL-001/003): mỗi lời gọi mạng có `AbortSignal.timeout` và retry ≤ 3 lần (lùi mũ + jitter,
// tôn trọng `Retry-After`) — CHỈ thao tác idempotent (GET/HEAD/PUT theo key/DELETE); phương thức khác gọi đúng một lần.
import { AwsClient } from "aws4fetch";

export interface StorageResilience {
  /** Trần thời gian MỖI lần gọi (ms). */
  timeoutMs: number;
  /** Số lần thử lại tối đa sau lần đầu (≤ 3). */
  maxRetries: number;
  /** Nền của lùi mũ (ms): chờ ≈ base·2^lần-thử-lại, nhân jitter ∈ [0,5; 1]. */
  baseDelayMs: number;
  /** Trần một lần chờ, kể cả khi `Retry-After` đòi lâu hơn (ms). */
  maxDelayMs: number;
  /** Tiêm cho test: nguồn ngẫu nhiên ∈ [0,1) và hàm chờ. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RESILIENCE: StorageResilience = {
  timeoutMs: 15_000,
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
};

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  resilience?: Partial<StorageResilience>;
}

/** Phương thức có thể gửi lại an toàn: kết quả như nhau dù server đã nhận lần trước hay chưa. */
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE"]);
const MAX_RETRIES_CAP = 3;

/** Lỗi kho object. `retryable`: lỗi tạm (mạng/hết giờ/5xx/429/408) — người gọi có thể thử lại ở tầng trên. */
export class StorageError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  constructor(message: string, opts: { status?: number; retryable: boolean; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "StorageError";
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

function retryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/** `Retry-After`: số giây hoặc ngày HTTP; không hiểu/âm → undefined. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  // Ngày HTTP luôn có tên thứ/tháng; chuỗi chỉ số/dấu ("-5") không phải ngày hợp lệ.
  const at = /[a-z]/i.test(v) ? Date.parse(v) : Number.NaN;
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** URL ký tối đa 5 phút (ADR-0002, TM-06). */
export const MAX_SIGNED_URL_SECONDS = 300;

export class ObjectStorage {
  readonly #aws: AwsClient;
  readonly #cfg: StorageConfig;
  readonly #res: StorageResilience;

  constructor(cfg: StorageConfig) {
    this.#cfg = cfg;
    const r = { ...DEFAULT_RESILIENCE, ...cfg.resilience };
    this.#res = { ...r, maxRetries: Math.min(Math.max(0, Math.floor(r.maxRetries)), MAX_RETRIES_CAP) };
    // `retries: 0`: vòng thử lại của aws4fetch (10 lần, không timeout) bị thay bằng vòng của lớp này.
    this.#aws = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: "s3",
      region: cfg.region,
      retries: 0,
    });
  }

  /**
   * Một thao tác kho: ký lại MỖI lần thử (dấu thời gian mới), `AbortSignal.timeout` mỗi lần, thử lại lỗi tạm với lùi mũ + jitter.
   * `ok` quyết định phản hồi nào là thành công; còn lại → StorageError (4xx khác 408/429 không bao giờ thử lại).
   */
  async #send(
    label: string,
    url: string,
    init: { method: string; body?: Uint8Array<ArrayBuffer>; headers?: Record<string, string> },
    ok: (status: number) => boolean,
    over: Partial<Pick<StorageResilience, "timeoutMs" | "maxRetries">> = {},
  ): Promise<void> {
    const cfg = { ...this.#res, ...over };
    const retries = IDEMPOTENT.has(init.method) ? Math.min(cfg.maxRetries, MAX_RETRIES_CAP) : 0;
    const random = cfg.random ?? Math.random;
    const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      let failure: StorageError;
      let retryAfterMs: number | undefined;
      // Ký ngoài `try`: lỗi ký là lỗi lập trình/cấu hình, không phải lỗi tạm — không thử lại.
      const req = await this.#aws.sign(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs) });
      try {
        const res = await fetch(req);
        if (ok(res.status)) {
          await res.body?.cancel();
          return;
        }
        retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        await res.body?.cancel();
        failure = new StorageError(`${label}: HTTP ${res.status}`, {
          status: res.status,
          retryable: retryableStatus(res.status),
        });
      } catch (err) {
        const timedOut =
          err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
        failure = new StorageError(`${label}: ${timedOut ? "quá thời gian" : "lỗi kết nối"}`, {
          retryable: true,
          cause: err,
        });
      }
      if (!failure.retryable || attempt >= retries) throw failure;
      const exp = Math.min(cfg.baseDelayMs * 2 ** attempt, cfg.maxDelayMs);
      const jittered = exp * (0.5 + random() * 0.5);
      await sleep(Math.min(Math.max(retryAfterMs ?? 0, jittered), cfg.maxDelayMs));
    }
  }

  #url(key: string): string {
    const k = key
      .split("/")
      .map((p) => encodeURIComponent(p))
      .join("/");
    return `${this.#cfg.endpoint.replace(/\/$/, "")}/${this.#cfg.bucket}/${k}`;
  }

  async ensureBucket(): Promise<void> {
    await this.#send(
      "Không tạo được bucket",
      `${this.#cfg.endpoint.replace(/\/$/, "")}/${this.#cfg.bucket}`,
      { method: "PUT" },
      (st) => (st >= 200 && st < 300) || st === 409,
    );
  }

  /** Kiểm kho còn trả lời và bucket tồn tại (`/api/ready`). */
  async ping(): Promise<void> {
    // Không thử lại: `/api/ready` tự có trần 3 giây và phải phản ánh trạng thái hiện tại, không che bằng retry.
    await this.#send(
      "Kho object không sẵn sàng",
      `${this.#cfg.endpoint.replace(/\/$/, "")}/${this.#cfg.bucket}`,
      { method: "HEAD" },
      (st) => st >= 200 && st < 300,
      { maxRetries: 0, timeoutMs: Math.min(this.#res.timeoutMs, 2_500) },
    );
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.#send(
      "Ghi object lỗi",
      this.#url(key),
      {
        method: "PUT",
        // Bản sao nền ArrayBuffer: kiểu BodyInit của lib DOM (apps/web) không nhận Uint8Array<ArrayBufferLike>.
        body: new Uint8Array(body),
        headers: { "content-type": contentType, "content-length": String(body.byteLength) },
      },
      (st) => st >= 200 && st < 300,
    );
  }

  async delete(key: string): Promise<void> {
    await this.#send(
      "Xoá object lỗi",
      this.#url(key),
      { method: "DELETE" },
      (st) => (st >= 200 && st < 300) || st === 404,
    );
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
