// Test component: bọc cây render bằng `MessagesProvider` như app/layout.tsx (D-101) — hạ tầng client (CommandForm,
// CommandStatus, useCommand, ReauthDialog, RouteError…) gọi `useMessages()` và ném lỗi nếu thiếu provider.
// Dùng: `render(ui, { wrapper: WithMessages })`, `renderHook(fn, { wrapper: WithMessages })`. Chỉ test import tệp này.
import type { ReactNode } from "react";
import { messagesFor } from "../../lib/i18n.ts";
import { MessagesProvider } from "../../lib/i18n-context.tsx";

/** Chữ `common.` thật từ catalog (cùng dữ liệu layout truyền xuống). */
export const commonMessages = messagesFor("common.");

export function WithMessages({ children }: { children: ReactNode }) {
  return <MessagesProvider m={commonMessages}>{children}</MessagesProvider>;
}
