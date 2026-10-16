// Máy trạng thái khai báo (DOMAIN-MODEL §4, IND-FIN-005): chuyển ngoài bảng → INVALID_TRANSITION.

export class TransitionError extends Error {
  readonly code = "INVALID_TRANSITION" as const;
  readonly status = 409 as const;
  readonly from: string;
  readonly to: string;
  constructor(machine: string, from: string, to: string) {
    super(`${machine}: không thể chuyển từ "${from}" sang "${to}"`);
    this.name = "TransitionError";
    this.from = from;
    this.to = to;
  }
}

export interface Machine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  canTransition(from: S, to: S): boolean;
  assertTransition(from: S, to: S): void;
  next(from: S): readonly S[];
}

export function defineMachine<S extends string>(
  name: string,
  states: readonly S[],
  transitions: Readonly<Record<S, readonly S[]>>,
): Machine<S> {
  for (const [from, tos] of Object.entries(transitions) as [S, readonly S[]][]) {
    if (!states.includes(from)) throw new Error(`${name}: trạng thái lạ "${from}"`);
    for (const to of tos) if (!states.includes(to)) throw new Error(`${name}: trạng thái lạ "${to}"`);
  }
  return {
    name,
    states,
    canTransition: (from, to) => (transitions[from] ?? []).includes(to),
    assertTransition(from, to) {
      if (!(transitions[from] ?? []).includes(to)) throw new TransitionError(name, from, to);
    },
    next: (from) => transitions[from] ?? [],
  };
}

/** Vòng đời theo DOMAIN-MODEL §4 (v1.3). */
export const bookingMachine = defineMachine(
  "booking",
  ["draft", "held", "confirmed", "in_house", "checked_out", "cancelled", "no_show", "expired"] as const,
  {
    draft: ["held", "cancelled"],
    held: ["confirmed", "expired", "cancelled"],
    confirmed: ["in_house", "cancelled", "no_show"],
    in_house: ["checked_out"],
    checked_out: [],
    cancelled: [],
    no_show: [],
    expired: [],
  },
);

export const stayMachine = defineMachine(
  "stay",
  ["expected", "in_house", "checked_out", "cancelled", "no_show"] as const,
  {
    expected: ["in_house", "cancelled", "no_show"],
    in_house: ["checked_out"],
    checked_out: [],
    cancelled: [],
    no_show: [],
  },
);

export const leaseMachine = defineMachine(
  "lease",
  [
    "draft",
    "pending_signature",
    "signed_awaiting_handover",
    "active",
    "notice_given",
    "settling",
    "closed",
    "cancelled",
  ] as const,
  {
    draft: ["pending_signature", "cancelled"],
    pending_signature: ["signed_awaiting_handover", "cancelled"],
    signed_awaiting_handover: ["active", "cancelled"],
    active: ["notice_given", "settling"],
    notice_given: ["settling"],
    settling: ["closed"],
    closed: [],
    cancelled: [],
  },
);

export const billingPeriodMachine = defineMachine(
  "billing_period",
  ["draft", "reviewing", "issued", "locked"] as const,
  { draft: ["reviewing"], reviewing: ["draft", "issued"], issued: ["locked"], locked: ["issued"] },
);

export const paymentMachine = defineMachine("payment", ["pending", "confirmed", "reversed"] as const, {
  pending: ["confirmed"],
  confirmed: ["reversed"],
  reversed: [],
});

export const taskMachine = defineMachine(
  "task",
  ["open", "assigned", "in_progress", "done", "verified", "cancelled"] as const,
  {
    open: ["assigned", "cancelled"],
    assigned: ["in_progress", "cancelled"],
    in_progress: ["done", "cancelled"],
    // `done → assigned`: nghiệm thu không đạt quay về cùng người (SPEC-housekeeping Q-05).
    done: ["verified", "assigned"],
    verified: [],
    cancelled: [],
  },
);

export const MACHINES = [
  bookingMachine,
  stayMachine,
  leaseMachine,
  billingPeriodMachine,
  paymentMachine,
  taskMachine,
] as const;
