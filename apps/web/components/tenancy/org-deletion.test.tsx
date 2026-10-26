// @vitest-environment happy-dom
// T-2403: 2xx chưa bảo đảm đã huỷ xoá; chỉ trạng thái active xác nhận tổ chức hoạt động lại.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { router, connection } = vi.hoisted(() => ({
  router: { refresh: vi.fn() },
  connection: { online: true },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("../pwa/pwa-shell.tsx", () => ({ useOnline: () => connection.online }));

import { messagesFor, t } from "../../lib/i18n.ts";
import { CancelOrgDeletion } from "./org-deletion.tsx";

const m = messagesFor("org_deletion.", "tenant_login_form.", "auth_form.");
const fetchMock = vi.fn<typeof fetch>();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  fetchMock.mockReset();
  router.refresh.mockReset();
  connection.online = true;
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function submit() {
  await userEvent.click(screen.getByRole("button", { name: t("org_deletion.cancel") }));
}

describe("CancelOrgDeletion", () => {
  it.each([true, false])(
    "status active, cancelled=%s ⇒ thông báo thành công và tải lại",
    async (cancelled) => {
      fetchMock.mockResolvedValueOnce(json(200, { data: { cancelled, status: "active" } }));
      render(<CancelOrgDeletion m={m} />);
      await submit();
      await vi.waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
      expect(screen.getByRole("status").textContent).toBe(t("org_deletion.cancelled"));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
    },
  );

  it("worker đã bắt đầu xoá ⇒ báo không thể huỷ, không thông báo thành công hoặc tải lại", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: { cancelled: false, status: "pending_deletion" } }));
    render(<CancelOrgDeletion m={m} />);
    await submit();
    expect((await screen.findByRole("alert")).textContent).toBe(t("org_deletion.cancel_unavailable"));
    expect(screen.getByRole("status").textContent).toBe("");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it.each([{}, null, { data: null }, { data: { cancelled: true } }, { data: { status: "suspended" } }])(
    "phản hồi thiếu/sai trạng thái (%j) ⇒ báo thất bại, không báo thành công",
    async (payload) => {
      fetchMock.mockResolvedValueOnce(json(200, payload));
      render(<CancelOrgDeletion m={m} />);
      await submit();
      expect((await screen.findByRole("alert")).textContent).toBe(t("org_deletion.error.failed"));
      expect(screen.getByRole("status").textContent).toBe("");
      expect(router.refresh).not.toHaveBeenCalled();
    },
  );

  it.each([403, 500])("HTTP %i ⇒ giữ thông báo lỗi tương ứng", async (status) => {
    fetchMock.mockResolvedValueOnce(json(status, {}));
    render(<CancelOrgDeletion m={m} />);
    await submit();
    expect((await screen.findByRole("alert")).textContent).toBe(
      t(status === 403 ? "org_deletion.error.forbidden" : "org_deletion.error.failed"),
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("lỗi mạng ⇒ báo thất bại; offline ⇒ không gửi yêu cầu", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network"));
    const view = render(<CancelOrgDeletion m={m} />);
    await submit();
    expect((await screen.findByRole("alert")).textContent).toBe(t("org_deletion.error.failed"));
    connection.online = false;
    view.rerender(<CancelOrgDeletion m={m} />);
    await submit();
    expect(screen.getByRole("alert").textContent).toBe(t("org_deletion.error.offline"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("lần thử sau bị từ chối ⇒ xoá thông báo thành công cũ", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { data: { cancelled: true, status: "active" } }))
      .mockResolvedValueOnce(json(200, { data: { cancelled: false, status: "pending_deletion" } }));
    render(<CancelOrgDeletion m={m} />);
    await submit();
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    await submit();
    expect((await screen.findByRole("alert")).textContent).toBe(t("org_deletion.cancel_unavailable"));
    expect(screen.getByRole("status").textContent).toBe("");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});
