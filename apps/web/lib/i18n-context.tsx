"use client";
// Chữ dùng chung của hạ tầng client (D-101): form gửi command, trạng thái lệnh, hộp đăng nhập lại, trạng thái route, vỏ PWA…
// render từ rất nhiều trang ⇒ không truyền prop `m` qua từng trang mà cấp một lần ở app/layout.tsx:
// `<MessagesProvider m={messagesFor("common.")}>`; component/hook gọi `tm(useMessages(), "common.…", {…})`.
// Module này KHÔNG import giá trị catalog (chỉ `import type`, D-098) — chỉ phần `common.` đi qua payload RSC.
// `scripts/i18n-check.mjs` kiểm `tm(useMessages(), "khoá", …)` như mọi lời gọi `tm`.
import { createContext, type ReactNode, useContext } from "react";
import type { Messages } from "./i18n.ts";

export type CommonMessages = Messages<"common.">;

const MessagesContext = createContext<CommonMessages | null>(null);

export function MessagesProvider({ m, children }: { m: CommonMessages; children: ReactNode }) {
  return <MessagesContext.Provider value={m}>{children}</MessagesContext.Provider>;
}

/** Chữ `common.` do `MessagesProvider` cấp. Thiếu provider là lỗi lập trình (test/route ngoài layout) ⇒ ném lỗi rõ. */
export function useMessages(): CommonMessages {
  const m = useContext(MessagesContext);
  if (!m) throw new Error("useMessages: missing <MessagesProvider> (wrap the tree, see app/layout.tsx)");
  return m;
}
