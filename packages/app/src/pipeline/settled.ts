// Kết quả của bước "chuẩn bị" chạy ngoài transaction lệnh (D-025): giữ lỗi lại để ném bên trong handler, nhờ đó pipeline
// vẫn ghi `failed` + audit như lỗi trong lệnh. Đặt ở pipeline (không ở files) để http không phụ thuộc files (ARC-MOD-004).
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

export function unwrap<T>(s: Settled<T>): T {
  if (!s.ok) throw s.error;
  return s.value;
}
