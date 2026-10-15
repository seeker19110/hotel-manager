// Danh mục command công khai qua `POST /api/v1/<module>/<command>` (API-CONTRACT §1). Thêm command = thêm một mục ở đây
// (schema Zod là hợp đồng đầu vào). Tên mục = tên command trong SPEC §5.
import { z } from "zod";
import { APPROVAL_KINDS, cancelApproval, decideApproval, requestApproval } from "../approvals/approvals.ts";
import type { CommandDef } from "./command-route.ts";

const uuid = z.uuid();
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Kiểu rộng cho danh mục (mỗi mục giữ schema riêng). */
// biome-ignore lint/suspicious/noExplicitAny: danh mục không đồng nhất; mỗi mục tự gõ kiểu qua defineCommand
type AnyCommand = CommandDef<any, any>;

function defineCommand<I, O>(def: CommandDef<I, O>): CommandDef<I, O> {
  return def;
}

export const COMMANDS: Readonly<Record<string, AnyCommand>> = {
  "approval.request": defineCommand({
    command: "approval.request",
    // Không nhận `payload` từ client: ngữ cảnh duyệt do server suy ra (executor), không tin client.
    input: z.strictObject({
      kind: z.enum(APPROVAL_KINDS),
      amount: money.nullable(),
      reason: z.string().trim().min(1).max(1000),
      property_id: uuid.nullable(),
      subject_type: z.string().min(1).max(64).optional(),
      subject_id: uuid.optional(),
    }),
    run: async (ctx, i) => ({
      data: await requestApproval(ctx, {
        kind: i.kind,
        amount: i.amount,
        reason: i.reason,
        propertyId: i.property_id,
        ...(i.subject_type ? { subjectType: i.subject_type } : {}),
        ...(i.subject_id ? { subjectId: i.subject_id } : {}),
      }),
      httpStatus: 201,
    }),
  }),
  "approval.approve": defineCommand({
    command: "approval.approve",
    input: z.strictObject({ approval_request_id: uuid, note: z.string().max(1000).optional() }),
    run: async (ctx, i) => ({
      data: await decideApproval(ctx, {
        approvalRequestId: i.approval_request_id,
        decision: "approve",
        ...(i.note ? { note: i.note } : {}),
      }),
    }),
  }),
  "approval.reject": defineCommand({
    command: "approval.reject",
    input: z.strictObject({ approval_request_id: uuid, note: z.string().trim().min(1).max(1000) }),
    run: async (ctx, i) => ({
      data: await decideApproval(ctx, {
        approvalRequestId: i.approval_request_id,
        decision: "reject",
        note: i.note,
      }),
    }),
  }),
  "approval.cancel": defineCommand({
    command: "approval.cancel",
    input: z.strictObject({ approval_request_id: uuid }),
    run: async (ctx, i) => ({ data: await cancelApproval(ctx, i.approval_request_id) }),
  }),
};

/** Tìm command theo đường dẫn `<module>/<command>`; tên chỉ gồm chữ/số để không lọt ký tự lạ. */
export function findCommand(module: string, command: string): AnyCommand | undefined {
  if (!/^[a-z][a-z_]*$/.test(module) || !/^[a-zA-Z][a-zA-Z]*$/.test(command)) return undefined;
  return Object.hasOwn(COMMANDS, `${module}.${command}`) ? COMMANDS[`${module}.${command}`] : undefined;
}
