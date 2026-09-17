import { expect, test } from "playwright/test";

/**
 * A new browser profile means a new development wallet, so every run signs in as
 * a new owner and gets its own workspace. Nothing here is mocked: the payment is
 * signed by Relay's executor and settles on the local chain.
 */
test.skip(process.env.RUN_WEB_E2E !== "1", "Set RUN_WEB_E2E=1 with the local stack running");

const anvilRecipient = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

test("signs in with a wallet, funds a treasury, and settles a payment", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Ethereum wallet/ }).click();
  await expect(page.getByRole("heading", { name: "My workspace" })).toBeVisible();
  await expect(page.getByText("Finish setting up")).toBeVisible();

  await page.goto("/treasuries");
  await page.getByRole("button", { name: "Add treasury" }).click();
  await page.getByRole("button", { name: /Development account/ }).click();
  await page.locator("form#add-treasury input.input").first().fill("Test account");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Test account" })).toBeVisible();

  await page.getByRole("button", { name: "Fund treasury" }).click();
  await expect(page.getByText(/Added 10 ETH/)).toBeVisible();
  await expect(page.getByText("10.0000")).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await page.locator("form#new-payment input.address").fill(anvilRecipient);
  await page.locator("form#new-payment input.num").fill("0.25");
  await page.locator("form#new-payment input[placeholder='Contractor payout for September']").fill("End to end payment");
  await page.getByRole("button", { name: "Request payment" }).click();

  await page.goto("/payments");
  await page.getByText("End to end payment").click();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Destination received the exact amount")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Finalized", { exact: false })).toBeVisible();
});

test("explains what an invoice needs before it can be created", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Ethereum wallet/ }).click();
  await expect(page.getByRole("heading", { name: "My workspace" })).toBeVisible();
  await page.goto("/invoices");
  await expect(page.getByText("No open invoices")).toBeVisible();
  await page.getByRole("button", { name: "New invoice" }).first().click();
  // A brand new workspace has no treasury, so the console says so rather than failing at the API.
  await expect(page.getByText("Add a treasury first")).toBeVisible();
});
