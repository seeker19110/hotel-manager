// Trường tuỳ chọn: thiếu ≠ rỗng ≠ giá trị (BASE-DATA-003) ở ba chỗ chuẩn hoá chuỗi rỗng → NULL, trên Postgres thật:
// email người đặt (reservations.ts), quốc tịch khách (stays.ts), SĐT người (lease.ts createPerson).
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPiiCipher, devKeyring } from "../crypto/pii.ts";
import { createPerson } from "../lease/lease.ts";
import { codeOf, okAs, runAs } from "../testing/helpers.ts";
import { type Hotel, seedHotel } from "../testing/hotel.ts";
import { createReservation } from "./reservations.ts";
import { walkIn } from "./stays.ts";

let h: Hotel;
const pii = createPiiCipher(devKeyring());
let seq = 0;

beforeAll(async () => {
  h = await seedHotel();
});
afterAll(async () => {
  await h?.t.drop();
});

async function unit(): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await sql`insert into units (id, organization_id, property_id, floor_id, room_type_id, code, housekeeping_status)
            values (${id}, ${h.org.orgId}, ${h.org.propertyId}, ${h.org.floorId}, ${h.org.roomTypeId}, ${`8${String(seq).padStart(2, "0")}`}, 'inspected')`.execute(
    h.t.admin,
  );
  return id;
}

async function bookerEmail(email: string | undefined): Promise<string | null> {
  const d = await okAs(h.t, h.manager, async (ctx) =>
    createReservation(ctx, {
      unitId: await unit(),
      arrivalDate: "2026-11-02",
      departureDate: "2026-11-03",
      guests: 1,
      source: "direct",
      booker: {
        fullName: "Khách tuỳ chọn",
        phone: `09${String(20_000_000 + seq).slice(-8)}`,
        ...(email === undefined ? {} : { email }),
      },
    }),
  );
  const r = await sql<{ email: string | null }>`
    select p.email from reservations r join persons p on p.id = r.booker_person_id where r.id = ${d.reservationId}`.execute(
    h.t.admin,
  );
  return r.rows[0]?.email ?? null;
}

describe("email người đặt: thiếu/rỗng/khoảng trắng → NULL; có giá trị → chữ thường", () => {
  it.each([
    ["không gửi", undefined, null],
    ["chuỗi rỗng", "", null],
    ["toàn khoảng trắng", "   ", null],
    ["có giá trị, hoa + khoảng trắng", "  Khach@Example.COM ", "khach@example.com"],
  ])("%s", async (_name, input, want) => {
    expect(await bookerEmail(input)).toBe(want);
  });

  it("email sai định dạng vẫn bị từ chối (không bị nuốt thành NULL)", async () => {
    const code = await codeOf(
      runAs(h.t, h.manager, async (ctx) =>
        createReservation(ctx, {
          unitId: await unit(),
          arrivalDate: "2026-11-02",
          departureDate: "2026-11-03",
          guests: 1,
          source: "direct",
          booker: { fullName: "Khách sai email", phone: "0912345678", email: "khong-co-a-cong" },
        }),
      ),
    );
    expect(code).toBe("VALIDATION_FAILED");
  });
});

describe("quốc tịch khách: thiếu/rỗng = chưa khai → mặc định VN cho người mới, giữ giá trị đã lưu cho người cũ", () => {
  it.each([
    ["rỗng", ""],
    ["khoảng trắng", "  "],
    ["không gửi", undefined],
  ])("%s", async (_name, nationality) => {
    const s = await okAs(h.t, h.frontDesk, async (ctx) =>
      walkIn(ctx, pii, {
        unitId: await unit(),
        departureDate: "2026-11-04",
        guests: [
          {
            fullName: "Khách không quốc tịch",
            phone: `09${String(30_000_000 + seq).slice(-8)}`,
            docType: "cccd",
            docNumber: `0790${String(10_000_000 + seq).slice(-8)}`,
            ...(nationality === undefined ? {} : { nationality }),
          },
        ],
        now: new Date("2026-11-03T08:00:00Z"),
      }),
    );
    const r = await sql<{ nationality: string | null }>`
      select p.nationality from stays s join persons p on p.id = s.primary_guest_person_id where s.id = ${s.stayId}`.execute(
      h.t.admin,
    );
    expect(r.rows[0]?.nationality).toBe("VN");
  });

  it.each([
    ["rỗng", ""],
    ["khoảng trắng", "  "],
  ])(
    "khách nước ngoài đã lưu (US) + quốc tịch %s → giữ US, không ghi đè thành VN",
    async (_name, nationality) => {
      const first = await okAs(h.t, h.frontDesk, async (ctx) =>
        walkIn(ctx, pii, {
          unitId: await unit(),
          departureDate: "2026-11-04",
          guests: [
            {
              fullName: "Jane Doe",
              phone: "+15550002222",
              docType: "passport",
              docNumber: "P1112223",
              nationality: "US",
            },
          ],
          now: new Date("2026-11-03T08:00:00Z"),
        }),
      );
      const person = (
        await sql<{
          p: string;
        }>`select primary_guest_person_id as p from stays where id = ${first.stayId}`.execute(h.t.admin)
      ).rows[0]?.p as string;
      await okAs(h.t, h.frontDesk, async (ctx) =>
        walkIn(ctx, pii, {
          unitId: await unit(),
          departureDate: "2026-11-06",
          guests: [{ personId: person, docType: "passport", docNumber: "P1112223", nationality }],
          now: new Date("2026-11-05T08:00:00Z"),
        }),
      );
      const r = await sql<{
        nationality: string | null;
      }>`select nationality from persons where id = ${person}`.execute(h.t.admin);
      expect(r.rows[0]?.nationality).toBe("US");
    },
  );

  it("mã chữ thường được chuẩn hoá HOA; mã sai ('V') bị từ chối", async () => {
    const ok = await okAs(h.t, h.frontDesk, async (ctx) =>
      walkIn(ctx, pii, {
        unitId: await unit(),
        departureDate: "2026-11-05",
        guests: [
          {
            fullName: "Khách vn",
            phone: `09${String(50_000_000 + seq).slice(-8)}`,
            docType: "cccd",
            docNumber: "079099999999",
            nationality: " vn ",
          },
        ],
        now: new Date("2026-11-04T08:00:00Z"),
      }),
    );
    const n = await sql<{ nationality: string }>`
      select p.nationality from stays s join persons p on p.id = s.primary_guest_person_id where s.id = ${ok.stayId}`.execute(
      h.t.admin,
    );
    expect(n.rows[0]?.nationality).toBe("VN");
    const bad = await codeOf(
      runAs(h.t, h.frontDesk, async (ctx) =>
        walkIn(ctx, pii, {
          unitId: await unit(),
          departureDate: "2026-11-05",
          guests: [
            {
              fullName: "Sai",
              phone: `09${String(60_000_000 + seq).slice(-8)}`,
              docType: "cccd",
              docNumber: "079099999998",
              nationality: "V",
            },
          ],
          now: new Date("2026-11-04T08:00:00Z"),
        }),
      ),
    );
    expect(bad).toBe("VALIDATION_FAILED");
  });
});

describe("createPerson: SĐT rỗng → NULL, có giá trị phải hợp lệ", () => {
  async function phoneOf(phone: string | undefined): Promise<string | null> {
    const { personId } = await okAs(h.t, h.manager, (ctx) =>
      createPerson(ctx, {
        propertyId: h.org.propertyId,
        fullName: "Người tuỳ chọn",
        ...(phone === undefined ? {} : { phone }),
      }),
    );
    const r = await sql<{ phone: string | null }>`select phone from persons where id = ${personId}`.execute(
      h.t.admin,
    );
    return r.rows[0]?.phone ?? null;
  }
  it.each([
    ["không gửi", undefined, null],
    ["rỗng", "", null],
    ["khoảng trắng", "   ", null],
    ["có giá trị", " 0912345678 ", "0912345678"],
  ])("%s", async (_name, input, want) => {
    expect(await phoneOf(input)).toBe(want);
  });
  it("SĐT sai bị từ chối", async () => {
    const code = await codeOf(
      runAs(h.t, h.manager, (ctx) =>
        createPerson(ctx, { propertyId: h.org.propertyId, fullName: "Sai SĐT", phone: "abc" }),
      ),
    );
    expect(code).toBe("VALIDATION_FAILED");
  });
});
