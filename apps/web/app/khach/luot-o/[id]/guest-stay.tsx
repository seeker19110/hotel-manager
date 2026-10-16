"use client";
// Khách mở liên kết lượt ở (SPEC-portal S-016…S-020): token ở fragment URL (`#t=<token>`) — không gửi lên server/log/Referer;
// gửi bằng header `X-Guest-Token`. Bước hai: 4 số cuối SĐT người đặt (`X-Guest-Verify`). Không gọi API trước khi khách nhập đủ 4
// số, vì mỗi lần thiếu/sai bước hai bị tính là một lần sai (5 lần khoá liên kết).
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../../../../components/ui/button.tsx";
import { TextField } from "../../../../components/ui/field.tsx";
import { ErrorState, LoadingState } from "../../../../components/ui/state.tsx";
import { timedFetch } from "../../../../lib/fetch-timeout.ts";
import { day, vnd } from "../../../../lib/format.ts";

interface GuestView {
  stay: {
    status: string;
    arrivalDate: string;
    departureDate: string;
    unitCode: string;
    reservationNumber: string;
  };
  folio: {
    charges: { description: string; businessDate: string; amount: number }[];
    total: number;
    paid: number;
    balance: number;
  };
}

const STAY_STATUS: Record<string, string> = {
  expected: "Sắp đến",
  in_house: "Đang ở",
  checked_out: "Đã trả phòng",
  cancelled: "Đã huỷ",
  no_show: "Không đến",
};

type State =
  | { kind: "ask" }
  | { kind: "loading" }
  | { kind: "ok"; view: GuestView }
  | { kind: "dead"; title: string; text: string };

const EXPIRED = "Liên kết đã hết hạn. Vui lòng liên hệ lễ tân để nhận liên kết mới.";
const REVOKED = "Liên kết không còn hiệu lực. Vui lòng liên hệ lễ tân.";

function tokenFromFragment(): string | null {
  const m = /(?:^#|&)t=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  return m?.[1] ?? null;
}

export function GuestStay({ stayId }: { stayId: string }) {
  const [state, setState] = useState<State>({ kind: "ask" });
  const [error, setError] = useState<string | undefined>();
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const read = () => {
      // Mã khác (đổi fragment) ⇒ bắt đầu lại từ bước xác minh, không giữ dữ liệu của mã trước.
      setToken(tokenFromFragment());
      setState({ kind: "ask" });
      setError(undefined);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token) return;
    const digits = String(new FormData(e.currentTarget).get("last4") ?? "").trim();
    if (!/^\d{4}$/.test(digits)) return setError("Nhập đúng 4 chữ số cuối số điện thoại đặt phòng");
    setError(undefined);
    setState({ kind: "loading" });
    try {
      const res = await timedFetch(`/api/v1/portal/guest/stays/${encodeURIComponent(stayId)}`, {
        headers: { "x-guest-token": token, "x-guest-verify": digits },
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      const j = (await res.json().catch(() => null)) as
        | ({ data?: GuestView } & { code?: string; title?: string })
        | null;
      if (res.ok && j?.data) return setState({ kind: "ok", view: j.data });
      if (j?.code === "LINK_EXPIRED")
        return setState({ kind: "dead", title: "Liên kết đã hết hạn", text: j.title ?? EXPIRED });
      if (j?.code === "LINK_REVOKED")
        return setState({ kind: "dead", title: "Liên kết không còn hiệu lực", text: j.title ?? REVOKED });
      setState({ kind: "ask" });
      setError(
        res.status === 429
          ? (j?.title ?? "Bạn thử quá nhiều lần. Vui lòng đợi ít phút.")
          : (j?.title ?? "Không mở được liên kết. Vui lòng thử lại."),
      );
    } catch {
      setState({ kind: "ask" });
      setError("Chưa nhận được phản hồi. Kiểm tra mạng rồi thử lại.");
    }
  }

  if (token === undefined) return <LoadingState label="Đang kiểm tra liên kết" />;
  if (token === null)
    return (
      <ErrorState
        title="Liên kết không đầy đủ"
        text="Hãy mở đúng liên kết lễ tân đã gửi, hoặc liên hệ lễ tân để nhận liên kết mới."
      />
    );
  if (state.kind === "dead") return <ErrorState title={state.title} text={state.text} />;
  if (state.kind === "loading")
    return (
      <div className="state" role="status">
        <span className="spinner" aria-hidden="true" /> Đang kiểm tra liên kết
      </div>
    );
  if (state.kind === "ok") {
    const { stay, folio } = state.view;
    return (
      <>
        <section aria-labelledby="ls" className="panel">
          <h2 id="ls">Lượt ở</h2>
          <dl className="facts">
            <dt>Phòng</dt>
            <dd data-testid="guest-unit">{stay.unitCode}</dd>
            <dt>Ngày đến</dt>
            <dd>{day(stay.arrivalDate)}</dd>
            <dt>Ngày đi</dt>
            <dd>{day(stay.departureDate)}</dd>
            <dt>Trạng thái</dt>
            <dd>{STAY_STATUS[stay.status] ?? stay.status}</dd>
          </dl>
        </section>
        <section aria-labelledby="fo" className="panel">
          <h2 id="fo">Khoản phí</h2>
          {folio.charges.length > 0 ? (
            <table className="lines">
              <thead>
                <tr>
                  <th scope="col">Khoản</th>
                  <th scope="col">Thành tiền</th>
                </tr>
              </thead>
              <tbody>
                {folio.charges.map((c) => (
                  <tr key={`${c.businessDate}-${c.description}-${c.amount}`}>
                    <th scope="row">
                      {c.description} ({day(c.businessDate)})
                    </th>
                    <td>{vnd(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <dl className="facts">
            <dt>Tổng</dt>
            <dd data-testid="guest-total">{vnd(folio.total)}</dd>
            <dt>Đã thanh toán</dt>
            <dd data-testid="guest-paid">{vnd(folio.paid)}</dd>
            <dt>Còn lại</dt>
            <dd data-testid="guest-balance">{vnd(folio.balance)}</dd>
          </dl>
        </section>
      </>
    );
  }
  return (
    <form onSubmit={onSubmit} noValidate>
      <TextField
        label="4 số cuối số điện thoại đặt phòng"
        hint="Để bảo vệ thông tin của bạn, lễ tân yêu cầu xác minh trước khi hiển thị."
        name="last4"
        inputMode="numeric"
        autoComplete="off"
        maxLength={4}
        required
        error={error}
      />
      <Button type="submit">Xem lượt ở</Button>
    </form>
  );
}
