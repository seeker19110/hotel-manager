// Giấy tờ nhận dạng (ERD `identity_documents`, D-004; SPEC-reservation-stay Q-08; SPEC-housekeeping S-020). Số giấy tờ
// chỉ đi vào CSDL dưới dạng ciphertext AES-256-GCM (AAD = tổ chức + id hàng) + blind index + 4 ký tự cuối. Đọc qua API
// chỉ trả bản che; số rõ chỉ giải mã trong tiến trình cho nghĩa vụ pháp lý (xuất thông báo lưu trú — T-210).
import { randomUUID } from "node:crypto";
import { withTenant } from "@hm/db";
import { AuthzError, authorize } from "@hm/domain";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Actor } from "../access/index.ts";
import { last4, maskDocNumber, normalizeDocNumber, type PiiCipher } from "../crypto/index.ts";
import { type CommandContext, CommandError } from "../pipeline/index.ts";

export const DOC_TYPES = ["cccd", "passport", "other"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface RecordIdentityInput {
  personId: string;
  propertyId: string | null;
  docType: DocType;
  docNumber: string;
  /** ISO 3166-1 alpha-2 (khách nước ngoài: bắt buộc với hộ chiếu ở check-in — kiểm ở module lưu trú). */
  nationality?: string | null;
}

export interface IdentityDocumentView {
  id: string;
  personId: string;
  propertyId: string | null;
  docType: DocType;
  docNumberMasked: string | null;
  nationality: string | null;
  anonymized: boolean;
}

function aad(orgId: string, id: string): string {
  return `identity_documents:${orgId}:${id}`;
}

/** Quyền đọc giấy tờ; vai trò không được đọc → 404 (không lộ việc tồn tại — SPEC-housekeeping S-020). */
function authorizeRead(actor: Actor, propertyId: string | null): void {
  try {
    authorize(actor, "identity.read", propertyId ? { propertyId } : {});
  } catch (e) {
    if (e instanceof AuthzError) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
    throw e;
  }
}

/**
 * Ghi giấy tờ cho một người trong transaction của command. Cùng người + cùng loại + cùng số (blind index) → dùng lại hàng
 * cũ (check-in lại không nhân bản dữ liệu nhạy cảm). Số không hợp lệ → 422 có `errors[]`.
 */
export async function recordIdentityDocument(
  ctx: CommandContext,
  pii: PiiCipher,
  input: RecordIdentityInput,
  path = "doc_number",
): Promise<{ identityDocumentId: string; docNumberMasked: string; reused: boolean }> {
  authorizeRead(ctx.actor, input.propertyId);
  const normalized = normalizeDocNumber(input.docNumber);
  if (!normalized) {
    throw new CommandError("VALIDATION_FAILED", 422, "Số giấy tờ không hợp lệ", {
      extensions: { errors: [{ path, field: path, code: "invalid_doc_number" }] },
    });
  }
  const nationality = input.nationality ? input.nationality.toUpperCase() : null;
  if (nationality !== null && !/^[A-Z]{2}$/.test(nationality)) {
    throw new CommandError("VALIDATION_FAILED", 422, "Quốc tịch phải là mã ISO 2 chữ cái", {
      extensions: { errors: [{ path: "nationality", field: "nationality", code: "invalid_country" }] },
    });
  }
  const hash = pii.blindIndex(ctx.actor.orgId, input.docType, normalized);
  const existing = await sql<{ id: string }>`
    select id from identity_documents
    where organization_id = ${ctx.actor.orgId} and person_id = ${input.personId} and doc_type = ${input.docType}
      and doc_number_hash = ${hash} and anonymized_at is null
    order by created_at limit 1`.execute(ctx.trx);
  const masked = maskDocNumber(last4(normalized)) as string;
  if (existing.rows[0]) {
    return { identityDocumentId: existing.rows[0].id, docNumberMasked: masked, reused: true };
  }
  const id = randomUUID();
  const enc = pii.encrypt(normalized, aad(ctx.actor.orgId, id));
  await sql`
    insert into identity_documents (id, organization_id, property_id, person_id, doc_type, doc_number_enc, doc_number_key_id,
                                    doc_number_hash, doc_number_last4, nationality)
    values (${id}, ${ctx.actor.orgId}, ${input.propertyId}, ${input.personId}, ${input.docType}, ${enc},
            ${pii.keyIdOf(enc)}, ${hash}, ${last4(normalized)}, ${nationality})`.execute(ctx.trx);
  await ctx.audit({
    action: "identity_document.recorded",
    entityType: "identity_document",
    entityId: id,
    ...(input.propertyId ? { propertyId: input.propertyId } : {}),
    after: { doc_type: input.docType, doc_number_masked: masked, nationality },
  });
  return { identityDocumentId: id, docNumberMasked: masked, reused: false };
}

interface Row {
  id: string;
  person_id: string;
  property_id: string | null;
  doc_type: DocType;
  doc_number_last4: string | null;
  nationality: string | null;
  anonymized_at: Date | null;
}

const view = (r: Row): IdentityDocumentView => ({
  id: r.id,
  personId: r.person_id,
  propertyId: r.property_id,
  docType: r.doc_type,
  docNumberMasked: maskDocNumber(r.doc_number_last4),
  nationality: r.nationality,
  anonymized: r.anonymized_at !== null,
});

/** `identity.get` (query): chỉ bản che. Vai trò không được đọc, ngoài phạm vi, khác tổ chức → 404. */
export async function getIdentityDocument(
  db: Kysely<unknown>,
  actor: Actor,
  id: string,
): Promise<IdentityDocumentView> {
  authorizeRead(actor, null);
  const row = await withTenant(db, { orgId: actor.orgId, actorId: actor.membershipId }, async (trx) => {
    const r = await sql<Row>`
      select id, person_id, property_id, doc_type, doc_number_last4, nationality, anonymized_at
      from identity_documents where organization_id = ${actor.orgId} and id = ${id}`.execute(trx);
    return r.rows[0];
  });
  if (!row) throw new CommandError("NOT_FOUND", 404, "Không tìm thấy dữ liệu");
  authorizeRead(actor, row.property_id);
  return view(row);
}

/**
 * Giải mã số đầy đủ — CHỈ gọi từ luồng nghĩa vụ pháp lý đã kiểm quyền (xuất thông báo lưu trú). Không trả qua API đọc,
 * không ghi log/audit/outbox/kết quả command lưu lại.
 */
export async function revealDocNumber(
  trx: Transaction<unknown>,
  pii: PiiCipher,
  orgId: string,
  id: string,
): Promise<string | null> {
  const r = await sql<{ doc_number_enc: Buffer | null }>`
    select doc_number_enc from identity_documents where organization_id = ${orgId} and id = ${id}`.execute(
    trx,
  );
  const enc = r.rows[0]?.doc_number_enc;
  return enc ? pii.decrypt(enc, aad(orgId, id)) : null;
}

/** Tìm hàng theo số (blind index) — không giải mã, không quét bảng. */
export async function findIdentityByNumber(
  trx: Transaction<unknown>,
  pii: PiiCipher,
  orgId: string,
  docType: DocType,
  docNumber: string,
): Promise<string[]> {
  const n = normalizeDocNumber(docNumber);
  if (!n) return [];
  const r = await sql<{ id: string }>`
    select id from identity_documents
    where organization_id = ${orgId} and doc_type = ${docType} and doc_number_hash = ${pii.blindIndex(orgId, docType, n)}
      and anonymized_at is null`.execute(trx);
  return r.rows.map((x) => x.id);
}

/**
 * Mã hoá lại bằng khoá hiện hành (xoay khoá): đọc theo `key_id` cũ, ghi bằng khoá mới, cùng AAD. Trả số hàng đã đổi.
 * Chạy theo lô bởi người vận hành (RUNBOOK) — idempotent.
 */
export async function reencryptIdentityDocuments(
  trx: Transaction<unknown>,
  pii: PiiCipher,
  orgId: string,
  currentKeyId: number,
  limit = 500,
): Promise<number> {
  const rows = await sql<{ id: string; doc_number_enc: Buffer }>`
    select id, doc_number_enc from identity_documents
    where organization_id = ${orgId} and doc_number_enc is not null and doc_number_key_id <> ${currentKeyId}
    order by id limit ${limit} for update`.execute(trx);
  for (const r of rows.rows) {
    const plain = pii.decrypt(r.doc_number_enc, aad(orgId, r.id));
    const enc = pii.encrypt(plain, aad(orgId, r.id));
    await sql`update identity_documents set doc_number_enc = ${enc}, doc_number_key_id = ${pii.keyIdOf(enc)}
              where organization_id = ${orgId} and id = ${r.id}`.execute(trx);
  }
  return rows.rows.length;
}
