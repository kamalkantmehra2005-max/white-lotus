import { expect, test, type Page } from "@playwright/test";

const password = "Sup3rSecret99";

/** Fail the test on any Content-Security-Policy violation or uncaught page error. */
function guard(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to (execute|load|apply)/i.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

async function register(page: Page, email: string) {
  await page.goto("/register");
  await page.getByLabel("Name").fill("Security E2E");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/chat/);
}

test("strict CSP: app renders and works with no violations (landing, auth, chat, settings, files)", async ({ page }, info) => {
  const problems = guard(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "WHITE-LOTUS", exact: true })).toBeVisible();
  await register(page, `csp-${info.project.name}-${Date.now()}@example.com`);
  const box = page.getByLabel("Message WHITE-LOTUS");
  await box.fill("hello under strict CSP");
  await box.press("Enter");
  await expect(page.getByText("Echo: hello under strict CSP")).toBeVisible();
  await page.goto("/settings?tab=security");
  await expect(page.getByText("Active sessions")).toBeVisible();
  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
  // Theme toggle relies on next-themes' inline script, which must carry the nonce
  await page.goto("/");
  await page.getByRole("button", { name: /Switch to (dark|light) theme/ }).click();
  expect(problems, problems.join("\n")).toEqual([]);
});

test("creator credit appears on landing, auth, chat, settings, projects and files", async ({ page }, info) => {
  const name = process.env.NEXT_PUBLIC_CREATOR_NAME;
  test.skip(!name, "NEXT_PUBLIC_CREATOR_NAME not set for this run");
  const credit = () => page.getByText(`Made by ${name}`).first();
  for (const p of ["/", "/login", "/register", "/forgot-password"]) {
    await page.goto(p);
    await expect(credit(), p).toBeVisible();
  }
  await register(page, `credit-${info.project.name}-${Date.now()}@example.com`);
  for (const p of ["/chat", "/settings", "/projects", "/files"]) {
    await page.goto(p);
    await expect(credit(), p).toBeVisible();
  }
});

test("sign out everywhere ends sessions on other browsers", async ({ browser }, info) => {
  const email = `everywhere-${info.project.name}-${Date.now()}@example.com`;
  const a = await browser.newContext();
  const pa = await a.newPage();
  await register(pa, email);
  const b = await browser.newContext();
  const pb = await b.newPage();
  await pb.goto("/login");
  await pb.getByLabel("Email").fill(email);
  await pb.getByLabel("Password").fill(password);
  await pb.getByRole("button", { name: "Sign in" }).click();
  await expect(pb).toHaveURL(/\/chat/);

  await pa.goto("/settings?tab=security");
  // Exactly two active-session rows: this browser (marked "This device") and the other one (revocable).
  const rows = pa.getByRole("listitem").filter({ hasText: /Signed in .* last active/ });
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "This device" })).toHaveCount(1);
  await expect(rows.getByRole("button", { name: "Revoke" })).toHaveCount(1);
  await pa.getByRole("button", { name: "Sign out everywhere" }).first().click();
  await pa.getByRole("dialog").getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(pa).toHaveURL(/\/login/);

  // The other browser still holds its cookie, but the server has revoked the session.
  await pb.goto("/settings");
  await expect(pb).toHaveURL(/\/login\?expired=1/);
  await expect(pb.getByText(/Your session has ended/)).toBeVisible();
  await a.close();
  await b.close();
});

test("file download goes through a short-lived signed link", async ({ page }, info) => {
  await register(page, `dl-${info.project.name}-${Date.now()}@example.com`);
  await page.goto("/files");
  await page.locator('input[type="file"]').setInputFiles({ name: "memo.txt", mimeType: "text/plain", buffer: Buffer.from("Confidential memo body") });
  await expect(page.getByText("memo.txt")).toBeVisible();
  const linkReq = page.waitForRequest((r) => r.url().includes("/link") && r.method() === "POST");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download memo.txt" }).click();
  await linkReq;
  const d = await download;
  expect(d.url()).toMatch(/\/api\/files\/[\w-]+\/download\?exp=\d+&sig=[\w-]+/);
  expect(d.suggestedFilename()).toBe("memo.txt");
  // The unsigned URL no longer serves documents
  const id = d.url().match(/files\/([\w-]+)\/download/)![1];
  expect((await page.request.get(`/api/files/${id}`)).status()).toBe(403);
});
