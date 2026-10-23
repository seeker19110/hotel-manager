"use client";
// Đặt phòng 3 bước ngắn (SPEC-reservation-stay §5): báo giá (tổng giá + chính sách luôn hiện) → tạo booking + giữ phòng →
// (trang chi tiết) xác nhận. Chỉ báo thành công sau phản hồi máy chủ; tạo và giữ là hai command, mỗi lệnh một Idempotency-Key.
// Giữ phòng thất bại (vd. phòng bận) thì booking nháp đã tạo được dùng lại — không tạo thêm bản nháp thứ hai.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { timedFetch } from "../../lib/fetch-timeout.ts";
import { vnd } from "../../lib/format.ts";
import type { Messages } from "../../lib/i18n.ts";
import { tm } from "../../lib/i18n-format.ts";
import { firstNonEmpty } from "../../lib/text.ts";
import { CommandStatus } from "../command/command-status.tsx";
import { orgContextHeaders } from "../command/org-context.ts";
import { problemText, useCommand } from "../command/use-command.ts";
import { Button } from "../ui/button.tsx";
import { SelectField, TextField } from "../ui/field.tsx";

export interface BookableRoom {
  unitId: string;
  label: string;
}

interface QuoteData {
  nights: number;
  nightlyPrices: { businessDate: string; amount: number }[];
  roomTotal: number;
  policy: Record<string, unknown>;
}

interface Booker {
  full_name: string;
  phone: string;
  email?: string;
}

export function BookingForm({
  rooms,
  defaults,
  m,
}: {
  rooms: BookableRoom[];
  defaults: { unitId: string; arrival: string; departure: string };
  m: Messages<"booking.quote." | "booking.form.">;
}) {
  const router = useRouter();
  const create = useCommand<{ reservationId: string }>("reservation/create");
  const hold = useCommand<{ expiresAt: string }>("reservation/hold");
  const [unitId, setUnitId] = useState(defaults.unitId);
  const [arrival, setArrival] = useState(defaults.arrival);
  const [departure, setDeparture] = useState(defaults.departure);
  const [guests, setGuests] = useState("2");
  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [draftId, setDraftId] = useState<string | null>(null);

  const invalidate = () => {
    setQuote(null);
    setQuoteError(null);
  };

  async function getQuote() {
    setQuoteError(null);
    setQuote(null);
    if (!/^\d+$/.test(guests) || Number(guests) < 1) return setQuoteError(tm(m, "booking.form.error.guests"));
    if (!arrival || !departure) return setQuoteError(tm(m, "booking.form.error.dates"));
    setQuoting(true);
    try {
      const qs = new URLSearchParams({
        unit_id: unitId,
        arrival_date: arrival,
        departure_date: departure,
        guests,
      });
      const res = await timedFetch(`/api/v1/reservation/quote?${qs}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers: orgContextHeaders(),
      });
      if (res.status === 401) {
        window.location.assign("/dang-nhap");
        return;
      }
      const j = (await res.json().catch(() => null)) as {
        data?: QuoteData;
        detail?: string;
        title?: string;
      } | null;
      if (!res.ok || !j?.data)
        setQuoteError(firstNonEmpty(j?.detail, j?.title) ?? tm(m, "booking.form.error.quote_failed"));
      else setQuote(j.data);
    } catch {
      setQuoteError(tm(m, "booking.form.error.offline"));
    } finally {
      setQuoting(false);
    }
  }

  async function holdStep(id: string) {
    const h = await hold.send({ reservation_id: id });
    if (h !== null) router.push(`/dat-phong/${id}`);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const full_name = String(f.get("full_name") ?? "").trim();
    const phone = String(f.get("phone") ?? "").trim();
    const email = String(f.get("email") ?? "").trim();
    const errs: Record<string, string> = {};
    if (!full_name) errs.full_name = tm(m, "booking.form.error.required");
    if (!/^\+?[0-9 .()-]{6,20}$/.test(phone)) errs.phone = tm(m, "booking.form.error.phone");
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    let id = draftId;
    if (!id) {
      const booker: Booker = { full_name, phone, ...(email ? { email } : {}) };
      const c = await create.send({
        unit_id: unitId,
        arrival_date: arrival,
        departure_date: departure,
        guests: Number(guests),
        source: "direct",
        booker,
      });
      if (c === null) return;
      id = c.reservationId;
      setDraftId(id);
    }
    await holdStep(id);
  }

  async function createRecovered(c: { reservationId: string } | null) {
    if (c === null) return;
    setDraftId(c.reservationId);
    await holdStep(c.reservationId);
  }

  const locked = create.locked || hold.locked;
  const general = (c: { phase: string; problem: Parameters<typeof problemText>[0] }) =>
    c.phase === "error" ? problemText(c.problem) : null;

  return (
    <div className="panel">
      <section aria-labelledby="b1">
        <h2 id="b1">{tm(m, "booking.form.step1.heading")}</h2>
        <form
          noValidate
          className="command-form"
          onSubmit={(e) => {
            e.preventDefault();
            void getQuote();
          }}
        >
          <fieldset className="command-form__fields" disabled={locked || draftId !== null}>
            <SelectField
              name="unit_id"
              label={tm(m, "booking.form.field.unit")}
              options={rooms.map((r) => ({ value: r.unitId, label: r.label }))}
              value={unitId}
              onChange={(e) => {
                setUnitId(e.target.value);
                invalidate();
              }}
            />
            <TextField
              name="arrival_date"
              label={tm(m, "booking.form.field.arrival")}
              type="date"
              value={arrival}
              onChange={(e) => {
                setArrival(e.target.value);
                invalidate();
              }}
            />
            <TextField
              name="departure_date"
              label={tm(m, "booking.form.field.departure")}
              type="date"
              value={departure}
              onChange={(e) => {
                setDeparture(e.target.value);
                invalidate();
              }}
            />
            <TextField
              name="guests"
              label={tm(m, "booking.form.field.guests")}
              inputMode="numeric"
              value={guests}
              onChange={(e) => {
                setGuests(e.target.value);
                invalidate();
              }}
            />
          </fieldset>
          <Button type="submit" variant="secondary" loading={quoting} disabled={locked || draftId !== null}>
            {tm(m, "booking.form.quote.submit")}
          </Button>
          {quoteError ? (
            <p className="field__error" role="alert">
              {quoteError}
            </p>
          ) : null}
        </form>
        {quote ? (
          <div data-testid="quote" role="status">
            <table className="lines">
              <caption>
                {tm(m, "booking.quote.total", { nights: quote.nights })}{" "}
                <strong data-testid="quote-total">{vnd(quote.roomTotal)}</strong>
              </caption>
              <thead>
                <tr>
                  <th scope="col">{tm(m, "booking.form.quote.col_night")}</th>
                  <th scope="col">{tm(m, "booking.form.quote.col_price")}</th>
                </tr>
              </thead>
              <tbody>
                {quote.nightlyPrices.map((n) => (
                  <tr key={n.businessDate}>
                    <th scope="row">{n.businessDate.split("-").reverse().join("/")}</th>
                    <td>{vnd(n.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="card__meta">{tm(m, "booking.form.quote.policy")}</p>
          </div>
        ) : null}
      </section>

      {quote ? (
        <section aria-labelledby="b2">
          <h2 id="b2">{tm(m, "booking.form.step2.heading")}</h2>
          <form onSubmit={onSubmit} noValidate className="command-form" data-testid="booking-form">
            <fieldset className="command-form__fields" disabled={locked || draftId !== null}>
              <TextField
                name="full_name"
                label={tm(m, "booking.form.booker.name")}
                required
                error={errors.full_name}
                maxLength={200}
              />
              <TextField
                name="phone"
                label={tm(m, "booking.form.booker.phone")}
                type="tel"
                inputMode="tel"
                required
                error={errors.phone}
                maxLength={20}
              />
              <TextField
                name="email"
                label={tm(m, "booking.form.booker.email")}
                type="email"
                maxLength={320}
              />
            </fieldset>
            {draftId === null ? (
              <Button type="submit" loading={create.busy || hold.busy} disabled={locked}>
                {tm(m, "booking.form.submit.create")}
              </Button>
            ) : (
              <Button type="submit" loading={hold.busy} disabled={hold.locked}>
                {tm(m, "booking.form.submit.rehold")}
              </Button>
            )}
            <CommandStatus
              phase={create.phase}
              commandId={create.commandId}
              problem={create.problem}
              general={general(create)}
              successText={tm(m, "booking.form.create.success")}
              onResend={() => void create.resend().then(createRecovered)}
              onRecheck={() => void create.recheck().then(createRecovered)}
            />
            <CommandStatus
              phase={hold.phase}
              commandId={hold.commandId}
              problem={hold.problem}
              general={general(hold)}
              successText={tm(m, "booking.form.hold.success")}
              onResend={() =>
                void hold.resend().then((h) => h && draftId && router.push(`/dat-phong/${draftId}`))
              }
              onRecheck={() =>
                void hold.recheck().then((h) => h && draftId && router.push(`/dat-phong/${draftId}`))
              }
            />
            {draftId && hold.phase === "error" ? (
              <p>
                {tm(m, "booking.form.draft.note")}{" "}
                <a className="btn btn--secondary" href={`/dat-phong/${draftId}`}>
                  {tm(m, "booking.form.draft.open")}
                </a>
              </p>
            ) : null}
          </form>
        </section>
      ) : null}
    </div>
  );
}
