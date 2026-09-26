import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { resolve } from "node:path";

// Boots the real web server (PUBLIC_API_URL is served to the browser at
// /config.json, not inlined at build time) and drives it in a real browser. This is the
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

// Extraction Review, signed in as staff with a stubbed API. Pending and
// done-with-zero-facts must be told apart by the user, not just by string.
async function openReview(extractionStatus: "pending" | "done") {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };
  await page.route(`${API}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (path === "/auth/me") return json({ id: "u1", name: "Test Staff", email: "s@opd.local", role: "staff" });
    if (path === "/documents/doc1/facts") {
      return json({
        document: {
          id: "doc1", patient_id: "p1", visit_id: "v1", file_ref: "local://x.pdf", document_type: "blood",
          source_origin: "own_hospital", uploaded_by: "u1", uploaded_at: "2026-01-01T00:00:00Z",
          ocr_status: "done", ocr_text_ref: null, needs_manual_date: false,
          extraction_status: extractionStatus, extraction_error: null,
        },
        facts: [],
        tracked_markers: [],
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });
  await page.goto(`${BASE}/#/documents/doc1/review`);
  await page.getByRole("heading", { name: "Extraction review" }).waitFor();
  return { page, errors };
}

const PENDING_TEXT = "Extraction has not run for this document yet.";
const ZERO_FACTS_TEXT = "Extraction ran and found no facts in this document.";

test("review screen: pending shows 'not run yet' in a card, never the zero-facts message", async () => {
  const { page, errors } = await openReview("pending");
  await page.getByText(PENDING_TEXT).waitFor();
  expect(await page.getByText(ZERO_FACTS_TEXT).count()).toBe(0);
  expect(await page.locator(".card", { hasText: PENDING_TEXT }).count()).toBe(1);
  expect(await page.locator(".empty-state").count()).toBe(0);
  if (process.env.E2E_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/pending.png` });
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("review screen: done with zero facts shows 'ran and found nothing' as an empty state, never the pending message", async () => {
  const { page, errors } = await openReview("done");
  await page.getByText(ZERO_FACTS_TEXT).waitFor();
  expect(await page.getByText(PENDING_TEXT).count()).toBe(0);
  expect(await page.locator(".empty-state", { hasText: ZERO_FACTS_TEXT }).count()).toBe(1);
  expect(await page.locator(".card", { hasText: PENDING_TEXT }).count()).toBe(0);
  if (process.env.E2E_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/done-zero.png` });
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("a failing /config.json shows the connectivity error instead of a blank screen", async () => {
  const page = await browser.newPage();
  await page.route(`${BASE}/config.json`, (route) => route.abort());
  await page.goto(BASE);
  await page.getByText("Couldn't reach the server").waitFor();
  expect(await page.getByRole("heading", { name: "OPD Snapshot" }).count()).toBeGreaterThan(0);
  await page.close();
}, 30_000);

test("a /config.json with a missing, empty or non-string apiUrl shows the connectivity error, not a silent request to 'undefined/...'", async () => {
  for (const body of [{}, { apiUrl: "" }, { apiUrl: 5 }]) {
    const page = await browser.newPage();
    const requested: string[] = [];
    page.on("request", (req) => requested.push(req.url()));
    await page.route(`${BASE}/config.json`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
    await page.goto(BASE);
    await page.getByText("Couldn't reach the server").waitFor({ timeout: 5000 });
    expect(requested.filter((u) => u.includes("/auth/me"))).toEqual([]);
    await page.close();
  }
}, 30_000);

// The client gives /config.json 8s before giving up, so "hangs" surfaces as the
// connectivity error just after that, rather than a permanently blank screen.
test("a /config.json that never responds still ends in the connectivity error (no permanent blank screen)", async () => {
  const page = await browser.newPage();
  await page.route(`${BASE}/config.json`, () => {}); // never fulfilled, aborted or continued
  await page.goto(BASE);
  await page.getByText("Couldn't reach the server").waitFor({ timeout: 12_000 });
  expect(await page.getByRole("heading", { name: "OPD Snapshot" }).count()).toBeGreaterThan(0);
  await page.close();
}, 30_000);

// Sign-off / reopen buttons on the review FactCard. The stub keeps mutable fact
// state so a click's POST flips the card the way the real API would.
type StubFact = { verification_state: string; has_blocking_conflict?: boolean; needs_manual_date?: boolean };

async function openReviewAs(role: "staff" | "oncologist", stub: StubFact) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000); // fail fast: a missing button must not outlive the test timeout
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  const posts: string[] = [];
  const state = { ...stub };
  const cors = {
    "Access-Control-Allow-Origin": BASE,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  };
  const fact = () => ({
    id: "f1", patient_id: "p1", visit_id: "v1", document_id: "doc1", tracked_marker_id: "m1", tracked_marker_name: "CEA",
    raw_marker_label: null, field_type: "marker_value", value: "4.2", unit: "ng/mL", reference_range: "0-5",
    as_of_date: state.needs_manual_date ? null : "2026-02-01", needs_manual_date: state.needs_manual_date ?? false,
    coverage_status: "value_found", verification_state: state.verification_state,
    has_blocking_conflict: state.has_blocking_conflict ?? false,
    source_page: 1, source_location: null, source_snippet: "CEA 4.2 ng/mL",
  });
  await page.route(`${API}/**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (path === "/auth/me") return json({ id: "u1", name: "Test", email: "t@opd.local", role });
    if (path === "/documents/doc1/facts") {
      return json({
        document: {
          id: "doc1", patient_id: "p1", visit_id: "v1", file_ref: "local://x.pdf", document_type: "blood",
          source_origin: "own_hospital", uploaded_by: "u1", uploaded_at: "2026-01-01T00:00:00Z",
          ocr_status: "done", ocr_text_ref: null, needs_manual_date: false, extraction_status: "done", extraction_error: null,
        },
        // Undated facts only render as cards when a sibling is dated (an all-undated document
        // shows the bulk-date form instead), so an undated stub gets a dated PSA sibling.
        facts: state.needs_manual_date ? [fact(), { ...fact(), id: "f2", tracked_marker_name: "PSA", needs_manual_date: false, as_of_date: "2026-02-01", verification_state: "unverified", has_blocking_conflict: false }] : [fact()],
        tracked_markers: [],
      });
    }
    if (req.method() === "POST" && path === "/facts/f1/sign-off") {
      posts.push(path);
      state.verification_state = "oncologist_signed_off";
      return json(fact());
    }
    if (req.method() === "POST" && path === "/facts/f1/reopen") {
      posts.push(path);
      state.verification_state = "reopened_by_oncologist";
      return json(fact());
    }
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });
  await page.goto(`${BASE}/#/documents/doc1/review`);
  await page.getByRole("heading", { name: "CEA" }).waitFor();
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "CEA" }) });
  const signOff = card.getByRole("button", { name: "Sign off", exact: true });
  const reopen = card.getByRole("button", { name: "Reopen", exact: true });
  return { page, errors, posts, signOff, reopen };
}

for (const verification_state of ["unverified", "staff_corrected", "reopened_by_oncologist"]) {
  test(`oncologist sees an active Sign off button for a ${verification_state} fact; clicking POSTs and flips it to Reopen`, async () => {
    const { page, errors, posts, signOff, reopen } = await openReviewAs("oncologist", { verification_state });
    expect(await signOff.isEnabled()).toBe(true);
    expect(await reopen.count()).toBe(0);
    await signOff.click();
    await reopen.waitFor();
    expect(posts).toEqual(["/facts/f1/sign-off"]);
    expect(await signOff.count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
}

test("oncologist sees a disabled Sign off with 'Blocked by an unresolved conflict' when has_blocking_conflict", async () => {
  const { page, posts, signOff } = await openReviewAs("oncologist", { verification_state: "unverified", has_blocking_conflict: true });
  expect(await signOff.isDisabled()).toBe(true);
  await page.getByText("Blocked by an unresolved conflict").waitFor();
  expect(posts).toEqual([]);
  await page.close();
}, 30_000);

test("oncologist sees a disabled Sign off with 'Needs a date before sign-off' when the fact is undated", async () => {
  const { page, signOff } = await openReviewAs("oncologist", { verification_state: "staff_corrected", needs_manual_date: true });
  expect(await signOff.isDisabled()).toBe(true);
  await page.getByText("Needs a date before sign-off").waitFor();
  expect(await page.getByText("Blocked by an unresolved conflict").count()).toBe(0);
  await page.close();
}, 30_000);

test("when both block sign-off, the conflict reason is the one shown", async () => {
  const { page, signOff } = await openReviewAs("oncologist", { verification_state: "unverified", has_blocking_conflict: true, needs_manual_date: true });
  expect(await signOff.isDisabled()).toBe(true);
  await page.getByText("Blocked by an unresolved conflict").waitFor();
  await page.close();
}, 30_000);

test("oncologist sees Reopen (not Sign off) for an oncologist_signed_off fact; clicking POSTs and flips back to Sign off", async () => {
  const { page, errors, posts, signOff, reopen } = await openReviewAs("oncologist", { verification_state: "oncologist_signed_off" });
  expect(await reopen.isEnabled()).toBe(true);
  expect(await signOff.count()).toBe(0);
  await reopen.click();
  await signOff.waitFor();
  expect(posts).toEqual(["/facts/f1/reopen"]);
  expect(await reopen.count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("staff sees neither Sign off nor Reopen, in any verification state, and no blocked-reason text", async () => {
  for (const verification_state of ["unverified", "oncologist_signed_off"]) {
    const { page, signOff, reopen } = await openReviewAs("staff", { verification_state, has_blocking_conflict: true });
    expect(await signOff.count()).toBe(0);
    expect(await reopen.count()).toBe(0);
    expect(await page.getByText("Blocked by an unresolved conflict").count()).toBe(0);
    await page.close();
  }
}, 30_000);

test("per-fact undated fact: sign-off is disabled with a reason until its date is saved, then goes active without a reload", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  let navigations = 0;
  page.on("framenavigated", (f) => f === page.mainFrame() && navigations++);

  const cors = {
    "Access-Control-Allow-Origin": BASE,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  };
  // f1 is dated; f2 is undated until the PATCH below, as the real per-fact date flow produces.
  const base = {
    patient_id: "p1", visit_id: "v1", document_id: "doc1", tracked_marker_id: "m1", raw_marker_label: null,
    field_type: "marker_value", value: "4.2", unit: "ng/mL", reference_range: "0-5", coverage_status: "value_found",
    has_blocking_conflict: false, source_page: 1, source_location: null, source_snippet: "x",
  };
  const f1 = { ...base, id: "f1", tracked_marker_name: "CEA", as_of_date: "2026-02-01", needs_manual_date: false, verification_state: "unverified" };
  const f2 = { ...base, id: "f2", tracked_marker_name: "PSA", as_of_date: null as string | null, needs_manual_date: true, verification_state: "unverified" };
  const patches: unknown[] = [];

  await page.route(`${API}/**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (path === "/auth/me") return json({ id: "u1", name: "Onc", email: "o@opd.local", role: "oncologist" });
    if (path === "/documents/doc1/facts") {
      return json({
        document: {
          id: "doc1", patient_id: "p1", visit_id: "v1", file_ref: "local://x.pdf", document_type: "blood",
          source_origin: "own_hospital", uploaded_by: "u1", uploaded_at: "2026-01-01T00:00:00Z",
          ocr_status: "done", ocr_text_ref: null, needs_manual_date: f2.needs_manual_date, extraction_status: "done", extraction_error: null,
        },
        facts: [f1, f2],
        tracked_markers: [],
      });
    }
    if (req.method() === "PATCH" && path === "/facts/f2") {
      const body = JSON.parse(req.postData() ?? "{}");
      patches.push(body);
      f2.as_of_date = body.as_of_date;
      f2.needs_manual_date = false;
      f2.verification_state = "staff_corrected";
      return json(f2);
    }
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });

  await page.goto(`${BASE}/#/documents/doc1/review`);
  const cardFor = (name: string) => page.locator(".card", { has: page.getByRole("heading", { name }) });
  const cea = cardFor("CEA");
  const psa = cardFor("PSA");
  await cea.waitFor();

  // Before: dated fact active, undated fact disabled with the reason.
  expect(await cea.getByRole("button", { name: "Sign off", exact: true }).isEnabled()).toBe(true);
  expect(await cea.getByText("Needs a date before sign-off").count()).toBe(0);
  const psaSignOff = psa.getByRole("button", { name: "Sign off", exact: true });
  expect(await psaSignOff.isDisabled()).toBe(true);
  await psa.getByText("Needs a date before sign-off").waitFor();

  // Save the date via the per-fact form; the same page should update in place.
  await psa.getByLabel("As-of date (not found in the document)").fill("2026-03-05");
  await psa.getByRole("button", { name: "Save date" }).click();
  await psa.locator("button:enabled", { hasText: /^Sign off$/ }).waitFor();
  expect(await psa.getByText("Needs a date before sign-off").count()).toBe(0);
  expect(patches).toEqual([{ as_of_date: "2026-03-05" }]);
  expect(navigations).toBe(1); // no reload
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);
