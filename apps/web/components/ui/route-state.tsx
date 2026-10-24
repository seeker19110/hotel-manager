"use client";
// Trạng thái cấp route cho Next (`loading.tsx` / `error.tsx`) dựng trên `components/ui/state.tsx` (PLAN đợt 5 T-411,
// UX-STATE-001/005): đang tải = khung xương có chữ cho trình đọc màn hình; lỗi = CÂU CHUNG + mã tra cứu (digest) + nút
// "Thử lại" — KHÔNG hiện `error.message` (có thể chứa SQL/đường dẫn/tên bảng).
// Chữ từ `useMessages()` (D-101): `error.tsx` nằm dưới app/layout.tsx nên có provider; dự án không có `global-error.tsx`
// (nếu thêm: nó thay cả layout ⇒ tự bọc `MessagesProvider` hoặc không dùng component này).
import { useMessages } from "../../lib/i18n-context.tsx";
import { tm } from "../../lib/i18n-format.ts";
import { Button } from "./button.tsx";
import { ErrorState, LoadingState } from "./state.tsx";

export function RouteLoading({ title }: { title: string }) {
  const m = useMessages();
  return (
    <main id="main" className="page" aria-busy="true">
      <h1>{title}</h1>
      <LoadingState label={tm(m, "common.route.loading", { title: title.toLowerCase() })} />
    </main>
  );
}

export function RouteError({
  title,
  error,
  reset,
}: {
  title: string;
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const m = useMessages();
  const code = error.digest && /^[\w-]{1,64}$/.test(error.digest) ? error.digest : null;
  return (
    <main id="main" className="page">
      <h1>{title}</h1>
      <ErrorState
        title={tm(m, "common.route.error_title")}
        text={code ? tm(m, "common.route.error_ref", { code }) : tm(m, "common.route.error")}
        action={<Button onClick={reset}>{tm(m, "common.retry")}</Button>}
      />
    </main>
  );
}
