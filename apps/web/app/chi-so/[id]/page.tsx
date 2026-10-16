import { readingRoute, serverContext } from "@hm/app";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CommandForm } from "../../../components/command/command-form.tsx";
import { EmptyState, ErrorState } from "../../../components/ui/state.tsx";
import { METER_LABEL } from "../../../lib/format.ts";
import { withActor } from "../../../lib/page.tsx";

export const metadata: Metadata = { title: "Chốt chỉ số — Hotel Manager" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ReadingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return withActor("Chốt chỉ số theo tầng", "/ky-thu", async (actor) => {
    let route: Awaited<ReturnType<typeof readingRoute>>;
    try {
      route = await readingRoute(serverContext().db, actor, { billingPeriodId: id });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "NOT_FOUND") notFound();
      if (code === "FORBIDDEN")
        return <ErrorState title="Không có quyền" text="Vai trò của bạn không nhập chỉ số." />;
      throw e;
    }
    if (route.length === 0)
      return <EmptyState title="Chưa có công tơ nào" text="Lắp công tơ cho phòng trước khi chốt chỉ số." />;
    const floors = [...new Set(route.map((r) => r.floor))];
    return (
      <>
        <p>
          <a className="btn btn--secondary" href={`/ky-thu/${id}`}>
            Quay lại kỳ thu
          </a>
        </p>
        {floors.map((f, fi) => (
          <section key={f} aria-labelledby={`t-${fi}`} className="panel">
            <h2 id={`t-${fi}`}>{f}</h2>
            {route
              .filter((r) => r.floor === f)
              .map((r) => (
                <div key={r.unit_id} className="reading-room" data-testid="reading-room">
                  <h3>Phòng {r.unit}</h3>
                  {r.meters.map((m) => (
                    <CommandForm
                      key={m.meter_id}
                      path="meter/recordReading"
                      fixed={{ meter_id: m.meter_id, billing_period_id: id }}
                      fields={[
                        {
                          name: "value",
                          label: `${METER_LABEL[m.kind] ?? m.kind} phòng ${r.unit}`,
                          type: "decimal",
                          required: true,
                          hint: `Lần trước: ${m.previous_value}${m.entered ? ` · đã nhập ${m.value}` : ""}`,
                          ...(m.value === null ? {} : { defaultValue: m.value }),
                        },
                      ]}
                      submitLabel={`Lưu ${METER_LABEL[m.kind]?.toLowerCase() ?? m.kind}`}
                      successText="Đã lưu chỉ số."
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
