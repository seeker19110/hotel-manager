// Kiểm tiếp cận dùng chung cho E2E (SPEC-pwa S-015): axe WCAG 2.2 AA (0 vi phạm ở mọi mức impact) + vùng chạm ≥ 44px.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/** Mọi vấn đề tiếp cận của trang hiện tại (rỗng = đạt): vi phạm axe ở MỌI mức impact + vùng chạm < 44 px. */
export async function accessibilityProblems(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  // UX-A11Y-001: minor/moderate/serious/critical đều chặn; không tắt rule nào.
  const problems = r.violations.map(
    (v) => `axe ${v.id} [${v.impact}]: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );

  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [role='button']")]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const b = el.getBoundingClientRect();
        return {
          el: `${el.tagName.toLowerCase()} "${el.textContent?.trim().slice(0, 30)}"`,
          w: b.width,
          h: b.height,
        };
      })
      .filter((x) => x.w < 44 || x.h < 44),
  );
  for (const x of small) problems.push(`vùng chạm < 44 × 44 CSS px: ${x.el} (${x.w} × ${x.h})`);
  return problems;
}

export async function expectAccessible(page: Page): Promise<void> {
  expect(await accessibilityProblems(page), "vấn đề tiếp cận (axe mọi mức, vùng chạm 44 px)").toEqual([]);
}
