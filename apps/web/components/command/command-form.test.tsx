// @vitest-environment happy-dom
// FE-TEST-001/003: form gửi command — truy vấn theo vai trò/nhãn; mạng (`fetch`) và `next/navigation` được giả (không mạng thật).
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// Vỏ PWA kéo theo Serwist (cần trình duyệt thật); chỉ cần `useOnline`/`reportClientOutdated` của module đó.
vi.mock("@serwist/turbopack/react", () => ({
  SerwistProvider: ({ children }: { children: unknown }) => children,
  useSerwist: () => ({ serwist: null }),
}));

import { WithMessages } from "../testing/with-messages.tsx";
import { CommandForm, type FieldSpec } from "./command-form.tsx";

const UNIT = "2f1b1f0e-6b1e-4a0e-8d54-0d3a1c8a9e11";
const fields: FieldSpec[] = [
  { name: "unit_id", label: "Phòng", type: "select", options: [{ value: UNIT, label: "101 · Hoa Sen" }] },
  {
    name: "kind",
    label: "Loại việc",
    type: "select",
    options: [
      { value: "cleaning", label: "Dọn phòng" },
      { value: "inspection", label: "Kiểm tra phòng" },
    ],
  },
  { name: "note", label: "Ghi chú", maxLength: 2000 },
];
const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const fetchMock = vi.fn<typeof fetch>();
/** Tham số `init` của lần gọi `fetch` thứ i (lần gọi không tồn tại → ném lỗi, test đỏ rõ ràng). */
function initOf(i: number): RequestInit {
  const call = fetchMock.mock.calls[i];
  if (!call) throw new Error(`fetch chưa được gọi lần thứ ${i + 1}`);
  return call[1] ?? {};
}
const keyOf = (i: number) => (initOf(i).headers as Record<string, string>)["idempotency-key"];

function setup(props: Partial<Parameters<typeof CommandForm>[0]> = {}) {
  return render(
    <CommandForm
      path="housekeeping/createTask"
      fields={fields}
      submitLabel="Tạo việc"
      successText="Đã tạo việc."
      {...(props as object)}
    />,
    { wrapper: WithMessages },
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  router.refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommandForm", () => {
  it("gửi một POST có Idempotency-Key và thân đúng; thành công báo role=status rồi làm mới trang", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { task_id: "t1" } }));
    setup();
    await userEvent.type(screen.getByLabelText("Ghi chú"), "Dọn kỹ — khách VIP");
    await userEvent.click(screen.getByRole("button", { name: "Tạo việc" }));

    expect((await screen.findByRole("status")).textContent).toBe("Đã tạo việc.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = initOf(0);
    const headers = init.headers as Record<string, string>;
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/housekeeping/createTask");
    expect(init.method).toBe("POST");
    expect(headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(init.body))).toEqual({
      unit_id: UNIT,
      kind: "cleaning",
      note: "Dọn kỹ — khách VIP",
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("ô bắt buộc để trống: báo lỗi đúng ô (role=alert, aria-invalid) và KHÔNG gửi gì", async () => {
    setup({ fields: [{ name: "note", label: "Lý do", required: true }] });
    await userEvent.click(screen.getByRole("button", { name: "Tạo việc" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Bắt buộc nhập");
    expect(screen.getByLabelText("Lý do").getAttribute("aria-invalid")).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("toàn khoảng trắng coi như rỗng", async () => {
    setup({ fields: [{ name: "note", label: "Lý do", required: true }] });
    await userEvent.type(screen.getByLabelText("Lý do"), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Tạo việc" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Bắt buộc nhập");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ô tiền sai định dạng: lỗi theo ô, không gửi", async () => {
    setup({
      path: "payment/collectCash",
      fields: [{ name: "amount", label: "Số tiền", type: "money", required: true }],
    });
    await userEvent.type(screen.getByLabelText("Số tiền"), "abc");
    await userEvent.click(screen.getByRole("button", { name: "Tạo việc" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Nhập số nguyên đồng");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ô tiền nhập "0" (bắt buộc, schema cho phép 0): không có role=alert, thân gửi opening_cash là số 0 (không rỗng, không chuỗi)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    setup({
      path: "shift/open",
      fixed: { property_id: UNIT },
      fields: [{ name: "opening_cash", label: "Tiền đầu ca", type: "money", required: true }],
    });
    await userEvent.type(screen.getByLabelText("Tiền đầu ca"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Tạo việc" }));
    expect((await screen.findByRole("status")).textContent).toBe("Đã tạo việc.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(initOf(0).body));
    expect(body).toEqual({ property_id: UNIT, opening_cash: 0 });
    expect(typeof body.opening_cash).toBe("number");
  });

  it("bấm đúp: đúng một POST (UX-STATE-006) và nút khoá khi đang gửi", async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
    setup();
    const btn = screen.getByRole("button", { name: "Tạo việc" }) as HTMLButtonElement;
    await userEvent.dblClick(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(jsonResponse(200, { data: {} }));
    expect((await screen.findByRole("status")).textContent).toBe("Đã tạo việc.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lỗi nghiệp vụ 4xx: hiện đúng thông điệp server (role=alert), không làm mới trang, nút mở lại", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { code: "UNIT_BUSY", status: 409, detail: "Phòng đang có việc dọn chưa xong." }),
    );
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Tạo việc" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Phòng đang có việc dọn chưa xong.");
    expect(router.refresh).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Tạo việc" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("5xx: KHÔNG lộ `detail` nội bộ của server; chỉ câu chung kèm mã tra cứu", async () => {
    // 5xx → tra kết quả theo Idempotency-Key: GET trả 404 ⇒ "chưa rõ server đã nhận", cho Gửi lại cùng key.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(500, {
          code: "INTERNAL",
          detail: "pg: relation hold_x does not exist",
          correlation_id: "abc-123",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(404, { code: "COMMAND_NOT_FOUND" }));
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Tạo việc" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Mã tra cứu: abc-123");
    expect(document.body.textContent).not.toContain("hold_x");
    expect(screen.getByRole("button", { name: "Gửi lại" })).toBeTruthy();
  });

  it("mất mạng khi gửi (fetch ném lỗi) rồi tra thấy 404: bật Gửi lại và gửi lại dùng CÙNG Idempotency-Key", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse(404, { code: "COMMAND_NOT_FOUND" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Tạo việc" }));
    await userEvent.click(await screen.findByRole("button", { name: "Gửi lại" }));
    expect((await screen.findByRole("status")).textContent).toBe("Đã tạo việc.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(keyOf(2)).toBe(keyOf(0));
  });

  it("thao tác không hoàn tác: hộp xác nhận nêu đúng giá trị, 'Quay lại' không gửi gì, xác nhận mới gửi", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: {} }));
    setup({
      path: "housekeeping/createTask",
      confirm: "Việc dọn sẽ được tạo ngay.",
      confirmLabel: "Tạo việc cho {note}",
    });
    await userEvent.type(screen.getByLabelText("Ghi chú"), "phòng 101");
    await userEvent.click(screen.getByRole("button", { name: "Tạo việc" }));

    const dialog = await screen.findByRole("dialog", { hidden: true });
    expect(dialog.textContent).toContain("Tạo việc cho phòng 101");
    await userEvent.click(screen.getByRole("button", { name: "Quay lại", hidden: true }));
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Tạo việc" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Tạo việc cho phòng 101", hidden: true }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("không có trường nào (nút một chạm): vẫn gửi thân từ `fixed`", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    setup({ path: "housekeeping/startTask", fields: [], fixed: { task_id: UNIT }, submitLabel: "Bắt đầu" });
    await userEvent.click(screen.getByRole("button", { name: "Bắt đầu" }));
    await screen.findByRole("status");
    expect(JSON.parse(String(initOf(0).body))).toEqual({ task_id: UNIT });
  });

  describe("resultLink (lệnh trả URL — vd tải bản xuất nhật ký, T-2313)", () => {
    const linkProps = {
      path: "exports/download",
      fields: [],
      fixed: { export_id: UNIT },
      submitLabel: "Chuẩn bị tải",
      successText: "Đã sẵn sàng.",
      resultLink: { label: "Tải tệp", testId: "dl" },
    };

    it("thành công có `url` an toàn: hiện liên kết tải đúng href; gửi lại thành công thay URL mới", async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(200, { data: { url: "https://files.example/a.csv?sig=1", expiresIn: 300 } }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, { data: { url: "https://files.example/a.csv?sig=2", expiresIn: 300 } }),
        );
      setup(linkProps);
      expect(screen.queryByRole("link", { name: "Tải tệp" })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Chuẩn bị tải" }));
      const link = await screen.findByRole("link", { name: "Tải tệp" });
      expect(link.getAttribute("href")).toBe("https://files.example/a.csv?sig=1");
      expect(link.hasAttribute("download")).toBe(true);
      expect(link.textContent).toBe("Tải tệp");
      expect(JSON.parse(String(initOf(0).body))).toEqual({ export_id: UNIT });

      await userEvent.click(screen.getByRole("button", { name: "Chuẩn bị tải" }));
      await waitFor(() =>
        expect(screen.getByRole("link", { name: "Tải tệp" }).getAttribute("href")).toBe(
          "https://files.example/a.csv?sig=2",
        ),
      );
    });

    it("URL không an toàn (javascript:) hoặc thiếu `url`: không hiện liên kết", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { url: "javascript:alert(1)" } }));
      setup(linkProps);
      await userEvent.click(screen.getByRole("button", { name: "Chuẩn bị tải" }));
      await screen.findByRole("status");
      expect(screen.queryByRole("link", { name: "Tải tệp" })).toBeNull();
      cleanup();

      fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: {} }));
      setup(linkProps);
      await userEvent.click(screen.getByRole("button", { name: "Chuẩn bị tải" }));
      await screen.findByRole("status");
      expect(screen.queryByRole("link", { name: "Tải tệp" })).toBeNull();
    });

    it("lỗi 4xx: không hiện liên kết", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(404, { code: "NOT_FOUND", status: 404, detail: "Không tìm thấy bản xuất." }),
      );
      setup(linkProps);
      await userEvent.click(screen.getByRole("button", { name: "Chuẩn bị tải" }));
      await screen.findByRole("alert");
      expect(screen.queryByRole("link", { name: "Tải tệp" })).toBeNull();
    });

    it("không khai `resultLink`: kết quả có `url` cũng không hiện liên kết", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { url: "https://files.example/a.csv" } }));
      const { resultLink: _omit, ...withoutLink } = linkProps;
      setup(withoutLink);
      await userEvent.click(screen.getByRole("button", { name: "Chuẩn bị tải" }));
      await screen.findByRole("status");
      expect(screen.queryByRole("link")).toBeNull();
    });
  });
});
