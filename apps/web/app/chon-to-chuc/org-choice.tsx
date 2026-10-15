"use client";
// Một lựa chọn tổ chức: xoá dữ liệu người dùng trên máy (S-020) rồi mới gửi form chọn ngữ cảnh.
// Không có JS thì form vẫn gửi bình thường (server vẫn đối chiếu membership).
import type { FormEvent } from "react";
import { clearUserData } from "../../components/pwa/pwa-shell.tsx";

export function OrgChoice({
  organizationId,
  label,
  meta,
}: {
  organizationId: string;
  label: string;
  meta: string;
}) {
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    await clearUserData();
    form.submit();
  }
  return (
    <form method="post" action="/api/v1/session/organization" onSubmit={onSubmit}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <button type="submit" className="btn btn--secondary choice-list__item">
        <span>{label}</span>
        <span className="choice-list__meta">{meta}</span>
      </button>
    </form>
  );
}
