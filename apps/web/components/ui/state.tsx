import type { ReactNode } from "react";

/** Đang tải: khung xương + chữ cho trình đọc màn hình (không chỉ hiệu ứng hình). */
export function LoadingState({ label = "Đang tải…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: dòng khung xương tĩnh, không đổi thứ tự
        <div key={i} className="skeleton" aria-hidden="true" />
      ))}
    </div>
  );
}

export function EmptyState({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="state">
      <p className="state__title">{title}</p>
      {text ? <p className="state__text">{text}</p> : null}
      {action}
    </div>
  );
}

/** Lỗi chặn: role="alert"; luôn kèm hướng sửa (thử lại / liên hệ). */
export function ErrorState({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">{title}</p>
      <p className="state__text">{text}</p>
      {action}
    </div>
  );
}
