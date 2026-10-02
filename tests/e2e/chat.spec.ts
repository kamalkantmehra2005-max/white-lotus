import { expect, test, type Page } from "@playwright/test";

const password = "Sup3rSecret99";

async function register(page: Page, email: string) {
  await page.goto("/register");
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/chat/);
}

test("landing page renders hero and CTAs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "WHITE-LOTUS", exact: true })).toBeVisible();
  await expect(page.getByText("Your private AI workspace.")).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: /Start Chatting/ }).or(page.getByRole("main").getByRole("link", { name: /^(Sign in|Set up WHITE-LOTUS)$/ })).first()).toBeVisible();
  await expect(page.getByText("Runs on this computer. Your conversations and files stay here.")).toBeVisible();
  if (process.env.NEXT_PUBLIC_CREATOR_NAME) await expect(page.getByText(`Made by ${process.env.NEXT_PUBLIC_CREATOR_NAME}`).first()).toBeVisible();
});

test("register → chat streams → tool use → persisted history → slash command", async ({ page }, info) => {
  await register(page, `e2e-${info.project.name}-${Date.now()}@example.com`);

  const box = page.getByLabel("Message WHITE-LOTUS");
  await box.fill("hello from playwright");
  await box.press("Enter");
  await expect(page.getByText("Echo: hello from playwright")).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/[\w-]+/);

  await box.fill("calculate 12*12");
  await box.press("Enter");
  await expect(page.getByText("The calculator says")).toBeVisible();
  await expect(page.locator("strong", { hasText: "144" })).toBeVisible();

  await page.reload();
  await expect(page.getByText("Echo: hello from playwright")).toBeVisible();

  await box.fill("/research");
  await box.press("Enter");
  await expect(page.getByRole("button", { name: /Mode: Research/ })).toBeVisible();
});

test("stop generation", async ({ page }, info) => {
  await register(page, `stop-${info.project.name}-${Date.now()}@example.com`);
  const box = page.getByLabel("Message WHITE-LOTUS");
  await box.fill("slow " + "word ".repeat(40));
  await box.press("Enter");
  await expect(page.getByText(/Echo: slow/)).toBeVisible();
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(page.getByText("Stopped")).toBeVisible();
});

test("protected routes redirect to login", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/login/);
});

test("New chat starts a clean conversation (regression)", async ({ page }, info) => {
  await register(page, `new-${info.project.name}-${Date.now()}@example.com`);
  const box = page.getByLabel("Message WHITE-LOTUS");
  await box.fill("first conversation");
  await box.press("Enter");
  await expect(page.getByText("Echo: first conversation")).toBeVisible();
  const firstUrl = page.url();
  if (info.project.name !== "desktop") await page.getByLabel("Open sidebar").click();
  await page.getByRole("link", { name: "New chat" }).click();
  await expect(page.getByText("Echo: first conversation")).toBeHidden();
  await box.fill("second conversation");
  await box.press("Enter");
  await expect(page.getByText("Echo: second conversation")).toBeVisible();
  await expect(page.getByText("Echo: first conversation")).toBeHidden();
  await expect(page).not.toHaveURL(firstUrl);
});

test("model and mode pickers are available (incl. mobile)", async ({ page }, info) => {
  await register(page, `pick-${info.project.name}-${Date.now()}@example.com`);
  await expect(page.getByRole("button", { name: /^Model:/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Mode:/ })).toBeVisible();
});
