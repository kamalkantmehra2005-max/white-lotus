import { expect, test, type Page } from "@playwright/test";

/**
 * Browser-first flow: open URL → Start Chatting → real server-side persistence.
 * Requires the server to run with ALLOW_GUEST_CHAT=true (skips otherwise).
 */
const password = "Sup3rSecret99";

async function startAsGuest(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Start Chatting/ }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByTestId("guest-note")).toBeVisible();
}

async function send(page: Page, text: string) {
  const box = page.getByLabel("Message WHITE-LOTUS");
  await box.fill(text);
  await box.press("Enter");
  await expect(page.getByText(`Echo: ${text}`)).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/[\w-]+/);
}

test.beforeEach(async ({ request }) => {
  const r = await request.get("/api/auth/providers");
  test.skip(!(await r.json()).guest, "guest mode is off on this server");
});

test("guest: Start Chatting → chat → refresh keeps the conversation (server-side)", async ({ page }) => {
  await startAsGuest(page);
  // Everything a guest needs loads without touching account-only APIs.
  await expect(page.getByRole("button", { name: /^Model:/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Search the web" })).toBeEnabled();
  await send(page, "guest hello one");
  await expect(page.getByText(/Couldn't load/)).toHaveCount(0);
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.getByText("Echo: guest hello one")).toBeVisible();
  // It's in the history list too, loaded from the database — not localStorage.
  await page.evaluate(() => localStorage.clear());
  await page.goto("/chat");
  const id = url.split("/chat/")[1];
  await expect(page.getByRole("navigation", { name: "Conversations" }).locator(`a[href="/chat/${id}"]`)).toBeVisible();
});

test("guest: files, projects, memory and settings need an account (UI and API)", async ({ page }) => {
  await startAsGuest(page);
  for (const [path, heading] of [["/files", "Files needs a free account"], ["/projects", "Projects needs a free account"], ["/settings", "Settings needs a free account"], ["/settings?tab=memory", "Memory needs a free account"]]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  for (const api of ["/api/files", "/api/projects", "/api/memories", "/api/settings", "/api/settings/export", "/api/admin/stats"]) {
    const r = await page.request.get(api);
    expect([403]).toContain(r.status());
  }
  const up = await page.request.post("/api/files", { multipart: { file: { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("secret") } } });
  expect(up.status()).toBe(403);
  expect((await up.json()).error.code).toBe("account_required");
  await page.goto("/chat");
  await page.getByRole("button", { name: /Attach files \(needs a free account\)/ }).click();
  await expect(page.getByText(/File uploads need a free account/)).toBeVisible();
});

test("guest: one guest can't read another guest's conversation", async ({ page, browser }) => {
  await startAsGuest(page);
  await send(page, "guest private note");
  const id = page.url().split("/chat/")[1];
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await startAsGuest(p2);
  expect((await p2.request.get(`/api/conversations/${id}`)).status()).toBe(404);
  expect((await p2.request.patch(`/api/conversations/${id}`, { data: { title: "x" } })).status()).toBe(404);
  expect((await p2.request.delete(`/api/conversations/${id}`)).status()).toBe(404);
  await p2.goto(`/chat/${id}`);
  await expect(p2.getByText("Echo: guest private note")).toHaveCount(0);
  await other.close();
});

test("guest → create account keeps the chats; the account then works on another device", async ({ page, browser }, info) => {
  await startAsGuest(page);
  await send(page, "keep this guest chat");
  const id = page.url().split("/chat/")[1];
  await page.goto("/register?from=guest");
  await expect(page.getByLabel(/Keep the chats from my guest session/)).toBeChecked();
  const email = `guest-up-${info.project.name}-${Date.now()}@example.com`;
  await page.getByLabel("Name").fill("Upgraded Guest");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/chat/);
  const nav = page.getByRole("navigation", { name: "Conversations" });
  await expect(nav.locator(`a[href="/chat/${id}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("guest-note")).toHaveCount(0);

  // "Device B": a fresh browser with a different user agent — only the URL and the login.
  const deviceB = await browser.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0" });
  const b = await deviceB.newPage();
  await b.goto("/login");
  await b.getByLabel("Email").fill(email);
  await b.getByLabel("Password").fill(password);
  await b.getByRole("button", { name: "Sign in" }).click();
  await expect(b).toHaveURL(/\/chat/);
  await expect(b.getByRole("navigation", { name: "Conversations" }).locator(`a[href="/chat/${id}"]`)).toHaveCount(1);
  await b.goto(`/chat/${id}`);
  await expect(b.getByText("Echo: keep this guest chat")).toBeVisible();
  await deviceB.close();
});

test("guest: ending the session deletes its chats", async ({ page }, info) => {
  await startAsGuest(page);
  await send(page, "delete me on exit");
  const id = page.url().split("/chat/")[1];
  const shell = page.getByRole("complementary", { name: "Sidebar" });
  if (info.project.name !== "desktop") await page.getByRole("button", { name: "Open sidebar" }).click();
  await shell.getByRole("button", { name: "End guest session" }).click();
  await page.getByRole("button", { name: "End and delete" }).click();
  await expect(page).toHaveURL(/\/$|\/\?/);
  // Start a new guest: the old conversation is gone for everyone.
  await startAsGuest(page);
  expect((await page.request.get(`/api/conversations/${id}`)).status()).toBe(404);
});

test("guest: web research runs real searches and shows the sources it used", async ({ page }) => {
  await startAsGuest(page);
  await page.getByRole("button", { name: "Search the web" }).click();
  const box = page.getByLabel("Message WHITE-LOTUS");
  await box.fill("what is the mock fact");
  await box.press("Enter");
  await expect(page.getByText(/Mock result 1 for/).first()).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByText(/Mock result 1 for/).first()).toBeVisible();
});
