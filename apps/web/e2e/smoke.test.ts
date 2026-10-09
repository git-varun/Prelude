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
  await page.getByRole("heading", { name: "Prelude" }).waitFor();
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
    if (msg.type() !== "error") return;
    // The file-availability probe (api.checkDocumentFile) legitimately 404s here -- this
    // fixture has no real file -- and the browser logs that resource failure to console.
    if (msg.location().url === `${API}/documents/doc1/file`) return;
    errors.push(`console: ${msg.text()}`);
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
  expect(await page.getByRole("heading", { name: "Prelude" }).count()).toBeGreaterThan(0);
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
  expect(await page.getByRole("heading", { name: "Prelude" }).count()).toBeGreaterThan(0);
  await page.close();
}, 30_000);

// Sign-off / reopen buttons on the review FactCard. The stub keeps mutable fact
// state so a click's POST flips the card the way the real API would.
type StubFact = {
  verification_state: string;
  has_blocking_conflict?: boolean;
  blocking_conflict_id?: string | null;
  needs_manual_date?: boolean;
  unmapped?: boolean;
};

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
    id: "f1", patient_id: "p1", visit_id: "v1", document_id: "doc1",
    tracked_marker_id: state.unmapped ? null : "m1", tracked_marker_name: state.unmapped ? null : "CEA",
    raw_marker_label: state.unmapped ? "Mystery Marker" : null, field_type: "marker_value", value: "4.2", unit: "ng/mL", reference_range: "0-5",
    as_of_date: state.needs_manual_date ? null : "2026-02-01", needs_manual_date: state.needs_manual_date ?? false,
    coverage_status: "value_found", verification_state: state.verification_state,
    has_blocking_conflict: state.has_blocking_conflict ?? false,
    blocking_conflict_id: state.has_blocking_conflict ? (state.blocking_conflict_id ?? "c1") : null,
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
    if (req.method() === "GET" && path === "/conflicts/c1") {
      return json({
        conflict: { id: "c1", fact_id_a: "f1", fact_id_b: "f9", status: "open", authoritative_fact_id: null, annotation_note: null, resolution_note: null, resolved_by: null, resolved_at: null },
        fact_a: { ...fact(), id: "f1" },
        fact_b: { ...fact(), id: "f9", value: "9.0" },
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });
  const heading = state.unmapped ? "Mystery Marker" : "CEA";
  await page.goto(`${BASE}/#/documents/doc1/review`);
  await page.getByRole("heading", { name: heading }).waitFor();
  const card = page.locator(".card", { has: page.getByRole("heading", { name: heading }) });
  const signOff = card.getByRole("button", { name: "Sign off", exact: true });
  const reopen = card.getByRole("button", { name: "Reopen", exact: true });
  return { page, errors, posts, signOff, reopen, card };
}

test("Extraction Review: the persistent marker disclaimer footer renders verbatim", async () => {
  const { page, errors } = await openReviewAs("staff", { verification_state: "unverified" });
  await page
    .getByText(
      "For clinical information aggregation only. Does not replace professional clinical evaluation or verified laboratory source documents. Tumor marker kinetics must be interpreted alongside histopathological, clinical, and radiological findings.",
    )
    .waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

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

test("oncologist sees a disabled Sign off with the unmapped-marker reason when the fact has no tracked_marker_id", async () => {
  const { page, posts, signOff, card } = await openReviewAs("oncologist", { verification_state: "unverified", unmapped: true });
  expect(await signOff.isDisabled()).toBe(true);
  await card.getByText("A marker must be mapped to a tracked marker before sign-off").waitFor();
  expect(posts).toEqual([]);
  await page.close();
}, 30_000);

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

test("Extraction Review: a conflicted fact shows a 'Conflicting sources — review' badge that links to /conflicts/:id", async () => {
  const { page, errors, card } = await openReviewAs("oncologist", { verification_state: "unverified", has_blocking_conflict: true });
  const badge = card.getByRole("button", { name: "Conflicting sources — review" });
  await badge.waitFor();
  await badge.click();
  await page.waitForURL(`${BASE}/#/conflicts/c1`);
  await page.getByRole("heading", { name: "Conflict" }).waitFor();
  expect(errors).toEqual([]);
  await page.close();
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
  // Primary styling marks the actionable button only; the disabled one keeps the plain style.
  expect(await cea.getByRole("button", { name: "Sign off", exact: true }).getAttribute("class")).toContain("btn--primary");
  const psaSignOff = psa.getByRole("button", { name: "Sign off", exact: true });
  expect(await psaSignOff.isDisabled()).toBe(true);
  expect(await psaSignOff.getAttribute("class")).not.toContain("btn--primary");
  await psa.getByText("Needs a date before sign-off").waitFor();

  // Save the date via the per-fact form; the same page should update in place.
  await psa.getByLabel("As-of date (not found in the document)").fill("2026-03-05");
  await psa.getByRole("button", { name: "Save date" }).click();
  await psa.locator("button:enabled", { hasText: /^Sign off$/ }).waitFor();
  expect(await psaSignOff.getAttribute("class")).toContain("btn--primary");
  expect(await psa.getByText("Needs a date before sign-off").count()).toBe(0);
  expect(patches).toEqual([{ as_of_date: "2026-03-05" }]);
  expect(navigations).toBe(1); // no reload
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

// Patient Snapshot screen. One fixture builder shared across tests, overridden per test
// so each stays focused on the one thing it's checking.
function provenance(overrides: Record<string, unknown> = {}) {
  return {
    document_id: "doc1", source_page: 3, source_location: "line 4", source_snippet: "x",
    fallback_level: "exact", ...overrides,
  };
}

function snapshotField(overrides: Record<string, unknown> = {}) {
  return {
    fact_id: "f1", field_type: "marker_value", tracked_marker_id: "m1", marker_name: "CEA",
    value: "4.2", unit: "ng/mL", reference_range: "0-5", as_of_date: "2026-02-01",
    coverage_status: "value_found", verification_state: "unverified", delta_status: null,
    conflicts: [], provenance: provenance(), ...overrides,
  };
}

function snapshotBody(overrides: Record<string, unknown> = {}) {
  return {
    patient: { id: "p1", name: "Test Patient", cancer_type: "Breast" },
    current_visit: { id: "v2", visit_date: "2026-02-01" },
    previous_visit: { id: "v1", visit_date: "2026-01-01" },
    current_treatment: [],
    tumor_markers: [],
    radiology: [],
    since_last_visit: [],
    ...overrides,
  };
}

async function openSnapshot(
  role: "staff" | "oncologist",
  body: unknown,
  trends: Record<string, unknown> = {},
  extraRoute?: (path: string, method: string) => unknown | undefined,
) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };
  await page.route(`${API}/**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (path === "/auth/me") return json({ id: "u1", name: "Test", email: "t@opd.local", role });
    if (path === "/patients/p1/snapshot") return json(body);
    const trendMatch = path.match(/^\/patients\/p1\/markers\/([^/]+)\/trend$/);
    if (trendMatch) return json(trends[trendMatch[1]!] ?? { marker_name: "", points: [] });
    if (extraRoute) {
      const result = extraRoute(path, req.method());
      if (result !== undefined) return json(result);
    }
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });
  await page.goto(`${BASE}/#/patients/p1/snapshot`);
  await page.getByRole("heading", { name: "Test Patient" }).waitFor();
  return { page, errors };
}

test("Snapshot: 'Since last visit' shows only the changed marker, not the unchanged one, while Tumor markers shows both", async () => {
  const body = snapshotBody({
    tumor_markers: [
      snapshotField({ fact_id: "f1", marker_name: "CEA", value: "9.0", delta_status: "changed" }),
      snapshotField({ fact_id: "f2", marker_name: "PSA", tracked_marker_id: "m2", value: "1.0", delta_status: "unchanged" }),
    ],
    since_last_visit: [snapshotField({ fact_id: "f1", marker_name: "CEA", value: "9.0", delta_status: "changed" })],
  });
  const { page, errors } = await openSnapshot("staff", body);
  const sinceSection = page.locator("section", { has: page.getByRole("heading", { name: "Since last visit" }) });
  const markersSection = page.locator("section", { has: page.getByRole("heading", { name: "Tumor markers" }) });
  // Since Last Visit is a compact delta-summary row (not a full FactCard), so its
  // marker names aren't headings -- just text within the row.
  await sinceSection.getByText("CEA", { exact: true }).waitFor();
  expect(await sinceSection.getByText("PSA", { exact: true }).count()).toBe(0);
  await markersSection.getByRole("heading", { name: "CEA" }).waitFor();
  await markersSection.getByRole("heading", { name: "PSA" }).waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: a not_found_in_document_set marker renders as a placeholder row, not an interactive FactCard", async () => {
  const body = snapshotBody({
    tumor_markers: [
      snapshotField({
        fact_id: null, marker_name: "AFP", tracked_marker_id: "m3", value: null, unit: null, reference_range: null,
        as_of_date: null, coverage_status: "not_found_in_document_set", verification_state: null, conflicts: [], provenance: null,
      }),
    ],
  });
  const { page, errors } = await openSnapshot("oncologist", body);
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "AFP" }) });
  await card.getByText("Not found in this document set").waitFor();
  expect(await card.getByRole("button", { name: "Sign off", exact: true }).count()).toBe(0);
  expect(await card.getByRole("button", { name: "Reopen", exact: true }).count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: an open conflict on a field reaches FactCard through the adapter as a disabled, reason-labeled Sign off button", async () => {
  const body = snapshotBody({
    tumor_markers: [
      snapshotField({
        fact_id: "f1", marker_name: "CEA",
        conflicts: [{ conflict_id: "c1", status: "open", other_fact_id: "f9", other_value: "9.0", other_source: provenance(), authoritative_fact_id: null, historical: false }],
      }),
    ],
  });
  const { page, errors } = await openSnapshot("oncologist", body);
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "CEA" }) });
  const signOff = card.getByRole("button", { name: "Sign off", exact: true });
  await signOff.waitFor();
  expect(await signOff.isDisabled()).toBe(true);
  await card.getByText("Blocked by an unresolved conflict").waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: a conflicted fact shows a 'Conflicting sources — review' badge that links to /conflicts/:id", async () => {
  const body = snapshotBody({
    tumor_markers: [
      snapshotField({
        fact_id: "f1", marker_name: "CEA",
        conflicts: [{ conflict_id: "c1", status: "open", other_fact_id: "f9", other_value: "9.0", other_source: provenance(), authoritative_fact_id: null, historical: false }],
      }),
    ],
  });
  const conflictDetail = {
    conflict: { id: "c1", fact_id_a: "f1", fact_id_b: "f9", status: "open", authoritative_fact_id: null, annotation_note: null, resolution_note: null, resolved_by: null, resolved_at: null },
    fact_a: { id: "f1", patient_id: "p1", visit_id: "v2", document_id: "doc1", tracked_marker_id: "m1", tracked_marker_name: "CEA", field_type: "marker_value", value: "4.2", unit: "ng/mL", reference_range: "0-5", as_of_date: "2026-02-01", coverage_status: "conflicting_sources", verification_state: "unverified", source_page: 3, source_location: "line 4", source_snippet: "x" },
    fact_b: { id: "f9", patient_id: "p1", visit_id: "v2", document_id: "doc1", tracked_marker_id: "m1", tracked_marker_name: "CEA", field_type: "marker_value", value: "9.0", unit: "ng/mL", reference_range: "0-5", as_of_date: "2026-02-01", coverage_status: "conflicting_sources", verification_state: "unverified", source_page: 3, source_location: "line 4", source_snippet: "y" },
  };
  const { page, errors } = await openSnapshot("oncologist", body, {}, (path, method) => {
    if (path === "/conflicts/c1" && method === "GET") return conflictDetail;
    return undefined;
  });
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "CEA" }) });
  const badge = card.getByRole("button", { name: "Conflicting sources — review" });
  await badge.waitFor();
  await badge.click();
  await page.waitForURL(`${BASE}/#/conflicts/c1`);
  await page.getByRole("heading", { name: "Conflict" }).waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: a new patient (previous_visit.id null) omits 'Since last visit' entirely, not as an empty section", async () => {
  const body = snapshotBody({
    previous_visit: { id: null, visit_date: null },
    tumor_markers: [snapshotField({ fact_id: "f1", marker_name: "CEA" })],
  });
  const { page, errors } = await openSnapshot("staff", body);
  await page.getByRole("heading", { name: "Tumor markers" }).waitFor();
  expect(await page.getByRole("heading", { name: "Since last visit" }).count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: a marker value above its reference range shows the muted ochre pill with the prescribed tooltip, not a red/terracotta alert", async () => {
  const body = snapshotBody({
    tumor_markers: [snapshotField({ fact_id: "f1", marker_name: "CEA", value: "9.0", reference_range: "0-5" })],
  });
  const { page, errors } = await openSnapshot("oncologist", body);
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "CEA" }) });
  const pill = card.getByText("Above laboratory reference interval");
  await pill.waitFor();
  expect(await pill.getAttribute("title")).toBe(
    "Value exceeds source laboratory reference range (0-5). Verification against original PDF report required.",
  );
  expect(await card.getByText("Below laboratory reference interval").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: a marker value within its reference range shows no indicator", async () => {
  const body = snapshotBody({
    tumor_markers: [snapshotField({ fact_id: "f1", marker_name: "CEA", value: "3.0", reference_range: "0-5" })],
  });
  const { page, errors } = await openSnapshot("staff", body);
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "CEA" }) });
  await card.getByText("ref 0-5").waitFor();
  expect(await card.getByText("Above laboratory reference interval").count()).toBe(0);
  expect(await card.getByText("Below laboratory reference interval").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: the persistent marker disclaimer footer renders verbatim", async () => {
  const body = snapshotBody({ tumor_markers: [snapshotField({ fact_id: "f1", marker_name: "CEA" })] });
  const { page, errors } = await openSnapshot("staff", body);
  await page
    .getByText(
      "For clinical information aggregation only. Does not replace professional clinical evaluation or verified laboratory source documents. Tumor marker kinetics must be interpreted alongside histopathological, clinical, and radiological findings.",
    )
    .waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: a tumor marker with 2+ signed-off trend points renders a chart", async () => {
  const body = snapshotBody({
    tumor_markers: [snapshotField({ fact_id: "f1", tracked_marker_id: "m1", marker_name: "CEA" })],
  });
  const trends = {
    m1: {
      marker_name: "CEA",
      points: [
        { fact_id: "t1", value: "3.0", unit: "ng/mL", reference_range: "0-5", as_of_date: "2026-01-01", visit_id: "v1" },
        { fact_id: "t2", value: "4.0", unit: "ng/mL", reference_range: "0-5", as_of_date: "2026-02-01", visit_id: "v2" },
      ],
    },
  };
  const { page, errors } = await openSnapshot("staff", body, trends);
  await page.getByRole("heading", { name: "CEA" }).waitFor();
  await page.locator("svg[role='img']").waitFor();
  expect(await page.getByText("Units differ").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: trend points with differing reference ranges render a chart with no band", async () => {
  const body = snapshotBody({
    tumor_markers: [snapshotField({ fact_id: "f1", tracked_marker_id: "m1", marker_name: "CEA" })],
  });
  const trends = {
    m1: {
      marker_name: "CEA",
      points: [
        { fact_id: "t1", value: "3.0", unit: "ng/mL", reference_range: "0-5", as_of_date: "2026-01-01", visit_id: "v1" },
        { fact_id: "t2", value: "4.0", unit: "ng/mL", reference_range: "0-6", as_of_date: "2026-02-01", visit_id: "v2" },
      ],
    },
  };
  const { page, errors } = await openSnapshot("staff", body, trends);
  await page.getByRole("heading", { name: "CEA" }).waitFor();
  const svg = page.locator("svg[role='img']");
  await svg.waitFor();
  expect(await svg.locator("rect").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: fewer than 2 trend points renders no chart", async () => {
  const body = snapshotBody({
    tumor_markers: [snapshotField({ fact_id: "f1", tracked_marker_id: "m1", marker_name: "CEA" })],
  });
  const trends = {
    m1: { marker_name: "CEA", points: [{ fact_id: "t1", value: "3.0", unit: "ng/mL", reference_range: "0-5", as_of_date: "2026-01-01", visit_id: "v1" }] },
  };
  const { page, errors } = await openSnapshot("staff", body, trends);
  await page.getByRole("heading", { name: "CEA" }).waitFor();
  await page.waitForTimeout(300); // let the trend fetch settle before asserting absence
  expect(await page.locator("svg[role='img']").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: mixed-unit trend points show a 'units differ' note instead of a chart", async () => {
  const body = snapshotBody({
    tumor_markers: [snapshotField({ fact_id: "f1", tracked_marker_id: "m1", marker_name: "CEA" })],
  });
  const trends = {
    m1: {
      marker_name: "CEA",
      points: [
        { fact_id: "t1", value: "3.0", unit: "ng/mL", reference_range: "0-5", as_of_date: "2026-01-01", visit_id: "v1" },
        { fact_id: "t2", value: "4.0", unit: "µg/L", reference_range: "0-5", as_of_date: "2026-02-01", visit_id: "v2" },
      ],
    },
  };
  const { page, errors } = await openSnapshot("staff", body, trends);
  await page.getByText("Units differ across these values").waitFor();
  expect(await page.locator("svg[role='img']").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: Thyroglobulin always renders adjacent to Anti-Tg, even when the API returns them apart", async () => {
  const body = snapshotBody({
    tumor_markers: [
      snapshotField({ fact_id: "f1", marker_name: "Anti-Tg (TgAb)" }),
      snapshotField({ fact_id: "f2", marker_name: "CEA" }),
      snapshotField({ fact_id: "f3", marker_name: "Thyroglobulin (Tg)" }),
      snapshotField({ fact_id: "f4", marker_name: "Calcitonin" }),
    ],
  });
  const { page, errors } = await openSnapshot("staff", body);
  const markersSection = page.locator("section", { has: page.getByRole("heading", { name: "Tumor markers" }) });
  const headings = await markersSection.getByRole("heading", { level: 2 }).allTextContents();
  const tgIndex = headings.indexOf("Thyroglobulin (Tg)");
  expect(tgIndex).toBeGreaterThan(-1);
  expect(headings[tgIndex + 1]).toBe("Anti-Tg (TgAb)");
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

// --- Conflict Resolution screen: annotate / resolve flows, driven from the Snapshot ---

function conflictFact(overrides: Record<string, unknown> = {}) {
  return {
    id: "f1", patient_id: "p1", visit_id: "v2", document_id: "doc1", tracked_marker_id: null,
    tracked_marker_name: null, field_type: "treatment_regimen", value: "FOLFOX", unit: null,
    reference_range: null, as_of_date: "2026-02-01", coverage_status: "conflicting_sources",
    verification_state: "unverified", source_page: 1, source_location: null, source_snippet: "FOLFOX regimen",
    ...overrides,
  };
}

type ConflictScenarioState = {
  status: "open" | "annotated" | "resolved";
  authoritativeFactId: string | null;
  annotationNote: string | null;
  resolutionNote: string | null;
};

async function openConflictScenario(
  role: "staff" | "oncologist",
  initial: Partial<ConflictScenarioState>,
  startAt: "snapshot" | "conflict",
) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  const state: ConflictScenarioState = { status: "open", authoritativeFactId: null, annotationNote: null, resolutionNote: null, ...initial };
  const posts: { path: string; body: unknown }[] = [];
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };

  function coverageFor(factId: "f1" | "f9"): string {
    if (state.status !== "resolved") return "conflicting_sources";
    if (state.authoritativeFactId === null) return "value_found"; // both_stand
    return state.authoritativeFactId === factId ? "value_found" : "conflicting_sources";
  }
  const factA = () => conflictFact({ id: "f1", value: "FOLFOX", coverage_status: coverageFor("f1") });
  const factB = () => conflictFact({ id: "f9", value: "FOLFIRI", coverage_status: coverageFor("f9") });

  function conflictRecord() {
    return {
      id: "c1", fact_id_a: "f1", fact_id_b: "f9", status: state.status,
      authoritative_fact_id: state.authoritativeFactId, annotation_note: state.annotationNote,
      resolution_note: state.resolutionNote, resolved_by: state.status === "resolved" ? "onc1" : null,
      resolved_at: state.status === "resolved" ? "2026-02-02T00:00:00Z" : null,
    };
  }

  function treatmentField(fact: ReturnType<typeof factA>) {
    return {
      fact_id: fact.id, field_type: fact.field_type, tracked_marker_id: null, marker_name: null,
      value: fact.value, unit: fact.unit, reference_range: fact.reference_range, as_of_date: fact.as_of_date,
      coverage_status: fact.coverage_status, verification_state: fact.verification_state, delta_status: null,
      conflicts: [{
        conflict_id: "c1", status: state.status, other_fact_id: fact.id === "f1" ? "f9" : "f1",
        other_value: fact.id === "f1" ? "FOLFIRI" : "FOLFOX", other_source: provenance(),
        authoritative_fact_id: state.authoritativeFactId, historical: state.status === "resolved" && state.authoritativeFactId !== null,
      }],
      provenance: provenance({ document_id: "doc1" }),
    };
  }

  // Mirrors the real loadCurrentTreatment query: a live, non-blocked fact loses its conflict
  // pairing's loser entirely once resolved with a winner; a tie (both_stand) keeps both.
  function currentTreatment() {
    if (state.status !== "resolved" || state.authoritativeFactId === null) {
      return [treatmentField(factA()), treatmentField(factB())];
    }
    return [treatmentField(state.authoritativeFactId === "f1" ? factA() : factB())];
  }

  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (path === "/auth/me") return json({ id: role === "oncologist" ? "onc1" : "staff1", name: "Test", email: "t@opd.local", role });
    if (path === "/patients/p1/snapshot") return json(snapshotBody({ current_treatment: currentTreatment() }));
    if (path === "/conflicts/c1" && req.method() === "GET") return json({ conflict: conflictRecord(), fact_a: factA(), fact_b: factB() });
    if (path === "/conflicts/c1/annotate" && req.method() === "POST") {
      const body = req.postDataJSON() as { annotation_note: string };
      posts.push({ path, body });
      state.status = "annotated";
      state.annotationNote = body.annotation_note;
      return json(conflictRecord());
    }
    if (path === "/conflicts/c1/resolve" && req.method() === "POST") {
      const body = req.postDataJSON() as { authoritative_fact_id?: string; both_stand?: true };
      posts.push({ path, body });
      state.status = "resolved";
      state.authoritativeFactId = "authoritative_fact_id" in body ? (body.authoritative_fact_id ?? null) : null;
      state.resolutionNote = state.authoritativeFactId
        ? `Fact ${state.authoritativeFactId} marked authoritative.`
        : "Both values stand as independently valid.";
      return json(conflictRecord());
    }
    if (path === "/facts/f1/sign-off" && req.method() === "POST") {
      posts.push({ path, body: null });
      return json({ ...factA(), has_blocking_conflict: false, blocking_conflict_id: null, verification_state: "oncologist_signed_off" });
    }
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });

  if (startAt === "snapshot") {
    await page.goto(`${BASE}/#/patients/p1/snapshot`);
    await page.getByRole("heading", { name: "Test Patient" }).waitFor();
  } else {
    await page.goto(`${BASE}/#/conflicts/c1`);
    await page.getByRole("heading", { name: "Conflict" }).waitFor();
  }
  return { page, errors, posts };
}

test("ConflictResolution: staff can annotate, and sees no resolve controls", async () => {
  const { page, errors, posts } = await openConflictScenario("staff", {}, "conflict");
  expect(await page.getByRole("button", { name: "Mark Fact A authoritative" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Mark Fact B authoritative" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Both values stand" }).count()).toBe(0);

  await page.getByLabel("What did you find?").fill("Confirmed with the referring clinic.");
  await page.getByRole("button", { name: "Save annotation" }).click();
  await page.getByText("annotated").first().waitFor();

  expect(posts).toEqual([{ path: "/conflicts/c1/annotate", body: { annotation_note: "Confirmed with the referring clinic." } }]);
  expect(await page.getByRole("button", { name: "Mark Fact A authoritative" }).count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("ConflictResolution: oncologist authoritative-pick — the loser disappears from the Snapshot after navigating back, and the winner's Sign off becomes active", async () => {
  const { page, errors, posts } = await openConflictScenario("oncologist", {}, "snapshot");
  await page.getByText("FOLFOX").first().waitFor();
  await page.getByText("FOLFIRI").first().waitFor();

  await page.getByRole("button", { name: "Conflicting sources — review" }).first().click();
  await page.getByRole("heading", { name: "Conflict" }).waitFor();
  await page.getByRole("button", { name: "Mark Fact A authoritative" }).click();
  await page.getByText("resolved").first().waitFor();
  expect(posts).toEqual([{ path: "/conflicts/c1/resolve", body: { authoritative_fact_id: "f1" } }]);

  await page.getByRole("button", { name: "Back to snapshot" }).click();
  await page.getByRole("heading", { name: "Test Patient" }).waitFor();
  await page.getByText("FOLFOX").first().waitFor();
  expect(await page.getByText("FOLFIRI").count()).toBe(0);

  const signOff = page.getByRole("button", { name: "Sign off", exact: true });
  await signOff.waitFor();
  expect(await signOff.isEnabled()).toBe(true);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("ConflictResolution: oncologist both-stand — both facts remain, and neither shows 'Conflicting sources' any more", async () => {
  const { page, errors, posts } = await openConflictScenario("oncologist", {}, "snapshot");
  await page.getByRole("button", { name: "Conflicting sources — review" }).first().click();
  await page.getByRole("heading", { name: "Conflict" }).waitFor();
  await page.getByRole("button", { name: "Both values stand" }).click();
  await page.getByText("resolved").first().waitFor();
  expect(posts).toEqual([{ path: "/conflicts/c1/resolve", body: { both_stand: true } }]);

  await page.getByRole("button", { name: "Back to snapshot" }).click();
  await page.getByRole("heading", { name: "Test Patient" }).waitFor();
  await page.getByText("FOLFOX").first().waitFor();
  await page.getByText("FOLFIRI").first().waitFor();
  expect(await page.getByRole("button", { name: "Conflicting sources — review" }).count()).toBe(0);
  expect(await page.getByText("Conflicting values, see sources").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("ConflictResolution: a resolved conflict renders read-only (no annotation box, no resolve controls)", async () => {
  const { page, errors } = await openConflictScenario(
    "oncologist",
    { status: "resolved", authoritativeFactId: "f1", resolutionNote: "Fact f1 marked authoritative." },
    "conflict",
  );
  await page.getByText("Fact f1 marked authoritative.").waitFor();
  expect(await page.getByRole("button", { name: "Save annotation" }).count()).toBe(0);
  expect(await page.getByLabel("What did you find?").count()).toBe(0);
  expect(await page.getByRole("button", { name: "Mark Fact A authoritative" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Both values stand" }).count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Patient create: selecting a disease site pre-checks the union of its marker panel(s)", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };
  await page.route(`${API}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (path === "/auth/me") return json({ id: "u1", name: "Test Staff", email: "s@opd.local", role: "staff" });
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });

  await page.goto(`${BASE}/#/patients/new`);
  await page.getByRole("heading", { name: "New patient" }).waitFor();

  // Fallback set is pre-checked with no site selected.
  await page.getByRole("checkbox", { name: "CEA" }).waitFor();
  expect(await page.getByRole("checkbox", { name: "CEA" }).isChecked()).toBe(true);
  expect(await page.getByRole("checkbox", { name: "CA 15-3" }).isChecked()).toBe(true);
  expect(await page.getByRole("checkbox", { name: "HE4" }).isChecked()).toBe(false);

  // Selecting Gynecologic replaces the fallback set with exactly that site's panel.
  await page.getByRole("checkbox", { name: "Gynecologic" }).click();
  expect(await page.getByRole("checkbox", { name: "HE4" }).isChecked()).toBe(true);
  expect(await page.getByRole("checkbox", { name: "CA-125" }).isChecked()).toBe(true);
  expect(await page.getByRole("checkbox", { name: "CEA" }).isChecked()).toBe(true);
  expect(await page.getByRole("checkbox", { name: "CA 15-3" }).isChecked()).toBe(false);

  // Also selecting Breast unions in its panel on top of Gynecologic's.
  await page.getByRole("checkbox", { name: "Breast" }).click();
  expect(await page.getByRole("checkbox", { name: "CA 15-3" }).isChecked()).toBe(true);
  expect(await page.getByRole("checkbox", { name: "CA-125" }).isChecked()).toBe(true);

  // A manual uncheck survives further site toggles.
  await page.getByRole("checkbox", { name: "CA-125" }).uncheck();
  await page.getByRole("checkbox", { name: "Urologic" }).click();
  expect(await page.getByRole("checkbox", { name: "CA-125" }).isChecked()).toBe(false);

  // Clearing every site brings the fallback set back (except the manual uncheck above).
  await page.getByRole("checkbox", { name: "Gynecologic" }).click();
  await page.getByRole("checkbox", { name: "Breast" }).click();
  await page.getByRole("checkbox", { name: "Urologic" }).click();
  expect(await page.getByRole("checkbox", { name: "CEA" }).isChecked()).toBe(true);
  expect(await page.getByRole("checkbox", { name: "CA 15-3" }).isChecked()).toBe(true);
  expect(await page.getByRole("checkbox", { name: "CA-125" }).isChecked()).toBe(false);
  expect(await page.getByRole("checkbox", { name: "HE4" }).isChecked()).toBe(false);

  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Marker Management: lists tracked markers and adds one from the controlled list without a reload", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };
  let markers = [{ id: "m1", marker_name: "CEA", is_custom: false, added_at: "2026-01-01", added_by: "u1" }];
  await page.route(`${API}/**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (path === "/auth/me") return json({ id: "u1", name: "Test Staff", email: "s@opd.local", role: "staff" });
    if (path === "/patients/p1" && req.method() === "GET") {
      return json({ id: "p1", name: "Test Patient", cancer_type: "Breast", created_at: "2026-01-01", created_by: "u1", tracked_markers: markers });
    }
    if (path === "/patients/p1/markers" && req.method() === "POST") {
      const body = JSON.parse(req.postData() ?? "{}");
      const row = { id: "m2", marker_name: body.marker_name, is_custom: false, added_at: "2026-02-01", added_by: "u1" };
      markers = [...markers, row];
      return json(row, 201);
    }
    return json({}, 404);
  });

  await page.goto(`${BASE}/#/patients/p1/markers`);
  await page.getByRole("heading", { name: "Tracked markers — Test Patient" }).waitFor();
  await page.getByText("CEA", { exact: true }).waitFor();

  await page.getByLabel("From the controlled list").selectOption("CA 19-9");
  await page.getByRole("button", { name: "Add" }).first().click();
  await page.getByText("CA 19-9", { exact: true }).waitFor();

  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: the view-uploaded-document link appears regardless of provenance.fallback_level", async () => {
  const body = snapshotBody({
    tumor_markers: [
      snapshotField({ fact_id: "f1", marker_name: "CEA", provenance: provenance({ fallback_level: "exact", source_page: 3, source_location: "line 4" }) }),
      snapshotField({ fact_id: "f2", marker_name: "PSA", tracked_marker_id: "m2", provenance: provenance({ fallback_level: "page", source_page: 5, source_location: null }) }),
    ],
    current_treatment: [
      snapshotField({ fact_id: "f3", field_type: "treatment_regimen", marker_name: null, tracked_marker_id: null, provenance: provenance({ fallback_level: "document", source_page: null, source_location: null }) }),
    ],
  });
  const { page, errors } = await openSnapshot("staff", body);
  expect(await page.getByRole("button", { name: "View uploaded document" }).count()).toBe(3);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

// Source view. Shares this file's single browser/server (a second full harness per test
// file overwhelms the sandbox's resource limits — see docs/M6 notes on the Source view build).
function sourceDocumentRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc1", patient_id: "p1", visit_id: "v1", file_ref: "local://p1/scan.pdf", document_type: "radiology",
    source_origin: "own_hospital", uploaded_by: "u1", uploaded_at: "2026-01-01T00:00:00Z",
    ocr_status: "done", ocr_text_ref: "local://p1/ocr/doc1.json", needs_manual_date: false,
    extraction_status: "done", extraction_error: null,
    ...overrides,
  };
}

function sourceFact(overrides: Record<string, unknown> = {}) {
  const base = {
    id: "f1", patient_id: "p1", visit_id: "v1", document_id: "doc1", tracked_marker_id: null,
    tracked_marker_name: null, raw_marker_label: null, field_type: "radiology_impression",
    value: "Stable disease, no new lesions.", unit: null, reference_range: null, as_of_date: "2026-02-01",
    needs_manual_date: false, coverage_status: "value_found", verification_state: "unverified",
    has_blocking_conflict: false, source_page: null as number | null, source_location: null, source_snippet: null as string | null,
    ...overrides,
  };
  // Mirrors the real provenanceFor rule (apps/api/src/services/provenance.ts), rather than
  // hardcoding fallback_level per test, so overriding source_page/source_snippet alone is enough.
  const fallback_level = base.source_page != null && base.source_snippet != null ? "exact" : base.source_page != null ? "page" : "document";
  return { ...base, fallback_level };
}

const SOURCE_OCR = {
  fullText: "Page one text.\n\nFindings: no change. Impression: Stable disease, no new lesions.",
  pages: [
    { pageNumber: 1, text: "Page one text." },
    { pageNumber: 2, text: "Findings: no change. Impression: Stable disease, no new lesions." },
  ],
};

interface SourceScenario {
  document?: Record<string, unknown>;
  fact: Record<string, unknown>;
  fileStatus: number;
  fileContentType?: string;
}

async function openSource({ document = {}, fact: factOverrides, fileStatus, fileContentType }: SourceScenario) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // The file-availability probe (api.checkDocumentFile) legitimately 404s in the
    // fallback-triggering scenarios; the browser logs that resource failure to console.
    if (msg.location().url === `${API}/documents/doc1/file`) return;
    errors.push(`console: ${msg.text()}`);
  });
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };

  await page.route(`${API}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (path === "/auth/me") return json({ id: "u1", name: "Test Staff", email: "s@opd.local", role: "staff" });
    if (path === "/documents/doc1") return json({ document: sourceDocumentRecord(document), ocr: SOURCE_OCR });
    if (path === "/documents/doc1/facts") {
      return json({ document: sourceDocumentRecord(document), facts: [sourceFact(factOverrides)], tracked_markers: [] });
    }
    if (path === "/documents/doc1/file") {
      return route.fulfill({
        status: fileStatus,
        headers: { ...cors, ...(fileContentType ? { "Content-Type": fileContentType } : {}) },
        body: fileStatus === 200 ? "stub-file-bytes" : JSON.stringify({ error: "not_found", message: "no file" }),
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });

  await page.goto(`${BASE}/#/documents/doc1/source?fact=f1`);
  await page.getByRole("heading", { name: "Source document" }).waitFor();
  return { page, errors };
}

test("Source view, exact fallback_level: renders the original document and highlights the first text match of source_snippet", async () => {
  const { page, errors } = await openSource({
    fact: { source_page: 2, source_snippet: "Stable disease, no new lesions." },
    fileStatus: 200,
    fileContentType: "application/pdf",
  });

  const pdf = page.getByTestId("source-file-pdf");
  await pdf.waitFor();
  expect(await pdf.getAttribute("src")).toContain("#page=2");

  await page.getByRole("heading", { name: "Extracted text" }).waitFor();
  const mark = page.getByTestId("source-highlight");
  await mark.waitFor();
  expect(await mark.textContent()).toBe("Stable disease, no new lesions.");

  expect(await page.getByText("Source detail unavailable").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Source view, page fallback_level: jumps to the correct page, no highlight, with a note that exact location isn't available", async () => {
  const { page, errors } = await openSource({
    fact: { source_page: 2, source_snippet: null },
    fileStatus: 200,
    fileContentType: "application/pdf",
  });

  const pdf = page.getByTestId("source-file-pdf");
  await pdf.waitFor();
  expect(await pdf.getAttribute("src")).toContain("#page=2");

  await page.getByText("Exact location isn't available for this fact — showing page 2.").waitFor();
  expect(await page.getByTestId("source-highlight").count()).toBe(0);
  expect(await page.getByRole("heading", { name: "Extracted text" }).count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Source view, document fallback_level: renders the whole document, no page jump or highlight, 'source detail unavailable' shown", async () => {
  const { page, errors } = await openSource({
    fact: { source_page: null, source_snippet: null },
    fileStatus: 200,
    fileContentType: "application/pdf",
  });

  const pdf = page.getByTestId("source-file-pdf");
  await pdf.waitFor();
  const src = await pdf.getAttribute("src");
  expect(src).not.toContain("#page=");

  await page.getByText("Source detail unavailable").waitFor();
  expect(await page.getByTestId("source-highlight").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Source view: the OCR-text-only fallback triggers when the original file can't be rendered, still highlighting the snippet for an exact fact", async () => {
  const { page, errors } = await openSource({
    fact: { source_page: 2, source_snippet: "Stable disease, no new lesions." },
    fileStatus: 404,
  });

  await page.getByText("The original document couldn't be rendered. Showing extracted text instead.").waitFor();
  expect(await page.getByTestId("source-file-pdf").count()).toBe(0);
  expect(await page.getByTestId("source-file-image").count()).toBe(0);

  const mark = page.getByTestId("source-highlight");
  await mark.waitFor();
  expect(await mark.textContent()).toBe("Stable disease, no new lesions.");
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Source view: the OCR-text-only fallback shows plain text with no highlight when the fact has no source_snippet", async () => {
  const { page, errors } = await openSource({
    fact: { source_page: null, source_snippet: null },
    fileStatus: 404,
  });

  await page.getByText("The original document couldn't be rendered. Showing extracted text instead.").waitFor();
  expect(await page.getByTestId("source-highlight").count()).toBe(0);
  await page.getByText("Page one text.").waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Upload: the imaging modality select appears only when document type is radiology", async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(`console: ${msg.text()}`); });

  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };
  let uploadedBody = "";
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (path === "/auth/me") return json({ id: "u1", name: "Test Staff", email: "s@opd.local", role: "staff" });
    if (path === "/patients/p1" && req.method() === "GET") {
      return json({
        id: "p1", name: "Jane Doe", cancer_type: "Breast", created_at: "2026-01-01T00:00:00Z", created_by: "u1",
        mrn: null, patient_origin: "own_hospital", date_of_birth: null, stage: null, last_visit_date: null,
        needs_attention_count: 0, sex: null, diagnosis_date: null, referring_physician: null, tracked_markers: [],
      });
    }
    if (path === "/patients/p1/visits" && req.method() === "POST") {
      return json({ id: "v1", patient_id: "p1", visit_date: "2026-01-01" });
    }
    if (path === "/patients/p1/documents" && req.method() === "POST") {
      // Playwright's Request has no multipart() reader; the raw body still contains the
      // field name/value pairs as plain text, which is enough to assert the browser sent them.
      uploadedBody = (req.postData() ?? "").toString();
      return json({
        id: "doc1", patient_id: "p1", visit_id: "v1", file_ref: "local://p1/scan.pdf", document_type: "radiology",
        imaging_modality: "pet_ct", source_origin: "own_hospital", uploaded_by: "u1",
        uploaded_at: "2026-01-01T00:00:00Z", ocr_status: "pending", ocr_text_ref: null, needs_manual_date: false,
        extraction_status: "pending", extraction_error: null,
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });

  await page.goto(`${BASE}/#/patients/p1/upload`);
  await page.getByRole("heading", { name: "Jane Doe" }).waitFor();

  expect(await page.getByLabel("Imaging modality").count()).toBe(0);

  await page.getByLabel("Document type").selectOption("radiology");
  await page.getByLabel("Imaging modality").waitFor();

  await page.getByLabel("Document type").selectOption("blood");
  expect(await page.getByLabel("Imaging modality").count()).toBe(0);

  await page.getByLabel("Document type").selectOption("radiology");
  await page.getByLabel("Imaging modality").selectOption("pet_ct");
  await page.setInputFiles("#file", { name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from("x") });
  await page.getByRole("button", { name: "Upload" }).click();
  await page.getByText("OCR: pending").waitFor();
  expect(uploadedBody).toContain('name="imaging_modality"');
  expect(uploadedBody).toContain("pet_ct");

  expect(errors).toEqual([]);
  await page.close();
}, 30_000);
