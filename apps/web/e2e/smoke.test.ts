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

// Spot-check fields every fact carries; a stub overrides check_state when it exercises the check flow.
const CHECKED = {
  check_state: "correct", checked_by: null, checked_at: null, error_type: null,
  excluded_at: null, printed_flag: null, parse_checks: null,
};
const checkSummaryFor = (facts: { check_state: string }[]) => ({
  total: facts.length,
  correct: facts.filter((f) => f.check_state === "correct").length,
  incorrect: facts.filter((f) => f.check_state === "incorrect").length,
  unchecked: facts.filter((f) => f.check_state === "unchecked").length,
});

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
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  shimShellRequests(browser);
}, 30_000);

// M3-11: every patient screen now sits in the patient shell, which also reads GET /patients/:id and
// GET /patients/:id/documents. The default answer below is registered first, i.e. at the LOWEST priority (Playwright
// tries the last-registered route first), so it is used only when no test route handled the request. Older fixtures
// end their catch-all `/**` handler with a 404 for "paths I did not stub"; on exactly these two GET paths that 404
// means "not stubbed" and falls through to the default. A test that deliberately fails them registers the exact URL
// (not a `/**` catch-all) and gets its 404/500 untouched.
const SHELL_PATIENT = {
  id: "p1", name: "Test Patient", cancer_type: "Breast", sex: "female", date_of_birth: "1970-01-01", mrn: null,
  diagnosis_text: "Invasive ductal carcinoma", regimen_text: null, tracked_markers: [],
};
const SHELL_DOCUMENTS = [
  { id: "doc1", document_type: "blood", source_origin: "own_hospital", lab_name: "Metro Labs", identity_status: null, extraction_status: "done",
    uploaded_at: "2026-02-01T10:00:00Z", has_text: true, collected_on: "2026-02-01", reported_on: null, outside_facility: null },
];
const SHELL_CORS = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };
const SHELL_PATH = /^\/patients\/[^/]+(\/documents)?$/;
function shimShellRequests(b: Browser) {
  const newPage = b.newPage.bind(b);
  b.newPage = (async (...args: Parameters<Browser["newPage"]>) => {
    const page = await newPage(...args);
    const route = page.route.bind(page);
    await route(`${API}/patients/**`, (r) => {
      const path = new URL(r.request().url()).pathname;
      if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: { ...SHELL_CORS, "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" } });
      if (r.request().method() !== "GET" || !SHELL_PATH.test(path)) return r.fallback();
      return r.fulfill({
        status: 200, contentType: "application/json", headers: SHELL_CORS,
        body: JSON.stringify(path.endsWith("/documents") ? { documents: SHELL_DOCUMENTS } : SHELL_PATIENT),
      });
    });
    page.route = ((url: Parameters<typeof route>[0], handler: (r: any, q: any) => unknown, opts?: any) =>
      route(url, (r, q) => {
        const catchAll = typeof url === "string" && url.endsWith("**");
        const shell = catchAll && q.method() === "GET" && SHELL_PATH.test(new URL(q.url()).pathname);
        const wrapped = new Proxy(r, {
          get(target, prop) {
            if (prop === "fulfill" && shell) {
              return (o: { status?: number }) => (o.status === 404 ? target.fallback() : target.fulfill(o as any));
            }
            const v = (target as any)[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
        return handler(wrapped, q);
      }, opts)) as typeof page.route;
    return page;
  }) as Browser["newPage"];
}

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
        check_summary: checkSummaryFor([]),
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
  check_state?: string;
  error_type?: string | null;
  printed_flag?: string | null;
  parse_checks?: { failed?: string[] } | null;
  f2_check?: string;
  check_delay?: number;
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
  const checkBodies: any[] = [];
  const checkedIds: string[] = [];
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
    ...CHECKED, check_state: state.check_state ?? "correct", error_type: state.error_type ?? null,
    excluded_at: state.error_type === "not_in_document" ? "2026-02-02T00:00:00Z" : null,
    printed_flag: state.printed_flag ?? null, parse_checks: state.parse_checks ?? null,
  });
  const reviewFacts = () =>
    state.needs_manual_date
      ? [fact(), { ...fact(), id: "f2", tracked_marker_name: "PSA", needs_manual_date: false, as_of_date: "2026-02-01", verification_state: "unverified", has_blocking_conflict: false, check_state: state.f2_check ?? "unchecked", error_type: null, excluded_at: null }]
      : [fact()];
  await page.route(`${API}/**`, async (route) => {
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
        facts: reviewFacts(),
        tracked_markers: [{ id: "m1", marker_name: "CEA", is_custom: false, added_at: "2026-01-01", added_by: "u1" }, { id: "m2", marker_name: "PSA", is_custom: false, added_at: "2026-01-01", added_by: "u1" }],
        check_summary: checkSummaryFor(reviewFacts()),
      });
    }
    if (req.method() === "POST" && path === "/facts/f1/sign-off") {
      posts.push(path);
      state.verification_state = "oncologist_signed_off";
      return json(fact());
    }
    if (req.method() === "POST" && path === "/facts/f2/check") {
      checkedIds.push("f2");
      state.f2_check = JSON.parse(req.postData() ?? "{}").result;
      return json({ ...fact(), id: "f2", check_state: state.f2_check });
    }
    if (req.method() === "POST" && path === "/facts/f1/check") {
      const body = JSON.parse(req.postData() ?? "{}");
      checkBodies.push(body);
      checkedIds.push("f1");
      if (state.check_delay) await Bun.sleep(state.check_delay);
      state.check_state = body.result;
      state.error_type = body.error_type ?? null;
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
  return { page, errors, posts, checkBodies, checkedIds, signOff, reopen, card };
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
    has_blocking_conflict: false, source_page: 1, source_location: null, source_snippet: "x", ...CHECKED,
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
        check_summary: checkSummaryFor([f1, f2]),
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

// The Snapshot's summary strip fetches /summary; stub it so scenarios don't log a 404.
const EMPTY_SUMMARY = {
  patient: { id: "p1", name: "Test" }, documents_count: 0, what_happened: [],
  disease_history: { diagnosis: [], histology_ihc: [], stage: [] }, procedures: [], prescriptions: [],
};

// The Snapshot's prep panel asks for /visits/:id/prep; every Snapshot stub answers it (all four checks met by default).
const PREP_ITEMS = [
  { key: "uploaded", label: "Reports uploaded", ok: true, count: 1, reason: null },
  { key: "facts_checked", label: "All facts checked", ok: true, count: 0, reason: null },
  { key: "dates_entered", label: "Dates entered", ok: true, count: 0, reason: null },
  { key: "held_reviewed", label: "Held reports reviewed", ok: true, count: 0, reason: null },
];
const prepBody = (o: Record<string, unknown> = {}) => ({
  visit_id: "v2", visit_date: "2026-02-01", prep_status: "preparing", prep_set_by: null, prep_set_by_name: null, prep_set_at: null,
  items: PREP_ITEMS, can_mark_ready: true, changed_since_ready: [], ...o,
});
const isPrepPath = (path: string) => /^\/visits\/[^/]+\/prep$/.test(path);

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
    coverage_status: "value_found", verification_state: "unverified", check_state: "correct", delta_status: "changed",
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
    watchlist: [],
    suggested_pins: [],
    pin_options: [],
    compare: { mode: "here", last_here: { date: "2026-01-01" }, latest_any: null },
    ...overrides,
  };
}

async function openSnapshot(
  role: "staff" | "oncologist",
  body: unknown,
  trends: Record<string, unknown> = {},
  extraRoute?: (path: string, method: string) => unknown | undefined,
  summaryBody: unknown = EMPTY_SUMMARY,
  planBody: unknown = { next_review: null, items: [] },
  features?: { dictation: boolean },
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
    if (req.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { ...cors, "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" } });
    }
    if (path === "/auth/me") return json({ id: "u1", name: "Test", email: "t@opd.local", role, ...(features ? { features } : {}) });
    if (isPrepPath(path)) {
      const custom = extraRoute?.(path, req.method());
      return json(custom !== undefined ? custom : prepBody());
    }
    if (path === "/patients/p1/snapshot") {
      // A function body lets a test answer per ?compare=.
      return json(typeof body === "function" ? body(new URL(req.url()).searchParams.get("compare")) : body);
    }
    if (path === "/patients/p1/summary") return json(summaryBody);
    if (path === "/patients/p1/plan" && planBody !== undefined) return json(planBody);
    const trendMatch = path.match(/^\/patients\/p1\/markers\/([^/]+)\/trend$/);
    if (trendMatch) return json(trends[trendMatch[1]!] ?? { marker_name: "", points: [] });
    if (extraRoute) {
      const result = extraRoute(path, req.method());
      if (result !== undefined) return json(result);
    }
    // Snapshot also asks for the held-document list (banner); nothing is held by default.
    if (path === "/patients/p1/documents/identity") return json({ patient_name: "Test Patient", documents: [] });
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });
  await page.goto(`${BASE}/#/patients/p1/snapshot`);
  await page.getByRole("heading", { name: "Test Patient" }).waitFor();
  return { page, errors };
}

// Unchanged items are folded under "Unchanged since last signed-off value · N"; open the fold to reach them.
async function openFold(page: import("playwright").Page) {
  await page.getByRole("button", { name: /Unchanged since last signed-off value/ }).click();
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
  const markersSection = page.locator("section", { has: page.getByRole("heading", { name: /For this visit/ }) });
  await openFold(page);
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
  await openFold(page);
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
  await page.getByRole("heading", { name: /For this visit/ }).waitFor();
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

test("Snapshot: Thyroglobulin renders adjacent to Anti-Tg within a group (here the folded one), even when the API returns them apart", async () => {
  const body = snapshotBody({
    tumor_markers: [
      snapshotField({ fact_id: "f1", marker_name: "Anti-Tg (TgAb)", delta_status: "unchanged" }),
      snapshotField({ fact_id: "f2", marker_name: "CEA", delta_status: "unchanged" }),
      snapshotField({ fact_id: "f3", marker_name: "Thyroglobulin (Tg)", delta_status: "unchanged" }),
      snapshotField({ fact_id: "f4", marker_name: "Calcitonin", delta_status: "unchanged" }),
    ],
  });
  const { page, errors } = await openSnapshot("staff", body);
  const markersSection = page.locator("section", { has: page.getByRole("heading", { name: /For this visit/ }) });
  await openFold(page);
  await markersSection.getByRole("heading", { name: "CEA" }).waitFor();
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
      coverage_status: fact.coverage_status, verification_state: fact.verification_state, check_state: "correct", delta_status: null,
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
    if (isPrepPath(path)) return json(prepBody());
    if (path === "/patients/p1/snapshot") return json(snapshotBody({ current_treatment: currentTreatment() }));
    if (path === "/patients/p1/summary") return json(EMPTY_SUMMARY);
    if (path === "/patients/p1/plan") return json({ next_review: null, items: [] });
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
    if (path === "/patients/p1/documents/identity") return json({ patient_name: "Test Patient", documents: [] });
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

test("Snapshot -> Timeline: navigates via the new button, renders the chart/legend/tick rows, and a tick click lands on Source view for the right fact", async () => {
  const timelineBody = {
    patient: { id: "p1", name: "Test Patient", cancer_type: "Breast" },
    markers: [
      {
        tracked_marker_id: "m1",
        marker_name: "CEA",
        points: [
          { fact_id: "f1", value: "3.0", unit: "ng/mL", as_of_date: "2026-01-01", visit_id: "v1", document_id: "doc1", source_page: null, source_location: null, source_snippet: null, fallback_level: "document" },
          { fact_id: "f2", value: "9.0", unit: "ng/mL", as_of_date: "2026-02-01", visit_id: "v2", document_id: "doc1", source_page: null, source_location: null, source_snippet: null, fallback_level: "document" },
        ],
      },
    ],
    treatment: [],
    radiology: [
      {
        fact_id: "rf1", value: "no new lesions", as_of_date: "2026-02-01", visit_id: "v2",
        document_id: "doc1", source_page: 2, source_location: null, source_snippet: "no new lesions",
        fallback_level: "exact",
      },
    ],
  };

  const timelineDocument = {
    id: "doc1", patient_id: "p1", visit_id: "v2", file_ref: "local://p1/x.pdf",
    document_type: "radiology", imaging_modality: null, source_origin: "own_hospital",
    uploaded_by: "u1", uploaded_at: "2026-02-01T00:00:00Z", ocr_status: "done",
    ocr_text_ref: null, needs_manual_date: false, extraction_status: "complete", extraction_error: null,
  };

  const { page } = await openSnapshot("staff", snapshotBody(), {}, (path) => {
    if (path === "/patients/p1/timeline") return timelineBody;
    // SourceView fetches document + facts + a file-availability probe in parallel
    // (apps/web/src/screens/SourceView.tsx); the probe 404ing is expected/ignored --
    // same as every other Source view scenario in this file -- but the facts list
    // must contain a fact whose id matches the clicked point's fact_id ("f2" for the
    // marker dot, "rf1" for the radiology tick), or SourceView renders its "fact could
    // not be found" error state instead of the document heading this test waits for.
    if (path === "/documents/doc1") {
      return { document: timelineDocument, ocr: { fullText: "no new lesions", pages: [{ pageNumber: 1, text: "no new lesions" }] } };
    }
    if (path === "/documents/doc1/facts") {
      return {
        document: timelineDocument,
        facts: [
          {
            id: "rf1", patient_id: "p1", visit_id: "v2", document_id: "doc1", tracked_marker_id: null,
            tracked_marker_name: null, raw_marker_label: null, field_type: "radiology_impression",
            value: "no new lesions", unit: null, reference_range: null, as_of_date: "2026-02-01",
            needs_manual_date: false, coverage_status: "value_found", verification_state: "oncologist_signed_off",
            has_blocking_conflict: false, source_page: 2, source_location: null, source_snippet: "no new lesions",
            fallback_level: "exact", ...CHECKED,
          },
          {
            id: "f2", patient_id: "p1", visit_id: "v2", document_id: "doc1", tracked_marker_id: "m1",
            tracked_marker_name: "CEA", raw_marker_label: null, field_type: "marker_value",
            value: "9.0", unit: "ng/mL", reference_range: null, as_of_date: "2026-02-01",
            needs_manual_date: false, coverage_status: "value_found", verification_state: "oncologist_signed_off",
            has_blocking_conflict: false, source_page: null, source_location: null, source_snippet: null,
            fallback_level: "document", ...CHECKED,
          },
        ],
        tracked_markers: [],
        check_summary: checkSummaryFor([CHECKED, CHECKED]),
      };
    }
    return undefined;
  });

  await page.getByRole("button", { name: "Timeline" }).click();
  await page.getByRole("heading", { name: "Test Patient" }).waitFor();

  await page.getByText("CEA — 9", { exact: false }).waitFor();

  // Marker points click through to Source view too, same as treatment/radiology ticks.
  await page.getByRole("button", { name: "CEA 2026-02-01: 9.0 ng/mL" }).click();
  await page.getByRole("heading", { name: "Source document" }).waitFor();

  await page.goBack();
  await page.getByRole("heading", { name: "Test Patient" }).waitFor();
  await page.getByRole("button", { name: /Radiology 2026-02-01/ }).click();
  await page.getByRole("heading", { name: "Source document" }).waitFor();
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
  return { ...base, fallback_level, ...CHECKED };
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
      return json({ document: sourceDocumentRecord(document), facts: [sourceFact(factOverrides)], tracked_markers: [], check_summary: checkSummaryFor([CHECKED]) });
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


// ---- Held documents (patient-identity mismatch) -------------------------------------------
type HeldDoc = {
  id: string; status: "mismatch" | "awaiting_oncologist" | "partial" | "confirmed" | "rejected"; name: string; lab: string;
  assessment?: string; note?: string; confirmedBy?: string;
};

async function openHeldScenario(
  startAt: string,
  opts: { conflictOnConfirm?: boolean; identityListFails?: boolean; postFails?: boolean; role?: "staff" | "oncologist"; extraDocs?: HeldDoc[] } = {},
) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // A deliberate 409 from the stub is logged by the browser as a failed resource load.
    if (opts.conflictOnConfirm && msg.text().includes("409")) return;
    if ((opts.identityListFails || opts.postFails) && msg.text().includes("500")) return;
    // Review of a document with no extracted facts probes /documents/:id/file, which 404s in this stub.
    if (/^http:\/\/opd-api\.test\/documents\/[^/]+\/file$/.test(msg.location().url)) return;
    errors.push(`console: ${msg.text()}`);
  });
  const docs: HeldDoc[] = [
    { id: "dA", status: "mismatch", name: "Someone Else", lab: "Lab A" },
    { id: "dB", status: "mismatch", name: "Another Person", lab: "Lab B" },
    { id: "dP", status: "partial", name: "Test P.", lab: "Lab P" },
    ...(opts.extraDocs ?? []),
  ];
  const posts: { path: string; body: unknown }[] = [];
  const cors = {
    "Access-Control-Allow-Origin": BASE,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  const docRecord = (d: HeldDoc) => ({
    id: d.id, patient_id: "p1", visit_id: "v2", file_ref: "local://x.pdf", document_type: "blood", imaging_modality: null,
    source_origin: "own_hospital", uploaded_by: "u1", uploaded_at: "2026-03-02T00:00:00Z", ocr_status: "done",
    ocr_text_ref: null, needs_manual_date: false, extraction_status: "done", extraction_error: null,
    identity_status: d.status, patient_name_on_report: d.name, lab_name: d.lab,
  });
  const heldCount = () => docs.filter((d) => d.status === "mismatch" || d.status === "awaiting_oncologist").length;

  await page.route(`${API}/**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (b: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (path === "/auth/me") return json({ id: "u1", name: "Test User", email: "t@opd.local", role: opts.role ?? "oncologist" });
    if (path === "/patients" && req.method() === "GET") {
      const base = { cancer_type: "Breast", created_at: "2026-01-01", created_by: "u1", mrn: null, patient_origin: "own_hospital", date_of_birth: null, stage: null, last_visit_date: "2026-02-01", needs_attention_count: 0, unchecked_fact_count: 0 };
      return json([
        { ...base, id: "p1", name: "Test Patient", held_document_count: heldCount() },
        { ...base, id: "p2", name: "Clean Patient", held_document_count: 0 },
      ]);
    }
    if (path === "/patients/p1/documents/identity") {
      if (opts.identityListFails) return json({ error: "boom", message: "Server exploded." }, 500);
      return json({
        patient_name: "Test Patient",
        documents: docs.filter((d) => d.status !== "rejected").map((d) => ({
          id: d.id, document_type: "blood", lab_name: d.lab, patient_name_on_report: d.name,
          identity_status: d.status, uploaded_at: "2026-03-02T00:00:00Z", collected_on: "2026-03-01",
          staff_identity_assessment: d.assessment ?? null, staff_identity_note: d.note ?? null,
          staff_identity_at: d.assessment ? "2026-03-03T00:00:00Z" : null, staff_identity_by_name: d.assessment ? "Priya" : null,
          confirmed_at: d.confirmedBy ? "2026-03-04T00:00:00Z" : null, confirmed_by_name: d.confirmedBy ?? null,
        })),
      });
    }
    if (path === "/patients/p1/summary") return json(EMPTY_SUMMARY);
    if (path === "/patients/p1/plan") return json({ next_review: null, items: [] });
    if (isPrepPath(path)) return json(prepBody());
    if (path === "/patients/p1/snapshot") {
      // Facts of a confirmed document are live; held and rejected ones are excluded.
      const live = docs.filter((d) => d.status === "confirmed");
      return json(snapshotBody({
        tumor_markers: live.map((d) => snapshotField({ fact_id: `f-${d.id}`, marker_name: `Marker from ${d.lab}`, tracked_marker_id: `m-${d.id}`, provenance: provenance({ document_id: d.id }) })),
      }));
    }
    if (/^\/patients\/p1\/markers\/[^/]+\/trend$/.test(path)) return json({ marker_name: "", points: [] });
    const post = path.match(/^\/documents\/([^/]+)\/identity$/);
    if (post && req.method() === "POST") {
      const d = docs.find((x) => x.id === post[1]);
      const body = req.postDataJSON() as { action: "confirm" | "reject" };
      posts.push({ path, body });
      if (opts.postFails) return json({ error: "boom", message: "Could not save right now." }, 500);
      if (!d) return json({ error: "not_found", message: "Document not found." }, 404);
      if (opts.conflictOnConfirm && d.id === "dA") d.status = "confirmed"; // someone else decided first
      if (d.status !== "mismatch" && d.status !== "awaiting_oncologist") return json({ error: "conflict", message: "Not held." }, 409);
      d.status = body.action === "confirm" ? "confirmed" : "rejected";
      if (d.status === "confirmed") d.confirmedBy = "Dr Rao";
      return json(docRecord(d));
    }
    const flagPost = path.match(/^\/documents\/([^/]+)\/identity-flag$/);
    if (flagPost && req.method() === "POST") {
      const d = docs.find((x) => x.id === flagPost[1]);
      const body = req.postDataJSON() as { assessment: string; note: string };
      posts.push({ path, body });
      if (!d) return json({ error: "not_found", message: "Document not found." }, 404);
      if (d.status !== "mismatch" && d.status !== "awaiting_oncologist") return json({ error: "conflict", message: "Not held." }, 409);
      d.status = "awaiting_oncologist";
      d.assessment = body.assessment;
      d.note = body.note;
      return json(docRecord(d));
    }
    if (/^\/documents\/[^/]+\/identity-preview$/.test(path)) {
      const d = docs.find((x) => path.includes(`/${x.id}/`));
      return json({
        document_id: d?.id, lab_name: d?.lab, patient_name_on_report: d?.name, fact_total: 3,
        fact_counts: { marker_value: 2, diagnosis: 1 },
        markers: [{ marker_name: "CEA", as_of_date: "2026-03-01" }, { marker_name: "CA 15-3", as_of_date: "2026-03-01" }],
        new_conflicts: [{ field_type: "marker_value", marker_name: "CEA", as_of_date: "2026-03-01", this_value: "9.9", other_value: "4.2", unit: "ng/mL" }],
        staff_assessment: d?.assessment ? { assessment: d.assessment, note: d.note ?? null, at: "2026-03-03T00:00:00Z" } : null,
      });
    }
    const facts = path.match(/^\/documents\/([^/]+)\/facts$/);
    if (facts) {
      const d = docs.find((x) => x.id === facts[1]);
      if (d) return json({ document: docRecord(d), facts: [], tracked_markers: [], check_summary: checkSummaryFor([]) });
    }
    return json({}, 404);
  });

  await page.goto(`${BASE}/#${startAt}`);
  return { page, errors, posts, docs };
}

test("Patient list: 'N held' badge shows for a patient with held documents and not for one without; it links to the held screen", async () => {
  const { page, errors } = await openHeldScenario("/");
  await page.getByText("Clean Patient").waitFor();
  const badge = page.getByRole("button", { name: "2 held documents, review" });
  expect(await badge.count()).toBe(1);
  expect(await page.getByText(/\d+ held/).count()).toBe(1);
  await badge.click();
  await page.getByRole("heading", { name: "Held documents" }).waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Held screen: shows printed vs recorded name, lab and review link; partial rows have a review link and no buttons", async () => {
  const { page, errors } = await openHeldScenario("/patients/p1/held");
  await page.getByRole("heading", { name: "Held documents" }).waitFor();
  const rows = page.getByTestId("held-row");
  await rows.first().waitFor();
  expect(await rows.count()).toBe(2);
  const first = rows.first();
  expect(await first.getByTestId("printed-name").textContent()).toBe("Someone Else");
  expect(await first.getByTestId("recorded-name").textContent()).toBe("Test Patient");
  expect(await first.textContent()).toContain("Lab A");
  expect(await first.getByRole("link", { name: "Open extraction review" }).getAttribute("href")).toBe("#/documents/dA/review");

  const partial = page.getByTestId("partial-row");
  expect(await partial.count()).toBe(1);
  expect(await partial.getByRole("link", { name: "Open extraction review" }).count()).toBe(1);
  expect(await partial.getByRole("button").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Held screen: Confirm removes the row, shows the result, and the document's facts then appear in the Snapshot", async () => {
  const { page, errors, posts } = await openHeldScenario("/patients/p1/snapshot");
  await page.getByRole("heading", { name: "Test Patient" }).waitFor();
  await page.getByText("2 reports held for identity").waitFor();
  expect(await page.getByText("Marker from Lab A").count()).toBe(0);

  await page.getByRole("link", { name: "Held documents" }).click();
  await page.getByRole("heading", { name: "Held documents" }).waitFor();
  await page.getByTestId("held-row").first().getByRole("button", { name: "Confirm" }).click();
  await page.getByTestId("held-row").first().getByRole("button", { name: "Yes, confirm" }).click();
  await page.getByText("Confirmed. This document's facts are now live").waitFor();
  expect(await page.getByTestId("held-row").count()).toBe(1);
  expect(posts).toEqual([{ path: "/documents/dA/identity", body: { action: "confirm" } }]);

  await page.getByRole("button", { name: "Back to Snapshot" }).click();
  await page.getByText("Marker from Lab A").first().waitFor();
  await page.getByText("1 report held for identity").waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Held screen: Reject needs an explicit confirmation step, then removes the row and its facts never appear", async () => {
  const { page, errors, posts } = await openHeldScenario("/patients/p1/held");
  const row = page.getByTestId("held-row").first();
  await row.getByRole("button", { name: "Reject" }).click();
  // Nothing is sent until the permanent-action prompt is confirmed.
  await page.getByText("This cannot be undone.").waitFor();
  expect(posts).toEqual([]);
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(posts).toEqual([]);
  expect(await page.getByRole("button", { name: "Confirm" }).count()).toBe(2);

  await row.getByRole("button", { name: "Reject" }).click();
  await page.getByRole("button", { name: "Yes, reject permanently" }).click();
  await page.getByText("Rejected. This document is permanently excluded.").waitFor();
  expect(await page.getByTestId("held-row").count()).toBe(1);
  expect(posts).toEqual([{ path: "/documents/dA/identity", body: { action: "reject" } }]);

  await page.getByRole("button", { name: "Back to Snapshot" }).click();
  await page.getByText("1 report held for identity").waitFor();
  expect(await page.getByText("Marker from Lab A").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Held screen: a 409 (already decided elsewhere) reloads the list instead of leaving a stale row", async () => {
  const { page, errors } = await openHeldScenario("/patients/p1/held", { conflictOnConfirm: true });
  await page.getByTestId("held-row").first().getByRole("button", { name: "Confirm" }).click();
  await page.getByTestId("held-row").first().getByRole("button", { name: "Yes, confirm" }).click();
  await page.getByText("had already changed").waitFor();
  expect(await page.getByTestId("held-row").count()).toBe(1);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Held screen: empty state when nothing is held", async () => {
  const { page, errors } = await openHeldScenario("/patients/p1/held");
  for (const remaining of [1, 0]) {
    await page.getByTestId("held-row").first().getByRole("button", { name: "Confirm" }).click();
    await page.getByTestId("held-row").first().getByRole("button", { name: "Yes, confirm" }).click();
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="held-row"]').length === n, remaining);
  }
  await page.getByText("No documents held.").waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Extraction review: a held document shows both names with Confirm/Reject; a partial one shows the name-difference banner and no buttons", async () => {
  const { page, errors } = await openHeldScenario("/documents/dP/review");
  await page.getByRole("heading", { name: "Extraction review" }).waitFor();
  await page.getByText("Name on the report differs slightly from the record; verify this is the right patient.").waitFor();
  expect(await page.getByRole("button", { name: "Confirm" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Reject" }).count()).toBe(0);

  await page.goto(`${BASE}/#/documents/dA/review`);
  const banner = page.getByTestId("identity-mismatch-banner");
  await banner.waitFor();
  await banner.getByText("Test Patient").waitFor();
  expect(await banner.getByTestId("printed-name").textContent()).toBe("Someone Else");
  await banner.getByRole("button", { name: "Confirm" }).click();
  await banner.getByRole("button", { name: "Yes, confirm" }).click();
  await page.getByText("Confirmed. This document's facts are now live").waitFor();
  await banner.waitFor({ state: "detached" });
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Extraction review: when the record name cannot be loaded the banner says so (not 'unnamed'), Confirm is disabled, and Retry recovers", async () => {
  const { page, errors } = await openHeldScenario("/documents/dA/review", { identityListFails: true });
  const banner = page.getByTestId("identity-mismatch-banner");
  await banner.waitFor();
  await banner.getByText("Could not load the record name").waitFor();
  expect(await banner.textContent()).not.toContain("(unnamed patient)");
  expect(await banner.getByRole("button", { name: "Confirm" }).isDisabled()).toBe(true);
  expect(await banner.getByRole("button", { name: "Reject" }).isDisabled()).toBe(false);
  expect(await banner.getByRole("button", { name: "Retry loading the record name" }).count()).toBe(1);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Held screen: a non-409 failure shows an inline error and the row stays", async () => {
  const { page, errors } = await openHeldScenario("/patients/p1/held", { postFails: true });
  await page.getByTestId("held-row").first().getByRole("button", { name: "Confirm" }).click();
  await page.getByTestId("held-row").first().getByRole("button", { name: "Yes, confirm" }).click();
  await page.getByText("Could not save right now.").waitFor();
  expect(await page.getByTestId("held-row").count()).toBe(2);
  expect(await page.getByTestId("held-row").first().getByRole("button", { name: "Yes, confirm" }).isEnabled()).toBe(true);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

const flaggedDoc = (): HeldDoc => ({ id: "dF", status: "awaiting_oncologist", name: "Flag Person", lab: "Lab F", assessment: "likely_same", note: "Spelt differently on the lab system" });
const acceptedDoc = (): HeldDoc => ({ id: "dC", status: "confirmed", name: "Confirmed Person", lab: "Lab C", assessment: "cannot_tell", note: "Two similar names", confirmedBy: "Dr Rao" });

test("Staff on the Snapshot banner: sees the report text, flags for the oncologist, and has no Confirm or Reject", async () => {
  const { page, errors, posts } = await openHeldScenario("/patients/p1/snapshot", { role: "staff" });
  const banner = page.getByTestId("held-banner");
  await banner.waitFor();
  expect(await banner.textContent()).toContain('"Someone Else" on Lab A, 2026-03-01');
  expect(await banner.textContent()).toContain("excluded below until the oncologist confirms");
  expect(await banner.getByRole("button", { name: "Review held report" }).count()).toBe(0);
  await banner.getByTestId("held-banner-row").first().getByRole("button", { name: "Flag for oncologist" }).click();
  const form = page.getByTestId("flag-form");
  expect(await form.getByRole("button", { name: "Flag for oncologist" }).isDisabled()).toBe(true);
  expect(await page.getByRole("button", { name: "Confirm" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Reject" }).count()).toBe(0);
  await form.getByLabel("Likely the same patient").check();
  await form.getByLabel("Note for the oncologist (optional)").fill("Spelt differently");
  await form.getByRole("button", { name: "Flag for oncologist" }).click();
  await page.getByTestId("flagged-tag").waitFor();
  expect(posts).toEqual([{ path: "/documents/dA/identity-flag", body: { assessment: "likely_same", note: "Spelt differently" } }]);
  expect(await page.getByText("Marker from Lab A").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Oncologist on the Snapshot banner: Review held report shows the staff assessment and preview, then Confirm needs a confirmation", async () => {
  const { page, errors, posts } = await openHeldScenario("/patients/p1/snapshot", { extraDocs: [flaggedDoc()] });
  const banner = page.getByTestId("held-banner");
  await banner.waitFor();
  expect(await banner.textContent()).toContain("3 reports held for identity");
  expect(await banner.textContent()).toContain("excluded below until you confirm");
  const row = banner.getByTestId("held-banner-row").nth(2);
  expect(await row.textContent()).toContain("Staff assessment · awaiting oncologist");
  await row.getByRole("button", { name: "Review held report" }).click();

  const panel = page.getByTestId("review-panel");
  await panel.getByTestId("identity-preview").waitFor();
  expect(await panel.getByTestId("staff-assessment").textContent()).toContain("Staff think this is the same patient");
  expect(await panel.getByTestId("staff-assessment").textContent()).toContain("Spelt differently on the lab system");
  expect(await panel.textContent()).toContain("2 × Marker values");
  expect(await panel.textContent()).toContain("CEA (2026-03-01)");
  expect(await panel.getByTestId("preview-conflicts").textContent()).toContain("this report says 9.9 ng/mL, the record says 4.2");

  await panel.getByRole("button", { name: "Confirm" }).click();
  expect(posts).toEqual([]);
  await panel.getByRole("button", { name: "Yes, confirm" }).click();
  await page.getByTestId("held-result").getByText("Confirmed. This report's facts are now live").waitFor();
  expect(posts).toEqual([{ path: "/documents/dF/identity", body: { action: "confirm" } }]);
  await page.getByText("Marker from Lab F").first().waitFor();
  await page.getByText("2 reports held for identity").waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Held screen as staff: no Confirm or Reject, a flag form, and a flagged row shows the assessment in plain words", async () => {
  const { page, errors, posts } = await openHeldScenario("/patients/p1/held", { role: "staff", extraDocs: [flaggedDoc()] });
  await page.getByTestId("held-row").first().waitFor();
  expect(await page.getByRole("button", { name: "Confirm" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Reject" }).count()).toBe(0);
  const flagged = page.getByTestId("held-row").nth(2);
  expect(await flagged.textContent()).toContain("Staff assessment · awaiting oncologist");
  expect(await flagged.getByTestId("staff-assessment").textContent()).toContain("Staff think this is the same patient");

  const first = page.getByTestId("held-row").first();
  await first.getByLabel("Likely a different patient").check();
  await first.getByRole("button", { name: "Flag for oncologist" }).click();
  await page.getByText("Sent to the oncologist. It stays held until they decide.").waitFor();
  expect(posts).toEqual([{ path: "/documents/dA/identity-flag", body: { assessment: "likely_different", note: "" } }]);
  expect(await first.textContent()).toContain("Staff assessment · awaiting oncologist");
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Held screen: the 'Accepted with a name difference' list shows confirmed documents with who confirmed and the staff note", async () => {
  const { page, errors } = await openHeldScenario("/patients/p1/held", { extraDocs: [acceptedDoc()] });
  await page.getByRole("heading", { name: "Accepted with a name difference" }).waitFor();
  const rows = page.getByTestId("partial-row");
  expect(await rows.count()).toBe(2);
  const confirmed = rows.nth(1);
  expect(await confirmed.getByTestId("confirmed-by").textContent()).toContain("Confirmed by Dr Rao");
  expect(await confirmed.getByTestId("staff-assessment").textContent()).toContain("Two similar names");
  expect(await confirmed.getByRole("button").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("summary screen: quoted facts with Source links, placeholders, and load error with Retry", async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // Only the deliberately failed first summary request (500) is expected.
    if (msg.location().url === `${API}/patients/p1/summary` && msg.text().includes("status of 500")) return;
    errors.push(`console: ${msg.text()}`);
  });
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };
  const item = {
    fact_id: "f1", document_id: "d1", text: "Lt MRM + ALND", as_of_date: "2026-01-10", facility: "Apollo",
    verification_state: "staff_corrected",
    provenance: { document_id: "d1", source_page: 1, source_location: null, source_snippet: "x", fallback_level: "exact" },
  };
  let summaryCalls = 0;
  await page.route(`${API}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (path === "/auth/me") return json({ id: "u1", name: "Test Staff", email: "s@opd.local", role: "staff" });
    if (path === "/patients/p1/summary") {
      if (++summaryCalls === 1) return json({ error: { code: "server", message: "Boom" } }, 500);
      return json({
        patient: { id: "p1", name: "Asha Rao" }, documents_count: 2,
        what_happened: [item],
        disease_history: { diagnosis: [], histology_ihc: [], stage: [] },
        procedures: [item], prescriptions: [],
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });
  await page.goto(`${BASE}/#/patients/p1/summary`);
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByText("Patient summary · compiled from 2 documents").waitFor();
  await page.getByText("Each line is a fact from a document, quoted as written.").waitFor();
  expect(await page.getByText("Not extracted yet").count()).toBeGreaterThanOrEqual(7);
  expect(await page.getByText("Not found in documents").count()).toBeGreaterThan(0);
  expect(await page.getByText("staff corrected").count()).toBeGreaterThan(0);
  expect(await page.locator('a[href="#/documents/d1/source?fact=f1"]').count()).toBe(2);
  expect(errors).toEqual([]);
  // A Source link navigates to the document source route for that fact.
  await page.locator('a[href="#/documents/d1/source?fact=f1"]').first().click();
  await page.waitForFunction(() => window.location.hash === "#/documents/d1/source?fact=f1");
  await page.close();
}, 30_000);

test("Snapshot: summary strip shows data and 'Full summary' opens the Summary route", async () => {
  const item = (fact_id: string, text: string, as_of_date: string | null) => ({
    fact_id, document_id: "d1", text, as_of_date, facility: null, verification_state: "unverified",
    provenance: { document_id: "d1", source_page: 1, source_location: null, source_snippet: "x", fallback_level: "exact" },
  });
  const summaryBody = {
    ...EMPTY_SUMMARY,
    documents_count: 1,
    // undated fact arrives last (API order) but must not displace the dated one
    disease_history: { diagnosis: [item("f1", "IDC dated", "2026-01-01"), item("f2", "IDC undated", null)], histology_ihc: [], stage: [] },
    prescriptions: [{ document_id: "d1", date: "2026-02-01", regimens: [item("f3", "Tab X 10mg", "2026-02-01")], tests_advised: [], next_reviews: [] }],
  };
  const { page, errors } = await openSnapshot("staff", snapshotBody(), {}, undefined, summaryBody);
  const strip = page.getByTestId("summary-strip");
  await strip.getByText("IDC dated").waitFor();
  expect(await strip.getByText("IDC undated").count()).toBe(0);
  await strip.getByText("Tab X 10mg").waitFor();
  await strip.getByRole("link", { name: "Full summary" }).click();
  await page.waitForFunction(() => window.location.hash === "#/patients/p1/summary");
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

// Spot-check controls on the review screen.
test("spot-check: Correct POSTs the mark, the card shows it, and progress updates", async () => {
  const { page, errors, checkBodies, card } = await openReviewAs("staff", { verification_state: "unverified", check_state: "unchecked" });
  await page.getByText("0 of 1 checked").waitFor();
  await card.getByRole("button", { name: "Incorrect", exact: true }).waitFor();
  await card.getByRole("button", { name: "Correct", exact: true }).click();
  await card.getByText("Checked correct").waitFor();
  await page.getByText("1 of 1 checked").waitFor();
  await page.getByText("All facts checked.").waitFor();
  expect(checkBodies).toEqual([{ result: "correct" }]);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("spot-check: Incorrect needs a 'What was wrong' choice before the submit enables, then POSTs the correction", async () => {
  const { page, errors, checkBodies, card } = await openReviewAs("staff", { verification_state: "unverified", check_state: "unchecked" });
  await card.getByRole("button", { name: "Incorrect", exact: true }).click();
  const save = card.getByRole("button", { name: "Save correction" });
  expect(await save.isDisabled()).toBe(true);
  await card.getByLabel("What was wrong").selectOption("value");
  expect(await save.isDisabled()).toBe(true);
  await card.getByLabel("Corrected value").fill("5.0");
  expect(await save.isEnabled()).toBe(true);
  await save.click();
  await card.getByText("Marked incorrect: value").waitFor();
  expect(checkBodies).toEqual([{ result: "incorrect", error_type: "value", correction: { value: "5.0" } }]);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("spot-check: 'Not in the document' asks for confirmation and POSTs nothing until Confirm", async () => {
  const { page, errors, checkBodies, card } = await openReviewAs("staff", { verification_state: "unverified", check_state: "unchecked" });
  await card.getByRole("button", { name: "Incorrect", exact: true }).click();
  await card.getByLabel("What was wrong").selectOption("not_in_document");
  await card.getByText("This fact will be excluded from every view. Continue?").waitFor();
  expect(checkBodies).toEqual([]);
  await card.getByRole("button", { name: "Cancel" }).click();
  expect(checkBodies).toEqual([]);
  await card.getByRole("button", { name: "Incorrect", exact: true }).click();
  await card.getByLabel("What was wrong").selectOption("not_in_document");
  await card.getByRole("button", { name: "Confirm" }).click();
  await card.getByText("Marked incorrect: not in the document").waitFor();
  expect(checkBodies).toEqual([{ result: "incorrect", error_type: "not_in_document" }]);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("spot-check: an unchecked fact blocks sign-off with the check reason, and the conflict reason wins when both apply", async () => {
  const a = await openReviewAs("oncologist", { verification_state: "unverified", check_state: "unchecked" });
  expect(await a.signOff.isDisabled()).toBe(true);
  await a.card.getByText("Check this fact against the source first").waitFor();
  await a.page.close();
  const b = await openReviewAs("oncologist", { verification_state: "unverified", check_state: "unchecked", has_blocking_conflict: true });
  await b.page.getByText("Blocked by an unresolved conflict").waitFor();
  expect(await b.page.getByText("Check this fact against the source first").count()).toBe(0);
  await b.page.close();
}, 30_000);

test("spot-check: a changed (reset) mark says so", async () => {
  const { page, card } = await openReviewAs("staff", { verification_state: "staff_corrected", check_state: "unchecked" });
  await card.getByText("Changed since it was checked. Mark it again.").waitFor();
  await page.close();
}, 30_000);

test("spot-check keyboard: keys typed in an input or select do nothing; c on the body checks the active card", async () => {
  const { page, errors, checkBodies, card } = await openReviewAs("staff", {
    verification_state: "unverified", check_state: "unchecked", needs_manual_date: true, unmapped: true,
  });
  const cards = page.locator(".card[data-fact-id]");
  await cards.nth(1).waitFor();
  const current = () => page.locator('.card[aria-current="true"]').getAttribute("data-fact-id");
  const first = await current();

  // Focus in the marker select: c and x must not mark or open the form.
  await page.getByLabel("Existing tracked marker").first().focus();
  await page.keyboard.press("c");
  await page.keyboard.press("x");
  await page.waitForTimeout(300);
  expect(checkBodies).toEqual([]);
  expect(await card.getByText("Not checked yet").count()).toBe(1);
  expect(await page.getByLabel("What was wrong").count()).toBe(0);

  // Focus in a text input: same.
  await page.locator("summary", { hasText: "Correct this value" }).first().click();
  await page.locator('input[id^="value-"]').first().focus();
  await page.keyboard.type("cx");
  await page.waitForTimeout(300);
  expect(checkBodies).toEqual([]);
  expect(await card.getByText("Not checked yet").count()).toBe(1);
  expect(await page.getByLabel("What was wrong").count()).toBe(0);
  expect(await current()).toBe(first);

  // With focus on the body, c checks the active card.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("c");
  await page.getByText("Checked correct").first().waitFor();
  expect(checkBodies).toHaveLength(1);
  expect(checkBodies[0]).toEqual({ result: "correct" });
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("spot-check keyboard: arrows move the active card, but not when a button is focused or at the ends", async () => {
  const { page, errors } = await openReviewAs("staff", {
    verification_state: "unverified", check_state: "unchecked", needs_manual_date: true,
  });
  await page.locator(".card[data-fact-id]").nth(1).waitFor();
  const current = () => page.locator('.card[aria-current="true"]').getAttribute("data-fact-id");
  const first = await current();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const prevented = async (key: string) =>
    page.evaluate((k) => {
      const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return ev.defaultPrevented;
    }, key);
  expect(await prevented("ArrowUp")).toBe(false); // first card: page scrolls
  await page.keyboard.press("ArrowDown");
  const second = await current();
  expect(second).not.toBe(first);
  expect(await prevented("ArrowDown")).toBe(false); // last card
  // A focused button keeps its own arrow behaviour.
  await page.getByRole("button", { name: "Correct", exact: true }).first().focus();
  await page.keyboard.press("ArrowUp");
  expect(await current()).toBe(second);
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("ArrowUp");
  expect(await current()).toBe(first);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("spot-check keyboard: x opens the Incorrect form and pauses the shortcuts while it is open", async () => {
  const { page, checkBodies, card } = await openReviewAs("staff", { verification_state: "unverified", check_state: "unchecked" });
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("x");
  await card.getByLabel("What was wrong").waitFor();
  await card.getByRole("heading", { name: "CEA" }).click();
  await page.keyboard.press("c");
  await page.waitForTimeout(300);
  expect(checkBodies).toEqual([]);
  expect(await card.getByText("Not checked yet").count()).toBe(1);
  await page.close();
}, 30_000);

test("spot-check keyboard: a held or doubled c sends one request, then c moves on to the next unchecked card", async () => {
  const { page, errors, checkedIds } = await openReviewAs("staff", {
    verification_state: "unverified", check_state: "unchecked", needs_manual_date: true, check_delay: 400,
  });
  await page.locator(".card[data-fact-id]").nth(1).waitFor();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const active = await page.locator('.card[aria-current="true"]').getAttribute("data-fact-id");
  await page.keyboard.press("c");
  await page.keyboard.press("c");
  await page.keyboard.down("c"); // auto-repeat
  await page.keyboard.down("c");
  await page.keyboard.up("c");
  await page.getByText("Checked correct").first().waitFor();
  await page.waitForTimeout(300);
  expect(checkedIds).toEqual(["f1"]);
  // Highlight advanced to the other (still unchecked) card, so the next c marks that one.
  await page.waitForFunction((prev) => document.querySelector('.card[aria-current="true"]')?.getAttribute("data-fact-id") !== prev, active);
  await page.keyboard.press("c");
  await page.waitForFunction(() => document.querySelectorAll(".fact-check .tag").length === 2 && !document.body.innerText.includes("Not checked yet"));
  expect(checkedIds).toEqual(["f1", "f2"]);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("spot-check: marking by mouse also moves the highlight to the next unchecked card", async () => {
  const { page, errors, card } = await openReviewAs("staff", {
    verification_state: "unverified", check_state: "unchecked", needs_manual_date: true,
  });
  await page.locator(".card[data-fact-id]").nth(1).waitFor();
  await card.getByRole("button", { name: "Correct", exact: true }).click();
  await card.getByText("Checked correct").waitFor();
  await page.waitForFunction(() => document.querySelector('.card[aria-current="true"] h2')?.textContent === "PSA");
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("spot-check: a document with no facts shows no 'All facts checked.' banner", async () => {
  const { page, errors } = await openReview("done");
  await page.getByText(ZERO_FACTS_TEXT).waitFor();
  expect(await page.getByText("All facts checked.").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("spot-check: the patient list shows 'N to check' only when something is unchecked", async () => {
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
    if (path === "/patients") {
      const base = { cancer_type: "Breast", created_at: "2026-01-01", created_by: "u1", mrn: null, patient_origin: "own_hospital", date_of_birth: null, stage: null, last_visit_date: "2026-02-01", needs_attention_count: 0, held_document_count: 0 };
      return json([
        { ...base, id: "p1", name: "Busy Patient", unchecked_fact_count: 2 },
        { ...base, id: "p2", name: "Done Patient", unchecked_fact_count: 0 },
      ]);
    }
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });
  await page.goto(`${BASE}/#/patients`);
  await page.getByText("2 to check").waitFor();
  expect(await page.getByText("0 to check").count()).toBe(0);
  expect(await page.getByText(/to check/).count()).toBe(1);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("plan screen: next review + source, four status wordings, confirm match, add item, load error with Retry", async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // Only the deliberately failed first plan request (500) is expected.
    if (msg.location().url === `${API}/patients/p1/plan` && msg.text().includes("status of 500")) return;
    errors.push(`console: ${msg.text()}`);
  });
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };
  const base = {
    approx_date: null, stated_date: null, past_advised: false, matched_document: null, suggested_document: null,
    source_fact_id: null, source_document_id: null,
  };
  const review = { ...base, id: "i1", type: "review", text: "after 2 weeks", advised_at: "2030-10-13", approx_date: "2030-10-27", status: "planned", source_fact_id: "f1", source_document_id: "d1" };
  const suggested = { ...base, id: "i2", type: "test", text: "CT chest", advised_at: "2030-09-01", status: "report_suggested", suggested_document: { id: "d2", label: "CT · 2030-09-20" } };
  const past = { ...base, id: "i3", type: "procedure", text: "Port insertion", advised_at: "2020-01-01", status: "past_advised", past_advised: true };
  let confirmed = false;
  let added: unknown = null;
  let planCalls = 0;
  const plan = () => {
    const i2 = confirmed
      ? { ...suggested, status: "report_seen", suggested_document: null, matched_document: suggested.suggested_document }
      : suggested;
    return { next_review: review, items: [review, i2, past] };
  };
  await page.route(`${API}/**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { ...cors, "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" } });
    }
    if (path === "/auth/me") return json({ id: "u1", name: "Test Staff", email: "s@opd.local", role: "staff" });
    if (path === "/patients/p1/plan" && req.method() === "GET") {
      if (++planCalls === 1) return json({ error: "server", message: "Boom" }, 500);
      return json(plan());
    }
    if (path === "/patients/p1/plan" && req.method() === "POST") {
      added = req.postDataJSON();
      return json({ id: "i4" }, 201);
    }
    if (path === "/plan-items/i2/match" && req.method() === "POST") {
      expect(req.postDataJSON()).toEqual({ document_id: "d2" });
      confirmed = true;
      return json({ id: "i2", matched_document_id: "d2" });
    }
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });
  await page.goto(`${BASE}/#/patients/p1/plan`);
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByRole("heading", { name: "Next review after 2 weeks · ≈27 Oct 2030" }).waitFor();
  expect(await page.locator('a[href="#/documents/d1/source?fact=f1"]').count()).toBeGreaterThan(0);
  await page.getByText("Planned · ≈27 Oct").waitFor();
  await page.getByText("Report seen · CT · 2030-09-20 · confirm match").waitFor();
  await page.getByText("Past advised date · no report seen").waitFor();

  await page.getByRole("button", { name: "Confirm match" }).click();
  await page.getByText("Report seen · CT · 2030-09-20", { exact: true }).waitFor();
  expect(await page.getByRole("button", { name: "Confirm match" }).count()).toBe(0);

  await page.getByRole("button", { name: "+ Add plan item" }).click();
  await page.getByLabel("As written").fill("MRI brain in 3 months");
  await page.getByLabel("Advised on").fill("2030-10-13");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "+ Add plan item" }).waitFor();
  expect(added).toEqual({ type: "test", text: "MRI brain in 3 months", advised_at: "2030-10-13" });
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot batch sign-off: checkbox only on eligible facts, no select-all, sign off then toast Undo", async () => {
  const body = snapshotBody({
    tumor_markers: [
      snapshotField({ fact_id: "f1", marker_name: "CEA" }),
      snapshotField({ fact_id: "f2", marker_name: "PSA", tracked_marker_id: "m2", value: "1.0" }),
      snapshotField({ fact_id: "f3", marker_name: "CA-125", tracked_marker_id: "m3", check_state: "unchecked" }),
    ],
  });
  const calls: { path: string; body: unknown }[] = [];
  let signed = false;
  const { page, errors } = await openSnapshot("oncologist", body, {}, (path, method) => {
    if (method === "POST" && path.startsWith("/facts/sign-off-batch")) {
      calls.push({ path, body: null });
      signed = !path.endsWith("/undo");
      return { count: 2 };
    }
    return undefined;
  });
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST") posts.push(`${new URL(r.url()).pathname} ${r.postData()}`); });

  const button = (name: string | RegExp) => page.getByRole("button", { name });
  await button("Select facts to sign off").waitFor();
  expect(await button("Select facts to sign off").isDisabled()).toBe(true);
  expect(await page.getByRole("checkbox").count()).toBe(2); // f3 is unchecked by staff: no box
  expect(await page.getByText("Needs staff check first").count()).toBe(1);
  expect(await page.getByLabel(/select all/i).count()).toBe(0);
  expect(await page.getByRole("checkbox", { checked: true }).count()).toBe(0);

  await page.getByRole("checkbox", { name: "Select CEA for sign-off" }).check();
  await page.getByRole("checkbox", { name: "Select PSA for sign-off" }).check();
  await button("Sign off 2 reviewed").click();
  await page.getByText("Signed off 2 facts").waitFor();
  expect(posts).toEqual([`/facts/sign-off-batch ${JSON.stringify({ fact_ids: ["f1", "f2"] })}`]);
  expect(signed).toBe(true);

  await button("Undo").click();
  await page.getByText("Signed off 2 facts").waitFor({ state: "detached" });
  expect(posts[1]).toBe(`/facts/sign-off-batch/undo ${JSON.stringify({ fact_ids: ["f1", "f2"] })}`);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot batch sign-off: a 409 lists each refused fact with the server's reason", async () => {
  const body = snapshotBody({
    tumor_markers: [
      snapshotField({ fact_id: "f1", marker_name: "CEA" }),
      snapshotField({ fact_id: "f2", marker_name: "PSA", tracked_marker_id: "m2" }),
    ],
  });
  const { page, errors } = await openSnapshot("oncologist", body);
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };
  await page.route(`${API}/facts/sign-off-batch`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 409, contentType: "application/json", headers: cors,
      body: JSON.stringify({
        error: "conflict", message: "Some facts cannot be processed; nothing was changed.",
        failures: [{ fact_id: "f2", reason: "held", message: "This document is held for a patient identity mismatch." }],
      }),
    });
  });
  await page.getByRole("checkbox", { name: "Select CEA for sign-off" }).check();
  await page.getByRole("checkbox", { name: "Select PSA for sign-off" }).check();
  await page.getByRole("button", { name: "Sign off 2 reviewed" }).click();
  const list = page.getByTestId("batch-failures");
  await list.getByText("PSA: This document is held for a patient identity mismatch.").waitFor();
  expect(await list.locator("li").count()).toBe(1);
  expect(errors.filter((e) => !e.includes("409"))).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: a single-fact Sign off shows the 'Signed off 1 fact' toast and its Undo posts that one id", async () => {
  const body = snapshotBody({ tumor_markers: [snapshotField({ fact_id: "f1", marker_name: "CEA" })] });
  const { page, errors } = await openSnapshot("oncologist", body, {}, (path, method) => {
    if (method === "POST" && path === "/facts/f1/sign-off") return snapshotField({ fact_id: "f1" });
    if (method === "POST" && path === "/facts/sign-off-batch/undo") return { count: 1 };
    return undefined;
  });
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST") posts.push(`${new URL(r.url()).pathname} ${r.postData()}`); });
  await page.locator(".card", { has: page.getByRole("heading", { name: "CEA" }) }).getByRole("button", { name: "Sign off", exact: true }).click();
  await page.getByText("Signed off 1 fact").waitFor();
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByText("Signed off 1 fact").waitFor({ state: "detached" });
  expect(posts).toContain(`/facts/sign-off-batch/undo ${JSON.stringify({ fact_ids: ["f1"] })}`);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: switching patient clears the sign-off toast", async () => {
  const body = snapshotBody({ tumor_markers: [snapshotField({ fact_id: "f1", marker_name: "CEA" })] });
  const { page, errors } = await openSnapshot("oncologist", body, {}, (path, method) =>
    method === "POST" && path === "/facts/f1/sign-off" ? snapshotField({ fact_id: "f1" }) : undefined);
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };
  await page.route(`${API}/patients/p2/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (path === "/patients/p2/snapshot") return json({ ...snapshotBody(), patient: { id: "p2", name: "Other Patient", cancer_type: "Breast" } });
    if (path === "/patients/p2/summary") return json(EMPTY_SUMMARY);
    if (path === "/patients/p2/plan") return json({ next_review: null, items: [] });
    if (path === "/patients/p2/documents/identity") return json({ patient_name: "Other Patient", documents: [] });
    return route.fallback();
  });
  await page.locator(".card", { has: page.getByRole("heading", { name: "CEA" }) }).getByRole("button", { name: "Sign off", exact: true }).click();
  await page.getByText("Signed off 1 fact").waitFor();
  await page.evaluate(() => { location.hash = "#/patients/p2/snapshot"; });
  await page.getByRole("heading", { name: "Other Patient" }).waitFor();
  expect(await page.getByText("Signed off 1 fact").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot batch sign-off: selected row is tinted, keeps value and source, and staff see no controls", async () => {
  const body = snapshotBody({ tumor_markers: [snapshotField({ fact_id: "f1", marker_name: "CEA" })] });
  const onc = await openSnapshot("oncologist", body);
  await onc.page.getByRole("checkbox", { name: "Select CEA for sign-off" }).check();
  const row = onc.page.locator(".snapshot-field--selected");
  await row.getByText("4.2 ng/mL").waitFor();
  await row.getByRole("button", { name: /View uploaded document/ }).waitFor();
  expect(await row.count()).toBe(1);
  expect(onc.errors).toEqual([]);
  await onc.page.close();

  const staff = await openSnapshot("staff", body);
  await staff.page.getByRole("heading", { name: "CEA" }).waitFor();
  expect(await staff.page.getByRole("checkbox").count()).toBe(0);
  expect(await staff.page.getByText("Select facts to sign off").count()).toBe(0);
  await staff.page.close();
}, 30_000);

test("Snapshot: an unchecked fact reaches FactCard as a disabled Sign off with the check reason", async () => {
  const body = snapshotBody({ tumor_markers: [snapshotField({ fact_id: "f1", marker_name: "CEA", check_state: "unchecked" })] });
  const { page, errors } = await openSnapshot("oncologist", body);
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "CEA" }) });
  const signOff = card.getByRole("button", { name: "Sign off", exact: true });
  await signOff.waitFor();
  expect(await signOff.isDisabled()).toBe(true);
  await card.getByText("Check this fact against the source first").waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("spot-check: an excluded undated fact does not trigger the undated notice, and c on an excluded fact POSTs nothing", async () => {
  const { page, errors, checkBodies } = await openReviewAs("staff", {
    verification_state: "unverified", check_state: "incorrect", error_type: "not_in_document", needs_manual_date: true, f2_check: "correct",
  });
  await page.locator(".card[data-fact-id]").first().waitFor();
  expect(await page.getByText("fact(s) have no as-of date").count()).toBe(0);
  const excluded = page.locator('.card[data-fact-id="f1"]');
  await excluded.click();
  await page.keyboard.press("c");
  await page.waitForTimeout(300);
  expect(checkBodies).toEqual([]);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

// --- Watchlist (M3-07) ---
function watchEntry(overrides: Record<string, unknown> = {}) {
  return {
    tracked_marker_id: "m1", marker_name: "CEA", pinned_by_name: "Dr. Rao", missing: false,
    conflict: false, conflict_id: null, unit_changed: false,
    latest: { fact_id: "f1", document_id: "doc1", value: "7.5", unit: "ng/mL", reference_range: "0-5", as_of_date: "2026-02-01", delta_status: "changed", verification_state: "unverified", was: { value: "3.0", unit: "ng/mL" } },
    sparkline: [
      { fact_id: "f0", document_id: "doc0", value: "3.0", unit: "ng/mL", as_of_date: "2026-01-01", verification_state: "oncologist_signed_off" },
      { fact_id: "f1", document_id: "doc1", value: "7.5", unit: "ng/mL", as_of_date: "2026-02-01", verification_state: "unverified" },
    ],
    last_seen: { fact_id: "f1", document_id: "doc1", value: "7.5", unit: "ng/mL", as_of_date: "2026-02-01", verification_state: "unverified" },
    ...overrides,
  };
}

test("Watchlist: pinned cell shows value, text-only out-of-range and 'was', a hollow marker; a missing pin shows the last value; no red/green", async () => {
  const body = snapshotBody({
    watchlist: [
      watchEntry(),
      watchEntry({ tracked_marker_id: "m2", marker_name: "AFP", missing: true, latest: null, sparkline: [],
        last_seen: { fact_id: "f9", document_id: "doc9", value: "1.5", unit: "ng/mL", as_of_date: "2026-01-05", verification_state: "unverified" } }),
    ],
    pin_options: [
      { tracked_marker_id: "m1", marker_name: "CEA", is_pinned: true, suggested: false },
      { tracked_marker_id: "m2", marker_name: "AFP", is_pinned: true, suggested: false },
    ],
  });
  const { page, errors } = await openSnapshot("oncologist", body);
  await page.getByRole("heading", { name: "Watchlist · pinned by Dr. Rao" }).waitFor();
  const cells = page.getByTestId("watch-cell");
  expect(await cells.count()).toBe(2);
  const cea = cells.nth(0);
  await cea.getByText("7.5", { exact: true }).waitFor();
  await cea.getByText("ng/mL · ref 0-5 · above reference range · was 3.0 ng/mL · unverified").waitFor();
  const dots = cea.locator("svg circle");
  expect(await dots.nth(0).getAttribute("fill")).toBe("var(--color-chart-line)");
  expect(await dots.nth(1).getAttribute("fill")).toBe("var(--color-surface)");
  await cells.nth(1).getByText("Not in this visit · last 1.5 ng/mL on 2026-01-05").waitFor();
  expect(await cells.nth(1).getByText("—", { exact: true }).count()).toBe(1);
  expect(await page.getByText("1 suggested pin").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Watchlist: an open-conflict pin shows 'Sources disagree' and a review link, not a confident value or emphasis dot", async () => {
  const body = snapshotBody({
    watchlist: [watchEntry({ conflict: true, conflict_id: "c1" })],
    pin_options: [{ tracked_marker_id: "m1", marker_name: "CEA", is_pinned: true, suggested: false }],
  });
  const { page, errors } = await openSnapshot("oncologist", body);
  const cell = page.getByTestId("watch-cell");
  await cell.getByText("Sources disagree").waitFor();
  expect(await cell.getByText("7.5", { exact: true }).count()).toBe(0);
  expect(await cell.getByText("above reference range", { exact: false }).count()).toBe(0);
  await cell.getByRole("button", { name: "Conflicting sources — review" }).click();
  await page.waitForFunction(() => location.hash.startsWith("#/conflicts/c1"));
  await page.close();
}, 30_000);

test("Watchlist: unit change note, non-numeric latest keeps the sparkline and hollow marker, empty value is not plotted as 0", async () => {
  const body = snapshotBody({
    watchlist: [
      watchEntry({
        unit_changed: true,
        latest: { ...watchEntry().latest, verification_state: "oncologist_signed_off" },
        sparkline: [
          { fact_id: "f0", document_id: "doc0", value: "2.0", unit: "ng/mL", as_of_date: "2026-01-01", verification_state: "oncologist_signed_off" },
          { fact_id: "e", document_id: "doc0", value: "", unit: "ng/mL", as_of_date: "2026-01-15", verification_state: "oncologist_signed_off" },
          { fact_id: "n", document_id: "doc0", value: "<0.5", unit: "ng/mL", as_of_date: "2026-01-20", verification_state: "oncologist_signed_off" },
          { fact_id: "f1", document_id: "doc1", value: "7.5", unit: "ng/mL", as_of_date: "2026-02-01", verification_state: "oncologist_signed_off" },
        ],
      }),
    ],
    pin_options: [{ tracked_marker_id: "m1", marker_name: "CEA", is_pinned: true, suggested: false }],
  });
  const { page, errors } = await openSnapshot("staff", body);
  const cell = page.getByTestId("watch-cell");
  await cell.getByText("unit changed — earlier values not plotted", { exact: false }).waitFor();
  await cell.getByText("signed off", { exact: false }).waitFor();
  // "" and "<0.5" are not plotted; the signed 2.0 is solid and the latest 7.5 (above 0-5) is the hollow emphasis dot.
  const dots = cell.locator("svg circle");
  expect(await dots.count()).toBe(2);
  expect(await dots.nth(0).getAttribute("fill")).toBe("var(--color-chart-line)");
  expect(await dots.nth(1).getAttribute("fill")).toBe("var(--color-surface)");
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Watchlist: a cell without a document says so and opens the pane with the same words; Enter or Space on a cell opens the pane at that fact; missing pin does too", async () => {
  const noDoc = watchEntry({ latest: { ...watchEntry().latest, document_id: null } });
  const missing = watchEntry({
    tracked_marker_id: "m2", marker_name: "AFP", missing: true, latest: null, sparkline: [],
    last_seen: { fact_id: "f9", document_id: "doc9", value: "1.5", unit: "ng/mL", as_of_date: "2026-01-05", verification_state: "unverified" },
  });
  const body = snapshotBody({
    watchlist: [noDoc, missing],
    pin_options: [
      { tracked_marker_id: "m1", marker_name: "CEA", is_pinned: true, suggested: false },
      { tracked_marker_id: "m2", marker_name: "AFP", is_pinned: true, suggested: false },
    ],
  });
  const { page, errors } = await openSnapshot("staff", body, {}, paneRoutes());
  const cells = page.getByTestId("watch-cell");
  await cells.nth(0).getByText("No document available for this value").waitFor();
  await cells.nth(0).click();
  await page.getByTestId("pane-no-document").getByText("No document is available for this value.").waitFor();
  expect(await page.getByTestId("pane-provenance").count()).toBe(0);
  await page.getByRole("button", { name: "Close documents panel" }).click();
  await cells.nth(1).focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("pane-provenance").waitFor();
  await page.getByRole("button", { name: "Close documents panel" }).click();
  await cells.nth(1).focus();
  await page.keyboard.press(" ");
  await page.getByTestId("pane-provenance").waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Watchlist: clicking a cell opens the pane at that fact, not the full page", async () => {
  const body = snapshotBody({ watchlist: [watchEntry()], pin_options: [{ tracked_marker_id: "m1", marker_name: "CEA", is_pinned: true, suggested: false }] });
  const { page, errors } = await openSnapshot("staff", body, {}, paneRoutes());
  await page.getByTestId("watch-cell").click();
  await page.getByTestId("pane-provenance").waitFor();
  expect(await page.getByTestId("source-highlight").textContent()).toBe("PSA 1.1 ng/mL");
  expect(await page.evaluate(() => location.hash)).toBe("#/patients/p1/snapshot");
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Watchlist: oncologist sees the suggestion banner with Accept and Dismiss; Accept POSTs a pin", async () => {
  const body = snapshotBody({
    suggested_pins: [{ tracked_marker_id: "m3", marker_name: "CA 19-9", suggested_by_name: "Priya", note: "rising" }],
    pin_options: [{ tracked_marker_id: "m3", marker_name: "CA 19-9", is_pinned: false, suggested: true }],
  });
  const posts: { path: string; body: string | null }[] = [];
  const { page, errors } = await openSnapshot("oncologist", body, {}, () => undefined);
  await page.route(`${API}/tracked-markers/**`, (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    posts.push({ path: new URL(req.url()).pathname, body: req.postData() });
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" }, body: "{}" });
  });
  await page.getByText("1 suggested pin from Priya").waitFor();
  const banner = page.getByTestId("suggested-pin-banner");
  await banner.getByText("CA 19-9").waitFor();
  await banner.getByRole("button", { name: "Dismiss" }).waitFor();
  await banner.getByRole("button", { name: "Accept" }).click();
  for (let i = 0; i < 100 && posts.length === 0; i++) await Bun.sleep(20);
  expect(posts.length).toBe(1);
  expect(posts[0]).toEqual({ path: "/tracked-markers/m3/pin", body: JSON.stringify({ pinned: true }) });
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Watchlist: staff see the suggestion text but no Accept/Dismiss, and can Suggest pin with a note", async () => {
  const body = snapshotBody({
    suggested_pins: [{ tracked_marker_id: "m3", marker_name: "CA 19-9", suggested_by_name: "Priya", note: null }],
    pin_options: [
      { tracked_marker_id: "m3", marker_name: "CA 19-9", is_pinned: false, suggested: true },
      { tracked_marker_id: "m4", marker_name: "AFP", is_pinned: false, suggested: false },
    ],
  });
  const posts: { path: string; body: string | null }[] = [];
  const { page, errors } = await openSnapshot("staff", body);
  await page.route(`${API}/tracked-markers/**`, (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    posts.push({ path: new URL(req.url()).pathname, body: req.postData() });
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" }, body: "{}" });
  });
  await page.getByText("1 suggested pin from Priya").waitFor();
  expect(await page.getByRole("button", { name: "Accept" }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Dismiss" }).count()).toBe(0);
  await page.getByRole("button", { name: "Edit pins" }).click();
  expect(await page.getByRole("button", { name: "Pin", exact: true }).count()).toBe(0);
  await page.getByRole("button", { name: "Suggest pin" }).nth(1).click();
  await page.getByLabel("Note for AFP (optional)").fill("check trend");
  await page.getByRole("button", { name: "Send suggestion" }).click();
  for (let i = 0; i < 100 && posts.length === 0; i++) await Bun.sleep(20);
  expect(posts.length).toBe(1);
  expect(posts[0]).toEqual({ path: "/tracked-markers/m4/suggest-pin", body: JSON.stringify({ note: "check trend" }) });
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: 'For this visit' follows the 7 rules in order, tags each row, folds unchanged items, and explains itself", async () => {
  const conflicted = { conflict_id: "c1", status: "open", other_fact_id: "f9", other_value: "9.0", other_source: provenance(), authoritative_fact_id: null, historical: false };
  const body = snapshotBody({
    current_treatment: [snapshotField({ fact_id: "t1", field_type: "treatment_regimen", tracked_marker_id: null, marker_name: null, value: "FOLFOX", unit: null, reference_range: null, delta_status: "changed" })],
    tumor_markers: [
      snapshotField({ fact_id: "f7", marker_name: "CA-125", tracked_marker_id: "m7", delta_status: "unchanged" }),
      snapshotField({ fact_id: "f4", marker_name: "PSA", tracked_marker_id: "m4", value: "9.0", delta_status: "changed" }),
      snapshotField({ fact_id: "f2", marker_name: "CEA", tracked_marker_id: "m1", value: "7.5", delta_status: "changed" }),
      snapshotField({ fact_id: "f1", marker_name: "AFP", tracked_marker_id: "m5", conflicts: [conflicted], delta_status: "unchanged" }),
    ],
    radiology: [snapshotField({ fact_id: "r1", field_type: "radiology_impression", tracked_marker_id: null, marker_name: null, value: "Stable lesion", unit: null, reference_range: null, delta_status: "new" })],
    watchlist: [
      watchEntry(),
      watchEntry({ tracked_marker_id: "m2", marker_name: "HER2", missing: true, latest: null, sparkline: [],
        last_seen: { fact_id: "f9", document_id: null, value: "1.5", unit: "ng/mL", as_of_date: "2026-01-05", verification_state: "unverified" } }),
    ],
  });
  const plan = { next_review: null, items: [{ id: "pl1", type: "test", text: "Bone scan", advised_at: "2025-01-01", approx_date: null, stated_date: null, status: "past_advised", past_advised: true, matched_document: null, suggested_document: null, source_fact_id: null, source_document_id: null }] };
  const { page, errors } = await openSnapshot("oncologist", body, {}, undefined, EMPTY_SUMMARY, plan);
  await page.getByRole("heading", { name: "For this visit · 7" }).waitFor();
  await page.getByText("Bone scan").waitFor();

  const tags = await page.getByTestId("rule-tag").allTextContents();
  expect(tags).toEqual([
    "Conflict between sources", "Pinned · changed", "New radiology report", "Outside range",
    "Plan item past advised date", "Pinned · not in this visit", "Changed or new",
  ]);

  // Unchanged items are folded away until opened; the checkbox on a reordered row still works.
  expect(await page.getByRole("heading", { name: "CA-125" }).count()).toBe(0);
  await page.getByRole("checkbox", { name: "Select CEA for sign-off" }).check();
  await page.getByRole("button", { name: "Sign off 1 reviewed" }).waitFor();
  await page.getByRole("button", { name: "Unchanged since last signed-off value here · 1 ▸" }).click();
  await page.getByRole("heading", { name: "CA-125" }).waitFor();

  // The rule list is hidden until asked for.
  expect(await page.getByTestId("how-ordered").count()).toBe(0);
  await page.getByRole("button", { name: "How this is ordered" }).click();
  const how = page.getByTestId("how-ordered");
  expect(await how.locator("li").allTextContents()).toEqual([
    "Conflict between sources", "Pinned marker, changed or new", "New radiology report", "Changed or new, outside lab range",
    "Plan item past advised date", "Pinned marker not in this visit", "Other changed or new",
  ]);
  await how.getByText("Same order for every patient. No score or weighting.").waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

// M3-06 (AM-03): visits elsewhere.
const MAX = { id: "oe1", facility: "Max Hospital", date: "2026-01-20" };

test("Snapshot: compare defaults to 'Last visit here', switching reloads with ?compare=any and changes 'was'; elsewhere facts are labelled", async () => {
  const compare = { mode: "here", last_here: { date: "2026-01-01" }, latest_any: { facility: "Max Hospital", date: "2026-01-20" } };
  const bodyFor = (param: string | null) =>
    snapshotBody({
      compare: { ...compare, mode: param === "any" ? "any" : "here" },
      tumor_markers: [snapshotField({ fact_id: "f1", outside_encounter: param === "any" ? MAX : null })],
      pin_options: [{ tracked_marker_id: "m1", marker_name: "CEA", is_pinned: true, suggested: false }],
      watchlist: [watchEntry({ latest: { ...watchEntry().latest, was: { value: param === "any" ? "8.0" : "3.0", unit: "ng/mL" }, outside_encounter: null } })],
    });
  const seen: (string | null)[] = [];
  const { page, errors } = await openSnapshot("oncologist", (p: string | null) => (seen.push(p), bodyFor(p)));
  const here = page.getByRole("button", { name: "Last visit here · 2026-01-01" });
  const any = page.getByRole("button", { name: "Latest anywhere · Max Hospital 2026-01-20" });
  await here.waitFor();
  expect(await here.getAttribute("aria-pressed")).toBe("true");
  expect(await any.getAttribute("aria-pressed")).toBe("false");
  await page.getByText(/was 3\.0 ng\/mL/).waitFor();
  expect(await page.getByTestId("elsewhere-tag").count()).toBe(0);
  expect(seen).toEqual([null]);
  await page.getByRole("heading", { name: "Since last visit here" }).waitFor();
  expect(await page.getByTestId("compare-baseline").textContent()).toBe("Compared with: last visit here 2026-01-01");

  await any.click();
  await page.getByText(/was 8\.0 ng\/mL/).waitFor();
  expect(await any.getAttribute("aria-pressed")).toBe("true");
  expect(seen.at(-1)).toBe("any");
  await page.getByRole("heading", { name: "Since latest visit anywhere" }).waitFor();
  expect(await page.getByTestId("compare-baseline").textContent()).toBe("Compared with: Max Hospital 2026-01-20");
  await page.getByTestId("elsewhere-tag").first().waitFor();
  expect(await page.getByTestId("elsewhere-tag").first().textContent()).toBe("visit elsewhere · Max Hospital");
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: with no previous visit here, 'Latest anywhere' still shows the since-last-visit section with its baseline", async () => {
  const bodyFor = (param: string | null) =>
    snapshotBody({
      previous_visit: { id: null, visit_date: null },
      compare: { mode: param === "any" ? "any" : "here", last_here: null, latest_any: { facility: "Max Hospital", date: "2026-01-20" } },
    });
  const { page, errors } = await openSnapshot("staff", bodyFor);
  await page.getByRole("button", { name: "Latest anywhere · Max Hospital 2026-01-20" }).click();
  await page.getByRole("heading", { name: "Since latest visit anywhere" }).waitFor();
  await page.getByText("Compared with: Max Hospital 2026-01-20").waitFor();
  expect(await page.getByTestId("compare-baseline").textContent()).toBe("Compared with: Max Hospital 2026-01-20");
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Conflict screen: a side from a visit elsewhere is labelled, the other side is not", async () => {
  const side = (id: string, outside: unknown) => ({
    id, patient_id: "p1", visit_id: "v1", document_id: `doc-${id}`, tracked_marker_id: null, tracked_marker_name: null,
    field_type: "treatment_regimen", value: id === "fa" ? "FOLFOX" : "FOLFIRI", unit: null, reference_range: null,
    as_of_date: "2026-01-20", coverage_status: "value_found", verification_state: "unverified",
    source_page: 1, source_location: null, source_snippet: null, outside_encounter: outside,
  });
  const { page, errors } = await openRoutedPage("/conflicts/c1", (path) =>
    path === "/conflicts/c1"
      ? {
          conflict: { id: "c1", fact_id_a: "fa", fact_id_b: "fb", status: "open", authoritative_fact_id: null, annotation_note: null, resolution_note: null, resolved_by: null, resolved_at: null },
          fact_a: side("fa", MAX), fact_b: side("fb", null),
        }
      : undefined);
  await page.getByRole("heading", { name: "Conflict" }).waitFor();
  const tags = await page.getByTestId("elsewhere-tag").allTextContents();
  expect(tags).toEqual(["visit elsewhere · Max Hospital"]);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Snapshot: without outside data there is no 'Latest anywhere' option", async () => {
  const { page, errors } = await openSnapshot("staff", snapshotBody());
  await page.getByRole("button", { name: "Last visit here · 2026-01-01" }).waitFor();
  expect(await page.getByRole("button", { name: /Latest anywhere/ }).count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

async function openRoutedPage(hash: string, handle: (path: string, method: string, postData: string | null) => unknown | undefined) {
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
    if (req.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { ...cors, "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" } });
    }
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (path === "/auth/me") return json({ id: "u1", name: "Test", email: "t@opd.local", role: "staff" });
    const result = handle(path, req.method(), req.postData());
    return result === undefined ? json({}, 404) : json(result);
  });
  await page.goto(`${BASE}/#${hash}`);
  return { page, errors };
}

test("Upload: 'from another facility' needs both a date and a facility before anything is sent", async () => {
  const posts: string[] = [];
  const { page, errors } = await openRoutedPage("/patients/p1/upload", (path, method, postData) => {
    if (path === "/patients/p1" && method === "GET") return { id: "p1", name: "Test Patient", cancer_type: "Breast", tracked_markers: [] };
    if (path === "/patients/p1/visits" && method === "POST") return { id: "v2", patient_id: "p1", visit_date: "2026-02-01" };
    if (path === "/patients/p1/documents" && method === "POST") {
      posts.push(postData ?? "");
      return { id: "d1", document_type: "blood", source_origin: "own_hospital", ocr_status: "pending", imaging_modality: null, outside_encounter_id: "oe1" };
    }
    return undefined;
  });
  await page.getByRole("heading", { name: "Test Patient" }).waitFor();
  // Hidden until the option is chosen.
  expect(await page.getByLabel("Facility", { exact: true }).count()).toBe(0);
  await page.setInputFiles("#file", { name: "a.pdf", mimeType: "application/pdf", buffer: Buffer.from("x") });
  await page.getByLabel("This document is from another facility").check();
  const upload = page.getByRole("button", { name: "Upload", exact: true });
  await upload.click();
  await page.getByText("Enter the date and the facility of the visit elsewhere before uploading.").waitFor();
  await page.getByLabel("Date of the visit elsewhere").fill("2026-01-20");
  await upload.click();
  await page.getByText("Enter the date and the facility of the visit elsewhere before uploading.").waitFor();
  expect(posts).toEqual([]);

  await page.getByLabel("Facility", { exact: true }).fill("Max Hospital");
  await upload.click();
  await page.getByText("blood · own hospital · visit elsewhere").waitFor();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain('name="outside"');
  expect(posts[0]).toContain("2026-01-20");
  expect(posts[0]).toContain("Max Hospital");
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Visit history: a visit elsewhere is listed in date order with a dashed rule, '{facility} · elsewhere' and its document count", async () => {
  const { page, errors } = await openRoutedPage("/patients/p1/history", (path) => {
    if (path === "/patients/p1/visits") {
      return [
        { id: "v2", visit_date: "2026-03-01", document_count: 1, fact_count: 2, signed_off_count: 1 },
        { id: "v1", visit_date: "2026-01-01", document_count: 1, fact_count: 1, signed_off_count: 0 },
      ];
    }
    if (path === "/patients/p1/outside-encounters") return [{ id: "oe1", encounter_date: "2026-02-10", facility: "Max Hospital", document_count: 2 }];
    return undefined;
  });
  const row = page.getByTestId("elsewhere-row");
  await row.waitFor();
  expect(await row.getByText("Max Hospital · elsewhere").count()).toBe(1);
  expect(await row.getByText("visit elsewhere · Max Hospital").count()).toBe(1);
  expect(await row.getByText("2 documents").count()).toBe(1);
  expect(await row.evaluate((el) => getComputedStyle(el).borderBottomStyle)).toBe("dashed");
  // Between 2026-03-01 and 2026-01-01, in date order, with no sign-off tag.
  const names = await page.locator(".delta-row__name").allTextContents();
  expect(names).toEqual(["2026-03-01", "2026-02-10", "2026-01-01"]);
  expect(await row.getByText(/signed off/).count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Upload: 'Other' is selectable, is sent as document_type=other and is listed as 'Other'", async () => {
  const posts: string[] = [];
  const { page, errors } = await openRoutedPage("/patients/p1/upload", (path, method, postData) => {
    if (path === "/patients/p1" && method === "GET") return { id: "p1", name: "Test Patient", cancer_type: "Breast", tracked_markers: [] };
    if (path === "/patients/p1/visits" && method === "POST") return { id: "v2", patient_id: "p1", visit_date: "2026-02-01" };
    if (path === "/patients/p1/documents" && method === "POST") {
      posts.push(postData ?? "");
      return { id: "d1", document_type: "other", source_origin: "own_hospital", ocr_status: "done", imaging_modality: null, outside_encounter_id: null };
    }
    return undefined;
  });
  await page.getByRole("heading", { name: "Test Patient" }).waitFor();
  await page.getByLabel("Document type").selectOption({ label: "Other" });
  await page.setInputFiles("#file", { name: "a.pdf", mimeType: "application/pdf", buffer: Buffer.from("x") });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await page.getByText("Uploaded this session").waitFor();
  expect(posts.length).toBe(1);
  expect(posts[0]).toContain("other");
  expect(await page.locator(".patient-row", { hasText: "Other · own hospital" }).count()).toBe(1);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("review screen: an 'other' document says 'Not extracted in this version', never failed or nothing found", async () => {
  const { page, errors } = await openRoutedPage("/documents/doc1/review", (path) => {
    if (path === "/documents/doc1/facts") {
      return {
        document: {
          id: "doc1", patient_id: "p1", visit_id: "v1", file_ref: "local://x.pdf", document_type: "other",
          source_origin: "own_hospital", uploaded_by: "u1", uploaded_at: "2026-01-01T00:00:00Z",
          ocr_status: "done", ocr_text_ref: null, needs_manual_date: false,
          extraction_status: "not_extracted", extraction_error: null,
        },
        facts: [], tracked_markers: [], check_summary: checkSummaryFor([]),
      };
    }
    return undefined;
  });
  await page.getByText("Not extracted in this version.").waitFor();
  expect(await page.getByText(/Fact extraction failed/).count()).toBe(0);
  expect(await page.getByText(ZERO_FACTS_TEXT).count()).toBe(0);
  expect(await page.getByText(PENDING_TEXT).count()).toBe(0);
  await page.close();
}, 30_000);

for (const ocrStatus of ["failed", "pending"]) {
  test(`review screen: an 'other' document with ocr_status ${ocrStatus} still says 'Not extracted in this version' and links the file`, async () => {
    const { page } = await openRoutedPage("/documents/doc1/review", (path) => {
      if (path === "/documents/doc1/file") return {};
      if (path === "/documents/doc1/facts") {
        return {
          document: {
            id: "doc1", patient_id: "p1", visit_id: "v1", file_ref: "local://x.pdf", document_type: "other",
            source_origin: "own_hospital", uploaded_by: "u1", uploaded_at: "2026-01-01T00:00:00Z",
            ocr_status: ocrStatus, ocr_text_ref: null, needs_manual_date: false,
            extraction_status: "not_extracted", extraction_error: null,
          },
          facts: [], tracked_markers: [], check_summary: checkSummaryFor([]),
        };
      }
      return undefined;
    });
    await page.getByText("Not extracted in this version.").waitFor();
    expect(await page.getByText(/OCR status is/).count()).toBe(0);
    expect(await page.getByRole("heading", { name: "Uploaded file" }).count()).toBe(1);
    await page.close();
  }, 30_000);
}

// ---- M3-09: Today groups, Mark ready, request-report banner ----

test("Today: four groups by state, each ordered by name, with the change summary line, sparkline and tag", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };
  // The app uses the browser's local day; ask the browser rather than assume it shares this process's time zone.
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const base = {
    cancer_type: "Breast", created_at: "2026-01-01", created_by: "u1", mrn: null, patient_origin: "own_hospital", date_of_birth: null, stage: null,
    sex: null, needs_attention_count: 0, held_document_count: 0, unchecked_fact_count: 0, latest_elsewhere: null, diagnosis_text: null, regimen_text: null,
    last_visit_date: today, prep_status: "preparing", current_visit_document_count: 0, sign_off_count: 0, change_summary_items: [],
    first_pinned_sparkline: null, has_plan_items_expected: false,
  };
  const point = (id: string, value: string, date: string) => ({ fact_id: id, document_id: null, value, unit: "U/mL", as_of_date: date, verification_state: "oncologist_signed_off", outside_encounter: null });
  await page.route(`${API}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (path === "/auth/me") return json({ id: "u1", name: "Test", email: "t@opd.local", role: "oncologist" });
    if (path === "/patients") {
      return json([
        { ...base, id: "p9", name: "Zara Ready", prep_status: "ready" },
        {
          ...base, id: "p1", name: "Asha Ready", prep_status: "ready", sign_off_count: 2, date_of_birth: "1972-01-01", sex: "female",
          diagnosis_text: "Invasive ductal carcinoma", regimen_text: "FEC x 6", current_visit_document_count: 2,
          change_summary_items: [
            { kind: "marker_changed", name: "CA-125", from: "188", to: "412" },
            { kind: "new_report", type: "radiology", modality: "ct" },
            { kind: "sources_disagree", name: "CEA" },
            { kind: "plan_past", count: 1 },
            { kind: "elsewhere", facility: "Apollo", date: "2026-09-22" },
          ],
          first_pinned_sparkline: { marker_name: "CA-125", reference_range: "0-35", points: [point("a", "188", "2026-08-01"), point("b", "412", "2026-09-01")] },
        },
        { ...base, id: "p2", name: "Bina Preparing", current_visit_document_count: 1 },
        { ...base, id: "p3", name: "Chitra Nothing" },
        { ...base, id: "p4", name: "Dev Expected", last_visit_date: "2026-01-05", prep_status: "preparing", has_plan_items_expected: true },
      ]);
    }
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });
  await page.goto(`${BASE}/#/patients`);
  for (const title of ["Ready for you · 2", "Staff preparing · 1", "Nothing new · 1", "Expected from plan, no visit opened · 1"]) {
    await page.getByRole("heading", { name: title }).waitFor();
  }
  const ready = page.getByRole("region", { name: "Ready for you" }).getByTestId("today-row");
  expect(await ready.locator(".today-row__name").allTextContents()).toEqual(["Asha Ready", "Zara Ready"]);
  const asha = ready.first();
  await asha.getByText('54F · "Invasive ductal carcinoma" · "FEC x 6"').waitFor();
  expect(await asha.getByTestId("change-summary").textContent()).toBe(
    "CA-125 changed 188 → 412 · new CT · CEA sources disagree · 1 plan item past advised date · visit elsewhere: Apollo 22 Sep",
  );
  expect(await asha.getByRole("img", { name: "CA-125 last 2 values" }).count()).toBe(1);
  expect(await asha.getByText("2 to sign off").count()).toBe(1);
  expect(await ready.nth(1).getByText("Ready", { exact: true }).count()).toBe(1);
  expect(await page.getByRole("region", { name: "Staff preparing" }).getByText("Preparing", { exact: true }).count()).toBe(1);
  expect(await page.getByRole("region", { name: "Expected from plan, no visit opened" }).getByText("Planned", { exact: true }).count()).toBe(1);
  // Row actions keep working.
  await asha.getByRole("button", { name: "Plan" }).click();
  await page.waitForURL(/#\/patients\/p1\/plan/);
  expect(errors.filter((e) => !e.includes("404"))).toEqual([]);
  await page.close();
}, 30_000);

test("Today: a patient whose last visit is old but has facts to check sits under Staff preparing, not Nothing new", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };
  const base = {
    cancer_type: "Breast", created_at: "2026-01-01", created_by: "u1", mrn: null, patient_origin: "own_hospital", date_of_birth: null, stage: null,
    sex: null, needs_attention_count: 0, held_document_count: 0, unchecked_fact_count: 0, latest_elsewhere: null, diagnosis_text: null, regimen_text: null,
    last_visit_date: "2026-03-02", prep_status: "preparing", current_visit_document_count: 0, sign_off_count: 0, change_summary_items: [],
    first_pinned_sparkline: null, has_plan_items_expected: false,
  };
  await page.route(`${API}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (path === "/auth/me") return json({ id: "u1", name: "Test", email: "t@opd.local", role: "oncologist" });
    if (path === "/patients") {
      return json([
        { ...base, id: "p1", name: "Old Visit Checks", unchecked_fact_count: 2, current_visit_document_count: 1 },
        { ...base, id: "p2", name: "Old Visit Quiet", prep_status: null },
      ]);
    }
    return route.fulfill({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
  });
  await page.goto(`${BASE}/#/patients`);
  await page.getByRole("heading", { name: "Staff preparing · 1" }).waitFor();
  await page.getByRole("heading", { name: "Nothing new · 1" }).waitFor();
  const preparing = page.getByRole("region", { name: "Staff preparing" });
  expect(await preparing.getByText("Old Visit Checks").count()).toBe(1);
  expect(await preparing.getByText("2 to check").count()).toBe(1);
  expect(await page.getByRole("region", { name: "Nothing new" }).getByText("Old Visit Quiet").count()).toBe(1);
  await page.close();
}, 30_000);

test("Mark ready: blocked with the reasons while a check fails, then ready and back to preparing", async () => {
  let prep = prepBody({
    can_mark_ready: false,
    items: PREP_ITEMS.map((i) => (i.key === "facts_checked" ? { ...i, ok: false, count: 2, reason: "2 facts are not checked yet" } : i)),
  });
  const { page, errors } = await openSnapshot("staff", snapshotBody(), {}, (path) => {
    if (!isPrepPath(path)) return undefined;
    return prep;
  });
  const panel = page.getByTestId("prep-panel");
  await panel.getByText("Preparing this visit").waitFor();
  await panel.getByText("2 facts are not checked yet").waitFor();
  expect(await panel.getByTestId("prep-item-facts_checked").getAttribute("data-ok")).toBe("false");
  expect(await panel.getByTestId("prep-item-uploaded").getAttribute("data-ok")).toBe("true");
  expect(await panel.getByRole("button", { name: "Mark ready" }).isDisabled()).toBe(true);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Mark ready: Mark ready posts, shows who marked it, Back to preparing posts false; a refusal shows its message", async () => {
  let prep: any = prepBody();
  const posts: unknown[] = [];
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().includes("409")) errors.push(`console: ${msg.text()}`);
  });
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
  let refuse = true;
  await page.route(`${API}/**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (path === "/auth/me") return json({ id: "u1", name: "Priya", email: "t@opd.local", role: "staff" });
    if (isPrepPath(path) && req.method() === "POST") {
      const body = req.postDataJSON() as { ready: boolean };
      posts.push(body);
      if (body.ready && refuse) {
        refuse = false;
        return json({ error: "conflict", message: "Not ready yet: 1 fact is not checked yet.", failing: [] }, 409);
      }
      prep = prepBody({ prep_status: body.ready ? "ready" : "preparing", prep_set_by: "u1", prep_set_by_name: "Priya", prep_set_at: "2026-02-01T09:00:00Z" });
      return json(prep);
    }
    if (isPrepPath(path)) return json(prep);
    if (path === "/patients/p1/snapshot") return json(snapshotBody());
    if (path === "/patients/p1/summary") return json(EMPTY_SUMMARY);
    if (path === "/patients/p1/plan") return json({ next_review: null, items: [] });
    if (path === "/patients/p1/documents/identity") return json({ patient_name: "Test Patient", documents: [] });
    return json({}, 404);
  });
  await page.goto(`${BASE}/#/patients/p1/snapshot`);
  const panel = page.getByTestId("prep-panel");
  await panel.getByRole("button", { name: "Mark ready" }).click();
  await panel.getByText("Not ready yet: 1 fact is not checked yet.").waitFor();
  await panel.getByRole("button", { name: "Mark ready" }).click();
  await panel.getByText("Ready for the oncologist").waitFor();
  await panel.getByText("marked by Priya").waitFor();
  expect(await panel.getByRole("button", { name: "Mark ready" }).count()).toBe(0);
  await panel.getByRole("button", { name: "Back to preparing" }).click();
  await panel.getByText("Preparing this visit").waitFor();
  expect(posts).toEqual([{ ready: true }, { ready: true }, { ready: false }]);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Mark ready: a visit marked ready shows what has changed since, without flipping it", async () => {
  const { page, errors } = await openSnapshot("oncologist", snapshotBody(), {}, (path) =>
    isPrepPath(path)
      ? prepBody({
          prep_status: "ready", prep_set_by_name: "Priya", changed_since_ready: ["facts_checked"], can_mark_ready: false,
          items: PREP_ITEMS.map((i) => (i.key === "facts_checked" ? { ...i, ok: false, count: 1, reason: "1 fact is not checked yet" } : i)),
        })
      : undefined);
  await page.getByText("Ready for the oncologist").waitFor();
  await page.getByTestId("prep-changed").getByText(/1 fact is not checked yet/).waitFor();
  await page.getByRole("button", { name: "Back to preparing" }).waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

const requestedItem = (over: Record<string, unknown> = {}) => ({
  id: "i1", type: "test", text: "Bone scan in 2 weeks", advised_at: "2026-01-01", approx_date: "2026-01-15", stated_date: null, status: "past_advised",
  past_advised: true, matched_document: null, suggested_document: null, source_fact_id: null, source_document_id: null, outside_encounter: null,
  report_request: null, ...over,
});

test("Ask staff to find report: the oncologist asks once and sees 'Request sent to staff'; staff see the banner and clear it", async () => {
  const plan = { next_review: null, items: [requestedItem(), requestedItem({ id: "i2", text: "Blood tests", status: "report_seen", past_advised: false })] };
  const posts: string[] = [];
  const { page, errors } = await openSnapshot("oncologist", snapshotBody(), {}, (path, method) => {
    if (method === "POST" && path === "/plan-items/i1/request-report") {
      posts.push(path);
      plan.items[0] = requestedItem({ report_request: { by_id: "u1", by_name: "Rao", at: "2026-02-01T09:00:00Z" } });
      return { id: "i1", requested: true };
    }
    return undefined;
  }, EMPTY_SUMMARY, plan);
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByRole("heading", { name: "Plan items" }).waitFor();
  // Only the item without a report gets the button.
  expect(await page.getByRole("button", { name: "Ask staff to find report" }).count()).toBe(1);
  await page.getByRole("button", { name: "Ask staff to find report" }).click();
  await page.getByText("Request sent to staff").waitFor();
  await page.getByText("Staff asked to find report").waitFor();
  expect(await page.getByRole("button", { name: "Ask staff to find report" }).count()).toBe(0);
  expect(posts).toEqual(["/plan-items/i1/request-report"]);
  // The oncologist is not shown the staff banner.
  expect(await page.getByTestId("report-request-banner").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();

  const clearPosts: string[] = [];
  const staffPlan = { next_review: null, items: [requestedItem({ report_request: { by_id: "u2", by_name: "Rao", at: "2026-02-01T09:00:00Z" } })] };
  const staffView = await openSnapshot("staff", snapshotBody(), {}, (path, method) => {
    if (method === "POST" && path === "/plan-items/i1/clear-report-request") {
      clearPosts.push(path);
      staffPlan.items[0] = requestedItem();
      return { id: "i1", requested: false };
    }
    return undefined;
  }, EMPTY_SUMMARY, staffPlan);
  const banner = staffView.page.getByTestId("report-request-banner");
  await banner.getByText('Requested by Dr. Rao: find report for "Bone scan in 2 weeks"').waitFor();
  expect(await staffView.page.getByRole("button", { name: "Ask staff to find report" }).count()).toBe(0);
  await banner.getByRole("button", { name: "Mark found / clear" }).click();
  await banner.waitFor({ state: "detached" });
  expect(clearPosts).toEqual(["/plan-items/i1/clear-report-request"]);
  // The same banner shows on the Plan screen.
  staffPlan.items[0] = requestedItem({ report_request: { by_id: "u2", by_name: "Rao", at: "2026-02-01T09:00:00Z" } });
  await staffView.page.getByRole("button", { name: "Plan", exact: true }).click();
  await staffView.page.getByTestId("report-request-banner").waitFor();
  expect(staffView.errors).toEqual([]);
  await staffView.page.close();
}, 30_000);

// --- M3-11: patient shell and document pane ---
const PANE_TEXT = "CEA 4.2 ng/mL\nPSA 1.1 ng/mL\nCA-125 30 U/mL";

// Extra API answers for the pane: a document with one page (3) of text, and facts f1/f2/f9 pointing at the PSA line.
function paneRoutes(overrides: Record<string, unknown> = {}, fact: Record<string, unknown> = {}) {
  return (path: string) => {
    if (path in overrides) return overrides[path];
    const m = path.match(/^\/documents\/([^/]+)(\/facts|\/file)?$/);
    if (!m) return undefined;
    const document = {
      id: m[1], patient_id: "p1", visit_id: "v2", file_ref: "x", document_type: "blood", source_origin: "own_hospital",
      uploaded_by: "u1", uploaded_at: "2026-02-01T10:00:00Z", ocr_status: "done", ocr_text_ref: "x", needs_manual_date: false,
      extraction_status: "done", extraction_error: null, identity_status: null, lab_name: "Metro Labs", outside_encounter_id: null,
    };
    if (m[2] === "/file") return {};
    if (m[2] === "/facts") {
      const facts = ["f1", "f2", "f9"].map((id) => ({
        id, document_id: m[1], source_page: 3, source_location: null, source_snippet: "PSA 1.1 ng/mL", fallback_level: "exact", ...fact,
      }));
      return { document, facts, tracked_markers: [], check_summary: checkSummaryFor([]) };
    }
    return { document, ocr: { fullText: PANE_TEXT, pages: [{ pageNumber: 3, text: PANE_TEXT }] } };
  };
}

const oneFact = () => snapshotBody({ tumor_markers: [snapshotField({ fact_id: "f1", marker_name: "CEA" })] });

test("pane: collapsed by default; a fact opens it at the highlight with the exact tag; Open full page resolves; close returns focus", async () => {
  const { page, errors } = await openSnapshot("staff", oneFact(), {}, paneRoutes());
  const pane = page.getByTestId("doc-pane");
  expect(await pane.getAttribute("data-open")).toBe("false");
  expect(await page.getByRole("heading", { name: "Documents · all" }).count()).toBe(0);
  await page.getByRole("button", { name: "Open documents panel" }).waitFor();

  const opener = page.getByRole("button", { name: "View uploaded document" });
  await opener.focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("pane-provenance").getByText("Exact match · page 3").waitFor();
  expect(await pane.getAttribute("data-open")).toBe("true");
  expect(await page.getByTestId("source-highlight").textContent()).toBe("PSA 1.1 ng/mL");
  // Focus moved into the pane header.
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Documents · all");
  // The screen behind did not navigate.
  expect(await page.evaluate(() => location.hash)).toBe("#/patients/p1/snapshot");
  // The list item for this document is the selected one.
  expect(await page.getByTestId("pane-item").first().getAttribute("aria-current")).toBe("true");

  const full = page.getByRole("link", { name: "Open full page" });
  expect(await full.getAttribute("href")).toBe("#/documents/doc1/source?fact=f1");

  await page.getByRole("button", { name: "Close documents panel" }).click();
  await page.getByRole("button", { name: "Open documents panel" }).waitFor();
  expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("View uploaded document");
  expect(errors).toEqual([]);

  // The link really lands on the full-page view of that fact.
  await opener.click();
  await page.getByRole("link", { name: "Open full page" }).click();
  await page.waitForFunction(() => location.hash === "#/documents/doc1/source?fact=f1");
  await page.getByRole("heading", { name: "Source document" }).waitFor();
  await page.close();
}, 30_000);

test("pane: a snippet not found on the page shows the page without highlight and the Page tag", async () => {
  const { page, errors } = await openSnapshot("staff", oneFact(), {}, paneRoutes({}, { source_snippet: "not on this page" }));
  await page.getByRole("button", { name: "View uploaded document" }).click();
  await page.getByTestId("pane-provenance").getByText("Page · page 3", { exact: true }).waitFor();
  expect(await page.getByTestId("source-highlight").count()).toBe(0);
  await page.getByTestId("pane-page").getByText("CA-125 30 U/mL", { exact: false }).waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("pane: a document with no readable text says so and links the original file", async () => {
  const routes = paneRoutes();
  const { page, errors } = await openSnapshot("staff", oneFact(), {}, (path) => {
    if (path === "/documents/doc1") return { document: (routes(path) as any).document, ocr: null };
    return routes(path);
  });
  await page.getByRole("button", { name: "View uploaded document" }).click();
  await page.getByText("This document has no readable text; open the original file.").waitFor();
  expect(await page.getByRole("link", { name: "Open original file" }).getAttribute("href")).toBe(`${API}/documents/doc1/file`);
  expect(await page.getByTestId("pane-provenance").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

const TREE_DOCS = [
  { id: "d1", document_type: "blood", source_origin: "own_hospital", lab_name: "Metro Labs", identity_status: null, extraction_status: "done", uploaded_at: "2026-02-03T10:00:00Z", has_text: true, collected_on: "2026-02-01", reported_on: "2026-02-02", outside_facility: null },
  { id: "d2", document_type: "radiology", source_origin: "outside_cd", lab_name: null, identity_status: null, extraction_status: "done", uploaded_at: "2026-01-20T10:00:00Z", has_text: true, collected_on: null, reported_on: null, outside_facility: "Apollo" },
  { id: "d3", document_type: "prescription", source_origin: "own_hospital", lab_name: null, identity_status: null, extraction_status: "done", uploaded_at: "2026-01-10T10:00:00Z", has_text: true, collected_on: null, reported_on: null, outside_facility: null },
  { id: "d4", document_type: "other", source_origin: "outside_paper", lab_name: "City Lab", identity_status: null, extraction_status: "not_extracted", uploaded_at: "2026-01-05T10:00:00Z", has_text: false, collected_on: null, reported_on: null, outside_facility: null },
  { id: "d5", document_type: "pathology", source_origin: "own_hospital", lab_name: null, identity_status: null, extraction_status: "done", uploaded_at: "2026-01-04T10:00:00Z", has_text: true, collected_on: null, reported_on: null, outside_facility: null },
];

test("pane: the sidebar shows the patient and the document count; the tree groups Reports, Radiology, Prescriptions, Other; an Other document says it is not extracted", async () => {
  const routes = paneRoutes();
  const { page, errors } = await openSnapshot("staff", oneFact(), {}, (path) => {
    if (path === "/patients/p1/documents") return { documents: TREE_DOCS };
    if (path === "/documents/d4") return { document: { ...(routes("/documents/d4") as any).document, id: "d4", document_type: "other", extraction_status: "not_extracted" }, ocr: null };
    return routes(path);
  });
  const side = page.getByRole("navigation", { name: "Patient" });
  await side.getByText("Test Patient").waitFor();
  await side.getByText("Invasive ductal carcinoma").waitFor();
  expect(await side.getByText(/^\d+F$/).count()).toBe(1);
  await side.getByRole("button", { name: "Documents · 5" }).click();

  const labels = await page.locator(".doc-pane__group-label").allTextContents();
  expect(labels).toEqual(["Reports", "Radiology", "Prescriptions", "Other"]);
  const items = page.getByTestId("pane-item");
  expect(await items.allTextContents()).toEqual([
    "BloodMetro Labs · 2026-02-02",
    "Radiology2026-01-20 · Apollo · elsewhere",
    "Prescription2026-01-10",
    "OtherCity Lab · 2026-01-05 · outside",
    "Pathology2026-01-04",
  ]);

  await items.nth(3).click();
  await page.getByText("Not extracted in this version").waitFor();
  await page.getByRole("link", { name: "Open original file" }).waitFor();
  // No fact is selected from the tree, so there is no full-page link that could be broken.
  expect(await page.getByRole("link", { name: "Open full page" }).count()).toBe(0);
  expect(await items.nth(3).getAttribute("aria-current")).toBe("true");
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("pane: below 1180px it is an overlay with a backdrop opened from the sidebar; Escape and the backdrop close it; above 1180px there is no backdrop", async () => {
  const { page, errors } = await openSnapshot("staff", oneFact(), {}, paneRoutes());
  await page.setViewportSize({ width: 1000, height: 800 });
  const sideButton = page.getByRole("navigation", { name: "Patient" }).getByRole("button", { name: /^Documents/ });
  // No rail (and no reserved third column) below 1180px; the sidebar button is the way in.
  expect(await page.getByRole("button", { name: "Open documents panel" }).isVisible()).toBe(false);
  await sideButton.click();
  const pane = page.getByTestId("doc-pane");
  await pane.getByRole("heading", { name: "Documents · all" }).waitFor();
  const box = (await pane.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(400);
  expect(Math.round(box.x + box.width)).toBe(1000);
  expect(await pane.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  expect(await page.getByTestId("doc-pane-backdrop").isVisible()).toBe(true);
  await page.keyboard.press("Escape");
  await pane.getByRole("heading", { name: "Documents · all" }).waitFor({ state: "detached" });

  await sideButton.click();
  await page.mouse.click(100, 400);
  await pane.getByRole("heading", { name: "Documents · all" }).waitFor({ state: "detached" });

  await page.setViewportSize({ width: 1400, height: 800 });
  await page.getByRole("button", { name: "Open documents panel" }).click();
  await pane.getByRole("heading", { name: "Documents · all" }).waitFor();
  expect(await pane.evaluate((el) => getComputedStyle(el).position)).not.toBe("fixed");
  expect(await page.getByTestId("doc-pane-backdrop").isVisible()).toBe(false);
  expect(await pane.getAttribute("role")).toBeNull();
  await page.keyboard.press("Escape");
  expect(await pane.getAttribute("data-open")).toBe("true");
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("pane overlay: it is a modal dialog, Tab and Shift+Tab stay inside, the rest is inert, focus returns to the opener", async () => {
  const { page, errors } = await openSnapshot("staff", oneFact(), {}, (path) => (path === "/patients/p1/documents" ? { documents: TREE_DOCS } : paneRoutes()(path)));
  await page.setViewportSize({ width: 1000, height: 800 });
  const opener = page.getByRole("navigation", { name: "Patient" }).getByRole("button", { name: /^Documents/ });
  await opener.focus();
  await page.keyboard.press("Enter");
  const pane = page.getByTestId("doc-pane");
  await pane.getByRole("heading", { name: "Documents · all" }).waitFor();
  expect(await pane.getAttribute("role")).toBe("dialog");
  expect(await pane.getAttribute("aria-modal")).toBe("true");
  expect(await pane.getAttribute("aria-label")).toBe("Documents");
  expect(await page.evaluate(() => (document.querySelector(".patient-shell__main") as any).inert)).toBe(true);
  expect(await page.evaluate(() => (document.querySelector(".patient-shell__side") as any).inert)).toBe(true);
  expect(await page.locator(".patient-shell__main").getAttribute("aria-hidden")).toBe("true");

  const inside = () => page.evaluate(() => !!document.activeElement?.closest("[data-testid=doc-pane]"));
  for (let i = 0; i < 14; i++) { await page.keyboard.press("Tab"); expect(await inside()).toBe(true); }
  for (let i = 0; i < 14; i++) { await page.keyboard.press("Shift+Tab"); expect(await inside()).toBe(true); }
  // Shift+Tab from the first control wraps to the last item.
  await page.getByRole("button", { name: "Close documents panel" }).focus();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("pane-item");

  await page.keyboard.press("Escape");
  await pane.getByRole("heading", { name: "Documents · all" }).waitFor({ state: "detached" });
  expect(await page.evaluate(() => (document.querySelector(".patient-shell__main") as any).inert)).toBe(false);
  expect(await opener.evaluate((el) => el === document.activeElement)).toBe(true);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("pane: a held document in the tree shows only the notice, requests nothing about it, and the oncologist gets a Snapshot link", async () => {
  const held = { ...TREE_DOCS[0]!, id: "h1", identity_status: "awaiting_oncologist" };
  const sneaky = { ...TREE_DOCS[1]!, id: "h2" };
  const routes = paneRoutes();
  const stub = (path: string) => {
    if (path === "/patients/p1/documents") return { documents: [held, sneaky] };
    // The server withholds the text of a held document and says so.
    if (path === "/documents/h2") return { document: (routes(path) as any).document, ocr: null, held: true };
    return routes(path);
  };
  for (const role of ["staff", "oncologist"] as const) {
    const { page, errors } = await openSnapshot(role, oneFact(), {}, stub);
    const requested: string[] = [];
    page.on("request", (r) => requested.push(new URL(r.url()).pathname));
    await page.getByRole("navigation", { name: "Patient" }).getByRole("button", { name: /^Documents/ }).click();
    expect(await page.getByTestId("pane-item").first().textContent()).toContain("held for identity");
    for (const index of [0, 1]) {
      await page.getByTestId("pane-item").nth(index).click();
      await page.getByTestId("pane-held").getByText("Held for identity check. Not part of the record until the oncologist decides.").waitFor();
      expect(await page.getByTestId("pane-page").count()).toBe(0);
      expect(await page.getByTestId("source-highlight").count()).toBe(0);
      expect(await page.getByTestId("pane-provenance").count()).toBe(0);
      expect(await page.getByRole("link", { name: "Open original file" }).count()).toBe(0);
      expect(await page.getByRole("link", { name: "Open full page" }).count()).toBe(0);
      expect(await page.getByText("CEA 4.2 ng/mL").count()).toBe(0);
      expect(await page.getByRole("link", { name: "Review on the Snapshot" }).count()).toBe(role === "oncologist" ? 1 : 0);
    }
    expect(requested).not.toContain("/documents/h1");
    expect(requested).not.toContain("/documents/h1/file");
    expect(requested).not.toContain("/documents/h2/file");
    if (role === "oncologist") expect(await page.getByRole("link", { name: "Review on the Snapshot" }).getAttribute("href")).toBe("#/patients/p1/snapshot");
    expect(errors).toEqual([]);
    await page.close();
  }
}, 30_000);

test("pane: opening at a fact scrolls the highlight into view", async () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} filler text`);
  lines[250] = "PSA 1.1 ng/mL";
  const long = lines.join("\n");
  const base = paneRoutes();
  const { page, errors } = await openSnapshot("staff", oneFact(), {}, (path) => {
    if (path === "/documents/doc1") return { document: (base(path) as any).document, ocr: { fullText: long, pages: [{ pageNumber: 3, text: long }] }, held: false };
    return base(path);
  });
  await page.getByRole("button", { name: "View uploaded document" }).click();
  await page.getByTestId("pane-provenance").getByText("Exact match · page 3").waitFor();
  await page.waitForFunction(() => {
    const m = document.querySelector("[data-testid=source-highlight]")!.getBoundingClientRect();
    return m.top >= 0 && m.bottom <= window.innerHeight;
  });
  const m = (await page.getByTestId("source-highlight").boundingBox())!;
  const pane = (await page.getByTestId("doc-pane").boundingBox())!;
  expect(m.y).toBeGreaterThanOrEqual(pane.y);
  expect(m.y + m.height).toBeLessThanOrEqual(pane.y + pane.height);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("pane: a snippet that repeats on the page marks the occurrence nearest the stored location and says how many similar lines", async () => {
  const text = "PSA 1.1 ng/mL\nCEA 4\nPSA 1.1 ng/mL\nCEA 5";
  const base = paneRoutes({}, { source_location: "chars 22-35" });
  const { page, errors } = await openSnapshot("staff", oneFact(), {}, (path) =>
    path === "/documents/doc1" ? { document: (base(path) as any).document, ocr: { fullText: text, pages: [{ pageNumber: 3, text }] }, held: false } : base(path));
  await page.getByRole("button", { name: "View uploaded document" }).click();
  await page.getByTestId("pane-provenance").getByText("Page · page 3 · 2 similar lines").waitFor();
  const before = await page.evaluate(() => document.querySelector("[data-testid=source-highlight]")!.previousSibling!.textContent!.length);
  expect(before).toBe(20);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("pane: a fact whose page is not in the OCR shows 'Document' alone, with no highlight and no invented page", async () => {
  const { page, errors } = await openSnapshot("staff", oneFact(), {}, paneRoutes({}, { source_page: 7 }));
  await page.getByRole("button", { name: "View uploaded document" }).click();
  await page.getByTestId("pane-provenance").getByText("Document", { exact: true }).waitFor();
  expect(await page.getByTestId("source-highlight").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("responsive: at 375px the shell stacks and the screen is full width; at 1000px there is no third column even with the pane open", async () => {
  const { page, errors } = await openSnapshot("staff", oneFact(), {}, paneRoutes());
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const columns = () => page.locator(".patient-shell").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  await page.setViewportSize({ width: 375, height: 800 });
  const main = page.locator(".patient-shell__main");
  expect((await main.boundingBox())!.width).toBeGreaterThanOrEqual(300);
  expect((await page.locator(".patient-shell__side").boundingBox())!.y).toBeLessThan((await main.boundingBox())!.y);
  expect(await columns()).toBe(1);
  expect(await noSideScroll()).toBe(true);
  await page.getByRole("navigation", { name: "Patient" }).getByRole("button", { name: /^Documents/ }).click();
  await page.getByTestId("doc-pane").getByRole("heading", { name: "Documents · all" }).waitFor();
  expect(await noSideScroll()).toBe(true);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1000, height: 800 });
  expect(await columns()).toBe(2);
  const wide = (await main.boundingBox())!.width;
  await page.getByRole("navigation", { name: "Patient" }).getByRole("button", { name: /^Documents/ }).click();
  await page.getByTestId("doc-pane").getByRole("heading", { name: "Documents · all" }).waitFor();
  expect(await columns()).toBe(2);
  expect((await main.boundingBox())!.width).toBe(wide);
  expect(wide).toBeGreaterThanOrEqual(600);
  expect(await noSideScroll()).toBe(true);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

// A test that fails these two GETs on purpose really gets the failure (the default only fills in unstubbed paths).
for (const status of [500, 404]) {
  test(`sidebar: when the patient request returns ${status} it says the details could not be loaded, offers Retry, and the screen still works`, async () => {
    const { page, errors } = await openSnapshot("staff", oneFact(), {}, paneRoutes());
    let calls = 0;
    await page.route(`${API}/patients/p1`, (route) =>
      ++calls === 1
        ? route.fulfill({ status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" }, body: JSON.stringify({ error: "x", message: "nope" }) })
        : route.fallback());
    errors.length = 0;
    await page.reload();
    const side = page.getByRole("navigation", { name: "Patient" });
    await side.getByText("Patient details could not be loaded.").waitFor();
    expect(await side.getByText("(unnamed patient)").count()).toBe(0);
    await page.getByRole("heading", { name: "Test Patient" }).waitFor();
    await side.getByRole("button", { name: "Retry" }).click();
    await side.getByText("Test Patient").waitFor();
    expect(await side.getByText("Patient details could not be loaded.").count()).toBe(0);
    // Only the deliberately failed request is logged.
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.filter((e) => !e.includes(`status of ${status}`))).toEqual([]);
    await page.close();
  }, 30_000);
}

test("pane: a failed document list shows Retry and does not block the screen; Retry loads it", async () => {
  const { page } = await openSnapshot("staff", oneFact(), {}, (path) => (path === "/patients/p1/documents" ? { documents: TREE_DOCS } : paneRoutes()(path)));
  let calls = 0;
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };
  await page.route(`${API}/patients/p1/documents`, (route) =>
    ++calls === 1
      ? route.fulfill({ status: 500, contentType: "application/json", headers: cors, body: JSON.stringify({ error: "boom", message: "Documents could not be loaded." }) })
      : route.fallback());
  await page.reload();
  // The Snapshot is usable while the list failed; the sidebar count is simply absent.
  await page.getByRole("heading", { name: "Test Patient" }).waitFor();
  await page.getByRole("navigation", { name: "Patient" }).getByRole("button", { name: "Documents", exact: true }).click();
  await page.getByText("Documents could not be loaded.").waitFor();
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByTestId("pane-item").first().waitFor();
  await page.getByRole("button", { name: "Documents · 5" }).waitFor();
  await page.close();
}, 30_000);

test("sidebar: links go to the patient's screens and the current one is marked", async () => {
  const { page, errors } = await openSnapshot("staff", oneFact(), {}, paneRoutes());
  const side = page.getByRole("navigation", { name: "Patient" });
  const hrefs = await side.getByRole("link").evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute("href")]));
  expect(hrefs).toEqual([
    ["Summary", "#/patients/p1/summary"],
    ["Snapshot · this visit", "#/patients/p1/snapshot"],
    ["History", "#/patients/p1/history"],
    ["Plan", "#/patients/p1/plan"],
    ["Markers", "#/patients/p1/markers"],
    ["Edit info", "#/patients/p1/edit"],
  ]);
  expect(await side.locator("[aria-current=page]").allTextContents()).toEqual(["Snapshot · this visit"]);
  await side.getByRole("link", { name: "Summary" }).click();
  await page.waitForFunction(() => location.hash === "#/patients/p1/summary");
  await side.locator("[aria-current=page]").getByText("Summary").waitFor();
  await side.getByRole("link", { name: "Plan" }).click();
  await page.waitForFunction(() => location.hash === "#/patients/p1/plan");
  await side.locator("[aria-current=page]").getByText("Plan").waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

// ---- M3-13: dictation audio pilot (AM-02) ----

// A tiny valid WAV, so a played note really loads from the stubbed audio endpoint.
const TINY_WAV = (() => {
  const data = Buffer.alloc(800);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28);
  h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
})();

async function openDictationPage(
  hash: string,
  features: { dictation: boolean } | undefined,
  visits: unknown[] = [{ id: "v2", visit_date: "2026-02-01", document_count: 1, fact_count: 1, signed_off_count: 0 }],
  opts: { notes?: unknown[]; postStatus?: number } = {},
) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  // A fake microphone and recorder: start() then stop() yields one 100-byte audio/webm chunk.
  await page.addInitScript(() => {
    // Every fake track is counted: __tracks.opened vs __tracks.stopped. __gum.calls counts getUserMedia calls and
    // __gum.delay holds each one open (a pending permission prompt). __chunkBytes > 0 makes a recording emit a chunk
    // of that size every 20 ms (a long take); __recorderOptions keeps what the page passed to the recorder.
    const w = window as any;
    w.__tracks = { opened: 0, stopped: 0 };
    w.__gum = { calls: 0, delay: 0 };
    w.__chunkBytes = 0;
    w.__recorderOptions = null;
    (navigator.mediaDevices as any).getUserMedia = async () => {
      w.__gum.calls++;
      if (w.__gum.delay) await new Promise((r) => setTimeout(r, w.__gum.delay));
      w.__tracks.opened++;
      let stopped = false;
      return { getTracks: () => [{ stop() { if (!stopped) { stopped = true; w.__tracks.stopped++; } } }] };
    };
    w.MediaRecorder = class {
      static isTypeSupported(t: string) { return t === "audio/webm"; }
      mimeType = "audio/webm"; state = "inactive"; ondataavailable: any = null; onstop: any = null; timer: any = null;
      constructor(_stream: unknown, options: unknown) { w.__recorderOptions = options; }
      start() {
        this.state = "recording";
        if (w.__chunkBytes > 0) {
          this.timer = setInterval(() => {
            if (this.state === "recording") this.ondataavailable?.({ data: new Blob([new Uint8Array(w.__chunkBytes)], { type: "audio/webm" }) });
          }, 20);
        }
      }
      stop() {
        if (this.state !== "recording") return;
        this.state = "inactive";
        clearInterval(this.timer);
        this.ondataavailable?.({ data: new Blob([new Uint8Array(100)], { type: "audio/webm" }) });
        this.onstop?.();
      }
    };
  });
  const requests: { method: string; path: string; type: string | null; search: string }[] = [];
  const cors = { "Access-Control-Allow-Origin": BASE, "Access-Control-Allow-Credentials": "true" };
  await page.route(`${API}/**`, (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (req.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { ...cors, "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" } });
    }
    requests.push({ method: req.method(), path, type: req.headers()["content-type"] ?? null, search: url.search });
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (path === "/auth/me") return json({ id: "u1", name: "Test", email: "t@opd.local", role: features ? "oncologist" : "staff", ...(features ? { features } : {}) });
    if (path === "/patients/p1") return json(SHELL_PATIENT);
    if (path === "/patients/p1/documents") return json({ documents: SHELL_DOCUMENTS });
    if (path === "/patients/p1/visits") return json(visits);
    if (path === "/patients/p1/outside-encounters") return json([]);
    if (path === "/visits/v2/dictation" && req.method() === "POST") {
      if (opts.postStatus && opts.postStatus !== 201) return json({ error: "too_large", message: "The recording is larger than 25 MB." }, opts.postStatus);
      return json({ id: "d2", duration_seconds: 1 }, 201);
    }
    if (path === "/visits/v2/dictations") return json(opts.notes ?? [{ id: "d1", duration_seconds: 75, created_at: "2026-02-01T10:00:00Z", recorded_by_name: "Test" }]);
    if (path === "/dictations/d1/audio") return route.fulfill({ status: 200, contentType: "audio/wav", headers: cors, body: TINY_WAV });
    if (path === "/patients/p1/snapshot") return json(snapshotBody());
    if (path === "/patients/p1/summary") return json(EMPTY_SUMMARY);
    if (path === "/patients/p1/plan") return json({ next_review: null, items: [] });
    if (isPrepPath(path)) return json(prepBody());
    if (path === "/patients/p1/documents/identity") return json({ patient_name: "Test Patient", documents: [] });
    return json({}, 404);
  });
  await page.goto(`${BASE}/#${hash}`);
  return { page, errors, requests };
}

const dictationRequests = (reqs: { path: string }[]) => reqs.filter((r) => /dictation/.test(r.path));

test("Dictation: record, stop, play the take, save to the visit; History shows the tag and the play button hits the audio endpoint", async () => {
  const { page, errors, requests } = await openDictationPage("/patients/p1/history", { dictation: true }, [
    { id: "v2", visit_date: "2026-02-01", document_count: 1, fact_count: 1, signed_off_count: 0, dictated_note_seconds: 75 },
    { id: "v1", visit_date: "2026-01-01", document_count: 0, fact_count: 0, signed_off_count: 0, dictated_note_seconds: null },
  ], {
    notes: [
      { id: "d1", duration_seconds: 75, created_at: "2026-02-01T10:00:00Z", recorded_by_name: "Test" },
      { id: "d0", duration_seconds: 20, created_at: "2026-02-01T09:00:00Z", recorded_by_name: "Test" },
    ],
  });
  const side = page.getByRole("navigation", { name: "Patient" });
  await side.getByText("Dictation pilot · your own note only · no transcript is made").waitFor();
  expect(await side.getByText(/Record consult/).count()).toBe(0);
  await side.getByRole("button", { name: "Record dictated note" }).click();
  await side.getByRole("timer").waitFor();
  await page.waitForTimeout(1200);
  await side.getByRole("button", { name: "Stop" }).click();
  // The take can be heard before it is saved; nothing is sent yet.
  await side.locator("audio").waitFor();
  expect(requests.filter((r) => r.method === "POST")).toEqual([]);
  await side.getByRole("button", { name: "Save to this visit" }).click();
  await side.getByText("Saved to this visit.").waitFor();
  const post = requests.find((r) => r.method === "POST" && r.path === "/visits/v2/dictation")!;
  expect(post.type).toBe("audio/webm");
  expect(Number(new URLSearchParams(post.search).get("duration_seconds"))).toBeGreaterThanOrEqual(1);
  // Discard drops a take without sending it.
  await side.getByRole("button", { name: "Record dictated note" }).click();
  await side.getByRole("button", { name: "Stop" }).click();
  await side.getByRole("button", { name: "Discard" }).click();
  await side.getByRole("button", { name: "Record dictated note" }).waitFor();
  expect(requests.filter((r) => r.method === "POST").length).toBe(1);

  // History: the tag on the visit that has a note only, and no audio request until Play.
  await page.getByText("Dictated note 1:15").waitFor();
  expect(await page.getByText(/Dictated note/).count()).toBe(1);
  expect(requests.some((r) => r.path === "/dictations/d1/audio")).toBe(false);
  // The list of the visit's notes is fetched only when "Notes" is clicked.
  expect(requests.some((r) => r.path === "/visits/v2/dictations")).toBe(false);
  await page.getByRole("button", { name: "Notes" }).click();
  await page.getByText("Dictated note 0:20").waitFor();
  expect(await page.getByRole("button", { name: "Play", exact: true }).count()).toBe(2);
  expect(requests.some((r) => /\/audio$/.test(r.path))).toBe(false);
  const audioRequest = page.waitForRequest((r) => new URL(r.url()).pathname === "/dictations/d1/audio");
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await audioRequest;
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

// The page's tracks, and how many it opened: used to prove the microphone is always released.
const tracks = (page: import("playwright").Page) => page.evaluate(() => (window as any).__tracks as { opened: number; stopped: number });

test("Dictation: the recorder asks for a low bitrate, stops tracks on stop, discard and save, and the size limit auto-stops a long take", async () => {
  const { page, errors, requests } = await openDictationPage("/patients/p1/history", { dictation: true });
  const side = page.getByRole("navigation", { name: "Patient" });
  const record = side.getByRole("button", { name: "Record dictated note" });
  await record.waitFor();

  // Stop: tracks stopped, options carry the bitrate.
  await record.click();
  await side.getByRole("button", { name: "Stop" }).click();
  await side.locator("audio").waitFor();
  expect(await tracks(page)).toEqual({ opened: 1, stopped: 1 });
  const opts = await page.evaluate(() => (window as any).__recorderOptions);
  expect(opts.audioBitsPerSecond).toBe(32000);
  expect(opts.bitsPerSecond).toBe(32000);
  await side.getByRole("button", { name: "Discard" }).click();

  // Size limit: 12 MB chunks pass 23 MB on the second one; recording stops by itself with a plain message.
  await page.evaluate(() => { (window as any).__chunkBytes = 12 * 1024 * 1024; });
  await record.click();
  await side.getByText("Stopped at the size limit. Save this note and start another.").waitFor();
  await side.getByRole("button", { name: "Save to this visit" }).waitFor();
  expect(await tracks(page)).toEqual({ opened: 2, stopped: 2 });
  await side.getByRole("button", { name: "Save to this visit" }).click();
  await side.getByText("Saved to this visit.").waitFor();
  expect(requests.filter((r) => r.method === "POST").length).toBe(1);
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Dictation: a too-large response says so and offers no retry", async () => {
  const { page, errors } = await openDictationPage("/patients/p1/history", { dictation: true }, undefined, { postStatus: 413 });
  const side = page.getByRole("navigation", { name: "Patient" });
  await side.getByRole("button", { name: "Record dictated note" }).click();
  await side.getByRole("button", { name: "Stop" }).click();
  await side.getByRole("button", { name: "Save to this visit" }).click();
  await side.getByText("This recording is too large to save. Record a shorter note.").waitFor();
  expect(await side.getByRole("button", { name: "Save to this visit" }).count()).toBe(0);
  await side.getByRole("button", { name: "Record dictated note" }).waitFor();
  expect(errors.filter((e) => !/413/.test(e))).toEqual([]);
  await page.close();
}, 30_000);

test("Dictation: a second click while the permission prompt is pending starts nothing more, and leaving the screen releases the microphone", async () => {
  const { page } = await openDictationPage("/patients/p1/history", { dictation: true });
  const side = page.getByRole("navigation", { name: "Patient" });
  const record = side.getByRole("button", { name: "Record dictated note" });
  await record.waitFor();
  await page.evaluate(() => { (window as any).__gum.delay = 600; });
  await record.click();
  expect(await record.isDisabled()).toBe(true);
  await record.click({ force: true, noWaitAfter: true, timeout: 500 }).catch(() => {});
  // Leave before the prompt resolves: the stream that arrives late is stopped at once and no recorder starts.
  await page.evaluate(() => { location.hash = "#/patients"; });
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as any).__gum.calls)).toBe(1);
  expect(await tracks(page)).toEqual({ opened: 1, stopped: 1 });
  await page.close();
}, 30_000);

test("Dictation: leaving while recording stops the tracks, and a beforeunload warning is armed while a take is held", async () => {
  const { page } = await openDictationPage("/patients/p1/history", { dictation: true });
  const side = page.getByRole("navigation", { name: "Patient" });
  await side.getByRole("button", { name: "Record dictated note" }).click();
  await side.getByRole("timer").waitFor();
  const prevented = () => page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  expect(await prevented()).toBe(true);
  await page.evaluate(() => { location.hash = "#/patients"; });
  await page.waitForTimeout(300);
  expect(await tracks(page)).toEqual({ opened: 1, stopped: 1 });
  expect(await prevented()).toBe(false);
  await page.close();
}, 30_000);

test("Dictation: microphone denied and unsupported browser give plain messages", async () => {
  const { page } = await openDictationPage("/patients/p1/history", { dictation: true });
  const side = page.getByRole("navigation", { name: "Patient" });
  await side.getByRole("button", { name: "Record dictated note" }).waitFor();
  await page.evaluate(() => {
    (navigator.mediaDevices as any).getUserMedia = async () => { throw new DOMException("no", "NotAllowedError"); };
  });
  await side.getByRole("button", { name: "Record dictated note" }).click();
  await side.getByText(/Microphone access was denied/).waitFor();
  await page.evaluate(() => { delete (window as any).MediaRecorder; });
  await side.getByRole("button", { name: "Record dictated note" }).click();
  await side.getByText("This browser cannot record audio.").waitFor();
  await page.close();
}, 30_000);

test("Dictation: the Snapshot lists the visit's notes; the player requests nothing until played, then hits the audio endpoint", async () => {
  const { page, errors, requests } = await openDictationPage("/patients/p1/snapshot", { dictation: true });
  const notes = page.getByTestId("dictation-notes");
  await notes.getByText("Dictated note · 1:15").waitFor();
  expect(await notes.locator("audio").getAttribute("preload")).toBe("none");
  await page.waitForTimeout(300);
  expect(requests.some((r) => r.path === "/dictations/d1/audio")).toBe(false);
  const audioRequest = page.waitForRequest((r) => new URL(r.url()).pathname === "/dictations/d1/audio");
  await notes.locator("audio").evaluate((a: HTMLAudioElement) => a.play().catch(() => {}));
  await audioRequest;
  expect(errors).toEqual([]);
  await page.close();
}, 30_000);

test("Dictation: a staff session (no features) shows none of it and makes no dictation request", async () => {
  for (const hash of ["/patients/p1/history", "/patients/p1/snapshot"]) {
    const { page, errors, requests } = await openDictationPage(hash, undefined);
    await page.getByRole("navigation", { name: "Patient" }).waitFor();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    expect(await page.getByText(/dictat/i).count()).toBe(0);
    expect(await page.getByRole("button", { name: /Record/ }).count()).toBe(0);
    expect(await page.locator("audio").count()).toBe(0);
    expect(dictationRequests(requests)).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  }
}, 30_000);

test("Dictation: a session whose features.dictation is false shows none of it either", async () => {
  const { page, requests } = await openDictationPage("/patients/p1/history", { dictation: false });
  await page.getByRole("navigation", { name: "Patient" }).waitFor();
  await page.waitForLoadState("networkidle");
  expect(await page.getByText(/dictat/i).count()).toBe(0);
  expect(dictationRequests(requests)).toEqual([]);
  await page.close();
}, 30_000);
