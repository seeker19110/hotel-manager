// Nhãn trạng thái: luôn có CHỮ + biểu tượng (không chỉ màu — SPEC-pwa §5, SPEC-inventory-allocation §5).
const ICON: Record<string, string> = {
  draft: "○",
  open: "○",
  pending: "○",
  expected: "○",
  dirty: "●",
  held: "◔",
  assigned: "◔",
  exported: "◑",
  in_progress: "◑",
  cleaning: "◑",
  in_house: "●",
  done: "◕",
  clean: "◕",
  confirmed: "✓",
  verified: "✓",
  inspected: "✓",
  submitted: "✓",
  checked_out: "✓",
  cancelled: "✕",
  no_show: "✕",
  expired: "✕",
  rejected: "✕",
  reversed: "✕",
};

export function StatusBadge({ status, label, testId }: { status: string; label: string; testId?: string }) {
  return (
    <span className="badge" data-status={status} data-testid={testId}>
      <span aria-hidden="true">{ICON[status] ?? "•"} </span>
      {label}
    </span>
  );
}
