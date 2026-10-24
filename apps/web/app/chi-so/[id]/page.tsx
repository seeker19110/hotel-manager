import { readingRoute, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm } from "../../../components/command/command-form.tsx";
import { EmptyState, ErrorState } from "../../../components/ui/state.tsx";
import { meterLabel } from "../../../lib/format.ts";
import { messagesFor, t } from "../../../lib/i18n.ts";
import { withActor } from "../../../lib/page.tsx";

/** Nhãn mã (lib/format.ts, D-103). */
const LABELS = messagesFor("label.meter.");

export const metadata: Metadata = { title: t("billing.readings.metadata.title") };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ReadingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return withActor(t("billing.readings.page.title"), "/ky-thu", async (actor) => {
    let route: Awaited<ReturnType<typeof readingRoute>>;
    try {
      route = await readingRoute(serverContext().db, actor, { billingPeriodId: id });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "NOT_FOUND") notFound();
      if (code === "FORBIDDEN")
        return (
          <ErrorState
            title={t("billing.readings.forbidden.title")}
            text={t("billing.readings.forbidden.text")}
          />
        );
      throw e;
    }
    if (route.length === 0)
      return <EmptyState title={t("billing.readings.empty.title")} text={t("billing.readings.empty.text")} />;
    const floors = [...new Set(route.map((r) => r.floor))];
    return (
      <>
        <p>
          <a className="btn btn--secondary" href={`/ky-thu/${id}`}>
            {t("billing.readings.back")}
          </a>
        </p>
        {floors.map((f, fi) => (
          <section key={f} aria-labelledby={`t-${fi}`} className="panel">
            <h2 id={`t-${fi}`}>{f}</h2>
            {route
              .filter((r) => r.floor === f)
              .map((r) => (
                <div key={r.unit_id} className="reading-room" data-testid="reading-room">
                  <h3>{t("billing.readings.room", { unit: r.unit })}</h3>
                  {r.meters.map((m) => (
                    <CommandForm
                      key={m.meter_id}
                      path="meter/recordReading"
                      fixed={{ meter_id: m.meter_id, billing_period_id: id }}
                      fields={[
                        {
                          name: "value",
                          label: t("billing.readings.field.label", {
                            meter: meterLabel(LABELS, m.kind) ?? m.kind,
                            unit: r.unit,
                          }),
                          type: "decimal",
                          required: true,
                          hint: m.entered
                            ? t("billing.readings.field.hint_entered", {
                                previous: m.previous_value,
                                value: String(m.value),
                              })
                            : t("billing.readings.field.hint", { previous: m.previous_value }),
                          ...(m.value === null ? {} : { defaultValue: m.value }),
                        },
                      ]}
                      submitLabel={t("billing.readings.field.submit_label", {
                        meter: meterLabel(LABELS, m.kind)?.toLowerCase() ?? m.kind,
                      })}
                      successText={t("billing.readings.field.success")}
                      variant="secondary"
                    />
                  ))}
                </div>
              ))}
          </section>
        ))}
      </>
    );
  });
}
