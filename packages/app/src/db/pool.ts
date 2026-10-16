// Pool kết nối Postgres có trần thời gian (PLAN đợt 4 T-302; DB-PERF-004, ARC-RES-001): không chờ kết nối vô hạn khi CSDL
// đầy/treo, và trả kết nối nhàn rỗi để không giữ slot của máy chủ. Mọi `pg.Pool` của sản phẩm đi qua đây.
import pg from "pg";

/** Chờ lấy/mở kết nối tối đa 5 giây (hết hạn → lỗi, request trả 5xx thay vì treo). */
export const CONNECTION_TIMEOUT_MS = 5_000;
/** Kết nối nhàn rỗi quá 30 giây thì đóng. */
export const IDLE_TIMEOUT_MS = 30_000;

export interface PoolOptions {
  max: number;
  /** Tuỳ chọn khởi động phiên của libpq, vd `-c search_path=auth`. */
  options?: string;
  /** Lỗi trên kết nối nhàn rỗi (CSDL khởi động lại…). Mặc định bỏ qua: pool tự bỏ client hỏng, lần sau mở kết nối mới. */
  onError?: (err: Error) => void;
}

export function createPool(connectionString: string, opts: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    ...(opts.options ? { options: opts.options } : {}),
  });
  // Không có handler thì `error` của client nhàn rỗi làm sập cả tiến trình.
  pool.on("error", (err) => opts.onError?.(err));
  return pool;
}
