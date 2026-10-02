import { expect, test, type Page } from "@playwright/test";

/** Local-first features: data folder, what-leaves-the-computer, search history, save as file, backup. */
const password = "Sup3rSecret99";

async function register(page: Page, email: string) {
  await page.goto("/register");
  await page.getByLabel("Name").fill("Local User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/chat/);
}

test("chat says where the message goes; search history and saved answers stay local", async ({ page }, info) => {
  await register(page, `local-${info.project.name}-${Date.now()}@example.com`);
  await expect(page.getByTestId("data-flow-note")).toContainText("Answered on this computer");

  await page.getByRole("button", { name: "Search the web" }).click();
  await expect(page.getByTestId("data-flow-note")).toContainText("search queries go to");
  const box = page.getByLabel("Message WHITE-LOTUS");
  await box.fill("what is the mock fact");
  await box.press("Enter");
  await expect(page.getByText(/Mock result 1 for/).first()).toBeVisible({ timeout: 30_000 });

  // Save the answer as a local file.
  await page.getByRole("button", { name: "Save as file" }).last().click();
  await expect(page.getByText(/to Files on this computer/)).toBeVisible();
  await page.goto("/files");
  await expect(page.getByText(/\.md/).first()).toBeVisible();

  // Privacy & storage.
  await page.goto("/settings?tab=storage");
  await expect(page.getByRole("heading", { name: "What leaves this computer" })).toBeVisible();
  await expect(page.getByTestId("data-dir")).not.toBeEmpty();
  await expect(page.getByTestId("search-history")).toContainText("mock query one");
  await page.getByRole("button", { name: "Delete search" }).first().click();
  await expect(page.getByTestId("search-history")).not.toContainText("mock query one");
});

test("readable export downloads a ZIP from this computer", async ({ page }, info) => {
  await register(page, `export-${info.project.name}-${Date.now()}@example.com`);
  await page.goto("/settings?tab=data");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download ZIP" }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^white-lotus-export-.*\.zip$/);
});
