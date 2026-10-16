import type { OpsProperty } from "@hm/app";
import { CommandForm } from "../command/command-form.tsx";

/** Nhận tiền mặt chỉ trong ca đang mở của chính mình (INV-F3b): chưa mở ca thì hiện form "Mở ca"; đã mở thì một dòng xác nhận. */
export function ShiftPanel({ property }: { property: OpsProperty }) {
  if (property.openShift)
    return (
      <p className="notice-ok" data-testid="shift-open">
        <span aria-hidden="true">✓ </span>Bạn đang mở ca tiền mặt tại {property.name}.
      </p>
    );
  return (
    <section aria-labelledby={`ca-${property.id}`} className="panel">
      <h2 id={`ca-${property.id}`}>Mở ca tiền mặt — {property.name}</h2>
      <CommandForm
        path="shift/open"
        fixed={{ property_id: property.id }}
        fields={[
          {
            name: "opening_cash",
            label: "Tiền đầu ca (đồng)",
            type: "money",
            required: true,
            defaultValue: 0,
          },
        ]}
        submitLabel="Mở ca"
        successText="Đã mở ca."
      />
    </section>
  );
}
