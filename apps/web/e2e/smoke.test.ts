import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { resolve } from "node:path";

// Boots the real web server (from the repo root, so bunfig.toml's
// PUBLIC_* env inlining applies) and drives it in a real browser. This is the
// check that tsc/unit tests can't do: it catches bundle-time/browser-only
// failures such as `process is not defined` (backlog E1).
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
// Fake API origin: never listened on, every request is stubbed via page.route.
const API = "http://opd-api.test";

let server: ReturnType<typeof Bun.spawn>;
let browser: Browser;

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`web server did not start on ${BASE}`);
}

beforeAll(async () => {
  server = Bun.spawn(["bun", "apps/web/src/server.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, WEB_PORT: String(PORT), PUBLIC_API_URL: API },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForServer();
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
});

test("app loads, login renders, no console errors", async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // The logged-out session probe legitimately 401s; the browser logs that.
    if (msg.location().url === `${API}/auth/me`) return;
    errors.push(`console: ${msg.text()}`);
  });
  const apiPaths: string[] = [];
  await page.route(`${API}/**`, (route) => {
    apiPaths.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" },
      body: JSON.stringify({ error: { code: "unauthenticated", message: "Not signed in" } }),
    });
  });

  await page.goto(BASE);
  await page.getByRole("heading", { name: "OPD Snapshot" }).waitFor();
  await page.getByLabel("Email").waitFor();
  await page.getByLabel("Password").waitFor();
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  await page.waitForLoadState("networkidle");

  expect(errors).toEqual([]);
  // PUBLIC_API_URL reached the browser and is what the client calls.
  expect(apiPaths).toContain("/auth/me");
  await page.close();
}, 30_000);
