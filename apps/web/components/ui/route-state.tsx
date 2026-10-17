"use client";
import { Button } from "./button.tsx";
// Trạng thái cấp route cho Next (`loading.tsx` / `error.tsx`) dựng trên `components/ui/state.tsx` (PLAN đợt 5 T-411,
// UX-STATE-001/005): đang tải = khung xương có chữ cho trình đọc màn hình; lỗi = CÂU CHUNG + mã tra cứu (digest) + nút
// "Thử lại" — KHÔNG hiện `error.message` (có thể chứa SQL/đường dẫn/tên bảng).
import { ErrorState, LoadingState } from "./state.tsx";

export const ROUTE_ERROR_TEXT =
  "Hệ thống đang gặp lỗi, màn hình này chưa tải được. Hãy thử lại; nếu vẫn lỗi, báo kèm mã tra cứu bên dưới.";

export function RouteLoading({ title }: { title: string }) {
  return (
    <main id="main" className="page" aria-busy="true">
      <h1>{title}</h1>
      <LoadingState label={`Đang tải ${title.toLowerCase()}…`} />
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
  const code = error.digest && /^[\w-]{1,64}$/.test(error.digest) ? error.digest : null;
  return (
    <main id="main" className="page">
      <h1>{title}</h1>
      <ErrorState
        title="Không tải được màn hình"
        text={code ? `${ROUTE_ERROR_TEXT} Mã tra cứu: ${code}.` : ROUTE_ERROR_TEXT}
        action={<Button onClick={reset}>Thử lại</Button>}
      />
    </main>
  );
}
