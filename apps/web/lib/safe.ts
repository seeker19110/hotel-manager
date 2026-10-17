// Bọc lời gọi đọc dữ liệu ở Server Component: lỗi nghiệp vụ có mã/status < 500 (AuthzError, CommandError, AccessError) thành
// kết quả để trang tự chọn 404 / thông báo; lỗi khác (500, hỏng hạ tầng) ném tiếp để Next hiện trang lỗi.
export type Safe<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string };

export async function safe<T>(p: Promise<T>): Promise<Safe<T>> {
  try {
    return { ok: true, data: await p };
  } catch (e) {
    const x = e as { status?: unknown; code?: unknown };
    if (e instanceof Error && typeof x.status === "number" && x.status < 500 && typeof x.code === "string")
      return { ok: false, status: x.status, code: x.code, message: e.message };
    throw e;
  }
}
