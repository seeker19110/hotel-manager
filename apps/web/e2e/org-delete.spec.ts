// E2E xoá tổ chức (T-2312; IND-SAAS-006, UX-CONTENT-005; D-121): chủ (TOTP) vào "Thêm" → "Tổ chức" → khối "Xoá tổ chức" nói rõ thời gian
// chờ, cái bị xoá, cái được giữ → tên sai bị chặn → đúng tên + MỘT nút ⇒ banner chờ xoá (ngày purge) trên mọi trang → huỷ MỘT bước ⇒ bình
// thường. Đếm bước: huỷ ≤ số bước đăng ký (UX-CONTENT-005). Rồi yêu cầu lại → (gọi thẳng hàm purge thay job worker sau 30 ngày) → chủ cũ
// mất quyền vào tổ chức, tải chứng nhận JSON ở /bao-mat và băm khớp SHA-256 hiển thị. Không hộp thoại xác nhận, không đếm ngược.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { expectAccessible } from "./a11y.ts";
import { CORE_CONSENT, submitSignUp } from "./consent.ts";
import { DELETE_OWNER, dbUrlFile, ORG_DELETE, portOf } from "./fixtures.ts";
import { signInWithTotp } from "./sign-in.ts";
import { deleteTotpFile, totp } from "./totp.ts";

test.describe.configure({ mode: "serial" });

/** Đếm thao tác người dùng (điền ô, tick, bấm) của một luồng. */
function counter(page: Page) {
  let n = 0;
  return {
    get n() {
      return n;
    },
    fill: async (label: string, value: string, scope = page.locator("body")) => {
      n++;
      await scope.getByLabel(label).fill(value);
    },
    check: async (label: string | RegExp) => {
      n++;
      await page.getByLabel(label).check();
    },
    click: async (name: string, scope = page.locator("body")) => {
      n++;
      await scope.getByRole("button", { name }).click();
    },
  };
}

test("xoá tổ chức: yêu cầu → banner → huỷ một bước (≤ bước đăng ký) → yêu cầu lại → purge → chứng nhận", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const port = portOf(info.project.use.baseURL);

  // Số bước của luồng ĐĂNG KÝ (mốc so sánh của UX-CONTENT-005).
  const signup = counter(page);
  await page.goto("/dang-ky");
  await signup.fill("Họ và tên", "Người đếm bước (giả)");
  await signup.fill("Email", `dem.buoc.${Date.now().toString(36)}@example.test`);
  await signup.fill("Mật khẩu", ["e2e", "dem", "buoc", "gia"].join("-"));
  await signup.check(CORE_CONSENT);
  await submitSignUp(page, () => signup.click("Tạo tài khoản"));
  await expect(page).toHaveURL(/\/chon-to-chuc$/, { timeout: 15_000 });
  await page.context().clearCookies();

  // Chủ tổ chức đăng nhập (mật khẩu + TOTP) — phiên mới ⇒ đủ "xác thực lại ≤ 5 phút".
  const { secret } = JSON.parse(readFileSync(deleteTotpFile(port), "utf8")) as { secret: string };
  await signInWithTotp(page, DELETE_OWNER, () => totp(secret));
  await page.getByRole("button", { name: ORG_DELETE }).click();
  await expect(page).toHaveURL(/\/phong$/);

  await page.getByRole("navigation", { name: "Chức năng" }).getByRole("link", { name: "Thêm" }).click();
  await page.getByRole("main").getByRole("link", { name: "Tổ chức" }).click();
  await expect(page).toHaveURL(/\/to-chuc$/);
  const block = page.getByTestId("org-delete");
  await expect(block.getByRole("heading", { name: "Xoá tổ chức" })).toBeVisible();
  await expect(block).toContainText("30 ngày");
  await expect(block).toContainText("nghĩa vụ kế toán");
  await expect(block).toContainText("huỷ được bằng một nút");
  await expectAccessible(page);

  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs++;
    void d.dismiss();
  });
  const form = page.getByTestId("org-delete-form");
  await form.getByLabel("Gõ lại tên tổ chức để xác nhận").fill("Tên khác (giả)");
  await form.getByRole("button", { name: "Xoá tổ chức" }).click();
  await expect(form.getByRole("alert").filter({ hasText: "Tên tổ chức không khớp" })).toBeVisible();
  await expect(page.getByTestId("org-deletion-banner")).toHaveCount(0);

  await form.getByLabel("Gõ lại tên tổ chức để xác nhận").fill(ORG_DELETE);
  await form.getByRole("button", { name: "Xoá tổ chức" }).click();
  const banner = page.getByTestId("org-deletion-banner");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText(/Dữ liệu sẽ bị xoá vĩnh viễn vào ngày \d{2}\/\d{2}\/\d{4}/);
  // Ngày theo giờ Việt Nam (UTC+7, không DST) — không phải ngày UTC.
  const [y, m, d] = new Date(Date.now() + 30 * 86_400_000 + 7 * 3_600_000)
    .toISOString()
    .slice(0, 10)
    .split("-");
  await expect(banner).toContainText(`${d}/${m}/${y}`);

  // Banner có trên trang khác.
  await page.goto("/phong");
  await expect(page.getByTestId("org-deletion-banner")).toBeVisible();
  await expectAccessible(page);

  // Huỷ: MỘT bước, không ít hơn/không khó hơn đăng ký.
  const cancel = counter(page);
  await cancel.click("Huỷ xoá tổ chức", page.getByTestId("org-deletion-banner"));
  await expect(page.getByTestId("org-deletion-banner")).toHaveCount(0, { timeout: 15_000 });
  expect(cancel.n).toBe(1);
  expect(cancel.n).toBeLessThanOrEqual(signup.n);
  expect(dialogs).toBe(0);

  // Yêu cầu lại → purge (gọi thẳng hàm CSDL thay job `tenancy.org_purge` chạy sau 30 ngày).
  await page.goto("/to-chuc");
  await page.getByLabel("Gõ lại tên tổ chức để xác nhận").fill(ORG_DELETE);
  await page.getByTestId("org-delete-form").getByRole("button", { name: "Xoá tổ chức" }).click();
  await expect(page.getByTestId("org-deletion-banner")).toBeVisible({ timeout: 15_000 });

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: readFileSync(dbUrlFile(port), "utf8"), max: 1 }),
    }),
  });
  let orgId = "";
  try {
    const o = await sql<{ id: string }>`select id from organizations where name = ${ORG_DELETE}`.execute(db);
    orgId = o.rows[0]?.id ?? "";
    expect(orgId).not.toBe("");
    await sql`update organizations set deletion_requested_at = deletion_requested_at - interval '30 days',
                                       deletion_due_at = deletion_due_at - interval '30 days' where id = ${orgId}`.execute(
      db,
    );
    const r = await sql<{ c: string | null }>`
      select app.org_purge_execute(${orgId}::uuid, now(), 0, 0) as c`.execute(db);
    expect((JSON.parse(r.rows[0]?.c ?? "{}") as { organization_id?: string }).organization_id).toBe(orgId);
  } finally {
    await db.destroy();
  }

  // Chủ cũ không còn vào tổ chức.
  await page.goto("/phong");
  await expect(page).toHaveURL(/\/chon-to-chuc$/);

  // Chứng nhận ở /bao-mat: tải JSON nguyên văn, băm khớp mã hiển thị.
  await page.goto("/bao-mat");
  const certs = page.getByTestId("org-certificates");
  await expect(certs.getByRole("heading", { name: "Chứng nhận xoá tổ chức" })).toBeVisible();
  const item = certs.getByTestId("org-certificate").filter({ hasText: orgId });
  await expect(item).toBeVisible();
  const shown = ((await item.locator("code").textContent()) ?? "").trim();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    item.getByRole("link", { name: "Tải chứng nhận (JSON)" }).click(),
  ]);
  const body = readFileSync((await download.path()) as string);
  expect(createHash("sha256").update(body).digest("hex")).toBe(shown);
  const cert = JSON.parse(body.toString("utf8")) as {
    organization_id: string;
    erased: Record<string, number>;
    retained: { store: string; reason: string }[];
  };
  expect(cert.organization_id).toBe(orgId);
  expect(cert.erased.memberships_revoked).toBeGreaterThanOrEqual(1);
  expect(cert.retained.find((x) => x.store === "organizations")?.reason).toBe(
    "tombstone_for_retained_records",
  );
  await expectAccessible(page);
});
