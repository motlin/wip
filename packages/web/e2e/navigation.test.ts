import { test, expect } from "@playwright/test";

// These pages load real git data from the user's repos, so we use
// waitUntil: "commit" to avoid waiting for slow server-side data fetching.
const goto = { waitUntil: "commit" as const };

test.describe("navigation", () => {
  test("snoozed page loads and shows nav links", async ({ page }) => {
    await page.goto("/snoozed", goto);
    const nav = page.locator("nav");
    await expect(nav).toBeVisible();
    await expect(nav).toContainText("Queue");
    await expect(nav).toContainText("Kanban");
    await expect(nav).toContainText("Snoozed");
    await expect(nav).toContainText("Tests");
    await expect(nav).toContainText("States");
  });

  test("queue page loads without errors", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/queue", goto);
    await expect(page.locator("nav")).toBeVisible();
  });

  test("kanban page loads without errors", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/kanban", goto);
    await expect(page.locator("nav")).toBeVisible();
  });

  test("tests page loads without errors", async ({ page }) => {
    await page.goto("/tests", goto);
    await expect(page.locator("nav")).toBeVisible();
  });

  test("states page loads without errors", async ({ page }) => {
    await page.goto("/states", goto);
    await expect(page.locator("nav")).toBeVisible();
  });

  test("nav links navigate between pages", async ({ page }) => {
    // Start from snoozed (lighter page) to verify nav works
    await page.goto("/snoozed", goto);
    await expect(page.locator("nav")).toBeVisible();

    await page.locator("nav").getByText("Tests").click();
    await expect(page).toHaveURL(/\/tests/);

    await page.locator("nav").getByText("States").click();
    await expect(page).toHaveURL(/\/states/);

    await page.locator("nav").getByText("Snoozed").click();
    await expect(page).toHaveURL(/\/snoozed/);
  });
});
