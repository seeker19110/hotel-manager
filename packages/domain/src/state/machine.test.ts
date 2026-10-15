// IND-FIN-005: property test — MỌI cặp (from, to) ngoài bảng bị từ chối với INVALID_TRANSITION.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bookingMachine, MACHINES, paymentMachine, TransitionError } from "./machine.ts";

describe.each(MACHINES.map((m) => [m.name, m] as const))("máy trạng thái %s", (_name, m) => {
  const states = m.states as readonly string[];
  it("mọi cặp: canTransition ⇔ assertTransition không ném; ngoài bảng ném INVALID_TRANSITION", () => {
    fc.assert(
      fc.property(fc.constantFrom(...states), fc.constantFrom(...states), (from, to) => {
        const allowed = m.canTransition(from as never, to as never);
        if (allowed) {
          expect(() => m.assertTransition(from as never, to as never)).not.toThrow();
        } else {
          expect(() => m.assertTransition(from as never, to as never)).toThrowError(
            expect.objectContaining({ code: "INVALID_TRANSITION", status: 409 }),
          );
        }
      }),
      { numRuns: states.length * states.length * 4 },
    );
  });

  it("không có chuyển sang chính nó", () => {
    for (const s of states) expect(m.canTransition(s as never, s as never)).toBe(false);
  });
});

describe("ca cụ thể (DOMAIN-MODEL §4)", () => {
  it("booking không nhảy draft → in_house; không huỷ sau checked_out", () => {
    expect(() => bookingMachine.assertTransition("draft", "in_house")).toThrow(TransitionError);
    expect(() => bookingMachine.assertTransition("checked_out", "cancelled")).toThrow(TransitionError);
  });
  it("payment: pending → reversed bị từ chối (phải xác nhận rồi mới đảo)", () => {
    expect(paymentMachine.canTransition("pending", "reversed")).toBe(false);
    expect(paymentMachine.canTransition("confirmed", "reversed")).toBe(true);
  });
});
