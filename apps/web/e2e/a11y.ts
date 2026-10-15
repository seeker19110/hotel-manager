// Kiểm tiếp cận dùng chung cho E2E (SPEC-pwa S-015): axe WCAG 2.2 AA (serious/critical = 0) + vùng chạm ≥ 44px.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export async function expectAccessible(page: Page): Promise<void> {
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(blocking, "vi phạm axe serious/critical").toEqual([]);

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
  expect(small, "phần tử tương tác nhỏ hơn 44 × 44 CSS px").toEqual([]);
}
