// Bộ schema `input` của mọi lệnh (`@hm/app/command-inputs`, kéo theo zod — ~120 KB chưa nén) chỉ cần khi người dùng GỬI form,
// nên nạp trễ thay vì đi cùng JS ban đầu của mọi trang có `CommandForm` (LCP `/thong-bao` vượt ngân sách Lighthouse 2,5 s).
// `prefetchCommandInputs` gọi khi người dùng bắt đầu tương tác với form để lần gửi đầu không phải chờ tải.
// Không tải được (mất mạng, chunk lỗi) ⇒ bỏ lưới kiểm phía client cho lần đó: server vẫn validate lại mọi lệnh (FE-FORM-001).
type Check = typeof import("@hm/app/command-inputs").checkCommandInput;

let loading: Promise<Check | null> | null = null;

export function loadCommandInputs(): Promise<Check | null> {
  loading ??= import("@hm/app/command-inputs").then(
    (m) => m.checkCommandInput,
    () => {
      loading = null; // lần sau thử tải lại
      return null;
    },
  );
  return loading;
}

export function prefetchCommandInputs(): void {
  void loadCommandInputs();
}

/** Kiểm thân lệnh bằng schema của registry; chưa tải được schema ⇒ `null` (như lệnh không có schema client). */
export async function checkCommandInputLazy(path: string, body: unknown): Promise<ReturnType<Check>> {
  const check = await loadCommandInputs();
  return check ? check(path, body) : null;
}
