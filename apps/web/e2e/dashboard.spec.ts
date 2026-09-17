import { expect, test } from "playwright/test";

test("navigates, creates a proposal, and changes agent state", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await page.getByRole("button", { name: "Create proposal" }).click();
  await page.getByLabel("Title").fill("Test inference credits");
  await page.getByLabel("Amount").fill("125");
  await page.getByLabel("Destination").fill("0x000000000000000000000000000000000000beef");
  await page.getByRole("button", { name: "Create proposal", exact: true }).last().click();
  await expect(page.getByText("Test inference credits")).toBeVisible();

  await page.getByRole("button", { name: /Agents$/ }).click();
  await page.getByRole("button", { name: "Freeze" }).first().click();
  await expect(page.getByText("Frozen").first()).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: /Proposals/ }).click();
  await expect(page.getByText("Test inference credits")).toBeVisible();
});
