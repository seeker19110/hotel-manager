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
import type { Messages } from "../../../../lib/i18n.ts";
import { tm } from "../../../../lib/i18n-format.ts";

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

/** Nhãn trạng thái lượt ở (dựng từ `m` — client không import catalog, D-098); mã lạ: nơi gọi hiện mã thô. */
function stayStatusLabels(m: Messages<"guest_stay.">): Record<string, string> {
  return {
    expected: tm(m, "guest_stay.status.expected"),
    in_house: tm(m, "guest_stay.status.in_house"),
    checked_out: tm(m, "guest_stay.status.checked_out"),
    cancelled: tm(m, "guest_stay.status.cancelled"),
    no_show: tm(m, "guest_stay.status.no_show"),
  };
}

type State =
  | { kind: "ask" }
  | { kind: "loading" }
  | { kind: "ok"; view: GuestView }
  | { kind: "dead"; title: string; text: string };

function tokenFromFragment(): string | null {
  const m = /(?:^#|&)t=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  return m?.[1] ?? null;
}

export function GuestStay({ stayId, m }: { stayId: string; m: Messages<"guest_stay."> }) {
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
    if (!/^\d{4}$/.test(digits)) return setError(tm(m, "guest_stay.error.last4"));
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
        return setState({
          kind: "dead",
          title: tm(m, "guest_stay.error.expired_title"),
          text: j.title ?? tm(m, "guest_stay.error.expired_text"),
        });
      if (j?.code === "LINK_REVOKED")
        return setState({
          kind: "dead",
          title: tm(m, "guest_stay.error.revoked_title"),
          text: j.title ?? tm(m, "guest_stay.error.revoked_text"),
        });
      setState({ kind: "ask" });
      setError(
        res.status === 429
          ? (j?.title ?? tm(m, "guest_stay.error.too_many"))
          : (j?.title ?? tm(m, "guest_stay.error.open_failed")),
      );
    } catch {
      setState({ kind: "ask" });
      setError(tm(m, "guest_stay.error.no_response"));
    }
  }

  if (token === undefined) return <LoadingState label={tm(m, "guest_stay.loading")} />;
  if (token === null)
    return (
      <ErrorState title={tm(m, "guest_stay.incomplete.title")} text={tm(m, "guest_stay.incomplete.text")} />
    );
  if (state.kind === "dead") return <ErrorState title={state.title} text={state.text} />;
  if (state.kind === "loading")
    return (
      <div className="state" role="status">
        <span className="spinner" aria-hidden="true" /> {tm(m, "guest_stay.loading")}
      </div>
    );
  if (state.kind === "ok") {
    const { stay, folio } = state.view;
    return (
      <>
        <section aria-labelledby="ls" className="panel">
          <h2 id="ls">{tm(m, "guest_stay.stay.heading")}</h2>
          <dl className="facts">
            <dt>{tm(m, "guest_stay.stay.unit")}</dt>
            <dd data-testid="guest-unit">{stay.unitCode}</dd>
            <dt>{tm(m, "guest_stay.stay.arrival")}</dt>
            <dd>{day(stay.arrivalDate)}</dd>
            <dt>{tm(m, "guest_stay.stay.departure")}</dt>
            <dd>{day(stay.departureDate)}</dd>
            <dt>{tm(m, "guest_stay.stay.status")}</dt>
            <dd>{stayStatusLabels(m)[stay.status] ?? stay.status}</dd>
          </dl>
        </section>
        <section aria-labelledby="fo" className="panel">
          <h2 id="fo">{tm(m, "guest_stay.folio.heading")}</h2>
          {folio.charges.length > 0 ? (
            <table className="lines">
              <thead>
                <tr>
                  <th scope="col">{tm(m, "guest_stay.folio.col_kind")}</th>
                  <th scope="col">{tm(m, "guest_stay.folio.col_amount")}</th>
                </tr>
              </thead>
              <tbody>
                {folio.charges.map((c) => (
                  <tr key={`${c.businessDate}-${c.description}-${c.amount}`}>
                    <th scope="row">
                      {tm(m, "guest_stay.folio.line", {
                        description: c.description,
                        date: day(c.businessDate),
                      })}
                    </th>
                    <td>{vnd(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <dl className="facts">
            <dt>{tm(m, "guest_stay.folio.total")}</dt>
            <dd data-testid="guest-total">{vnd(folio.total)}</dd>
            <dt>{tm(m, "guest_stay.folio.paid")}</dt>
            <dd data-testid="guest-paid">{vnd(folio.paid)}</dd>
            <dt>{tm(m, "guest_stay.folio.balance")}</dt>
            <dd data-testid="guest-balance">{vnd(folio.balance)}</dd>
          </dl>
        </section>
      </>
    );
  }
  return (
    <form onSubmit={onSubmit} noValidate>
      <TextField
        label={tm(m, "guest_stay.form.last4")}
        hint={tm(m, "guest_stay.form.hint")}
        name="last4"
        inputMode="numeric"
        autoComplete="off"
        maxLength={4}
        required
        error={error}
      />
      <Button type="submit">{tm(m, "guest_stay.form.submit")}</Button>
    </form>
  );
}
