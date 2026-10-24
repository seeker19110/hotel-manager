// @vitest-environment happy-dom
// FE-TEST-001/003: hook `useCommand` — mạng giả, đồng hồ giả; kiểm idempotency (cùng key), offline, 401 → đăng nhập lại.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@serwist/turbopack/react", () => ({
  SerwistProvider: ({ children }: { children: unknown }) => children,
  useSerwist: () => ({ serwist: null }),
}));

import { tm } from "../../lib/i18n-format.ts";
import { commonMessages as cm, WithMessages } from "../testing/with-messages.tsx";
import { problemText, useCommand } from "./use-command.ts";

const SERVER_ERROR_TEXT = tm(cm, "common.command.server_error");

const UNIT = "2f1b1f0e-6b1e-4a0e-8d54-0d3a1c8a9e11";
const body = { unit_id: UNIT, kind: "cleaning" };
const json = (status: number, b: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
const fetchMock = vi.fn<typeof fetch>();
/** Tham số `init` của lần gọi `fetch` thứ i (lần gọi không tồn tại → ném lỗi, test đỏ rõ ràng). */
function initOf(i: number): RequestInit {
  const call = fetchMock.mock.calls[i];
  if (!call) throw new Error(`fetch chưa được gọi lần thứ ${i + 1}`);
  return call[1] ?? {};
}
const keyOf = (i: number) => (initOf(i).headers as Record<string, string>)["idempotency-key"];

beforeEach(() => {
  fetchMock.mockReset();
  router.refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("problemText", () => {
  it("null → null; 5xx không lộ detail; mã tra cứu chỉ nhận ký tự an toàn", () => {
    expect(problemText(cm, null)).toBeNull();
    // Chữ cố định (không lấy từ catalog): catalog đổi/hỏng message thì test này đỏ thay vì so catalog với chính nó.
    expect(problemText(cm, { code: "X", status: 500, detail: "bí mật nội bộ" })).toBe(
      "Hệ thống đang gặp lỗi, thao tác chưa thực hiện được. Vui lòng thử lại sau ít phút.",
    );
    expect(problemText(cm, { code: "X", status: 503, correlation_id: "ab-12" })).toBe(
      "Hệ thống đang gặp lỗi, thao tác chưa thực hiện được. Vui lòng thử lại sau ít phút. Mã tra cứu: ab-12.",
    );
    expect(problemText(cm, { code: "X", status: 500, correlation_id: "<script>" })).toBe(SERVER_ERROR_TEXT);
  });
  it("4xx: ưu tiên detail, rồi title, rồi câu mặc định", () => {
    expect(problemText(cm, { code: "X", status: 422, detail: "d", title: "t" })).toBe("d");
    expect(problemText(cm, { code: "X", status: 422, title: "t" })).toBe("t");
    expect(problemText(cm, { code: "X", status: 422 })).toBe("Không thực hiện được. Vui lòng thử lại.");
  });
});

describe("useCommand", () => {
  it("thành công: phase done, trả dữ liệu, một POST", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: { task_id: "t1" } }));
    const { result } = renderHook(() => useCommand<{ task_id: string }>("housekeeping/createTask"), {
      wrapper: WithMessages,
    });
    expect(result.current.phase).toBe("idle");
    let r: unknown;
    await act(async () => {
      r = await result.current.send(body);
    });
    expect(r).toEqual({ task_id: "t1" });
    expect(result.current.phase).toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("thân sai schema: không gọi mạng, báo VALIDATION_FAILED theo trường", async () => {
    const { result } = renderHook(() => useCommand("housekeeping/createTask"), { wrapper: WithMessages });
    await act(async () => {
      await result.current.send({ unit_id: "không-phải-uuid", kind: "cleaning" });
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("error");
    expect(result.current.problem?.code).toBe("VALIDATION_FAILED");
    expect(result.current.problem?.errors?.map((e) => e.field)).toEqual(["unit_id"]);
  });

  it("bấm gửi hai lần lúc đang tải schema (nạp trễ): chỉ MỘT lệnh, một key", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    const { result } = renderHook(() => useCommand("housekeeping/createTask"), { wrapper: WithMessages });
    await act(async () => {
      await Promise.all([result.current.send(body), result.current.send(body)]);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mất mạng trình duyệt: không gửi, báo OFFLINE", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { result } = renderHook(() => useCommand("housekeeping/createTask"), { wrapper: WithMessages });
    await act(async () => {
      await result.current.send(body);
    });
    vi.restoreAllMocks();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.problem).toMatchObject({
      code: "OFFLINE",
      detail: "Không có kết nối mạng. Thao tác chưa được gửi.",
    });
    expect(result.current.phase).toBe("error");
  });

  it("chưa rõ kết quả thì gửi payload KHÁC bị từ chối (không ghi đè dưới key cũ); gửi lại dùng cùng key", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(json(404, { code: "COMMAND_NOT_FOUND" }))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }));
    const { result } = renderHook(() => useCommand("housekeeping/createTask"), { wrapper: WithMessages });
    await act(async () => {
      await result.current.send(body);
    });
    expect(result.current.phase).toBe("unknown");
    expect(result.current.locked).toBe(true);

    await act(async () => {
      await result.current.send({ ...body, kind: "inspection" });
    });
    expect(result.current.problem).toMatchObject({
      code: "PENDING_UNKNOWN",
      detail: tm(cm, "common.command.pending"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await result.current.resend();
    });
    expect(result.current.phase).toBe("done");
    expect(keyOf(2)).toBe(keyOf(0));
  });

  it("lỗi nghiệp vụ 4xx giải key: lần sửa sau dùng key MỚI (tránh IDEMPOTENCY_CONFLICT)", async () => {
    fetchMock
      .mockResolvedValueOnce(json(422, { code: "UNIT_BUSY", status: 422, detail: "Bận" }))
      .mockResolvedValueOnce(json(200, { data: {} }));
    const { result } = renderHook(() => useCommand("housekeeping/createTask"), { wrapper: WithMessages });
    await act(async () => {
      await result.current.send(body);
    });
    expect(result.current.phase).toBe("error");
    await act(async () => {
      await result.current.send({ ...body, kind: "inspection" });
    });
    expect(result.current.phase).toBe("done");
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("409 đang xử lý: đợi Retry-After (đồng hồ giả) rồi tra theo key, KHÔNG gửi POST thứ hai", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json(409, { code: "IDEMPOTENCY_IN_PROGRESS" }, { "retry-after": "2" }))
      .mockResolvedValueOnce(json(200, { status: "committed", data: { done: true } }));
    const { result } = renderHook(() => useCommand("housekeeping/createTask"), { wrapper: WithMessages });
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = result.current.send(body);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.phase).toBe("checking");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await pending;
    });
    expect(result.current.phase).toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(initOf(1).method).not.toBe("POST");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`/api/v1/commands/${keyOf(0)}`);
  });
});
