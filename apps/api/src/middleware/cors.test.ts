import { test, expect } from "bun:test";
import { cors } from "./cors";

test("cors adds an OPTIONS preflight handler", async () => {
  const wrapped = cors({ GET: () => Response.json({ ok: true }) });
  const res = await wrapped.OPTIONS(new Request("http://localhost/test", { method: "OPTIONS" }));
  expect(res.status).toBe(204);
  expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
});

test("cors adds CORS headers to a wrapped handler's response", async () => {
  const wrapped = cors({ GET: (_req: Request) => Response.json({ ok: true }, { status: 200 }) });
  const res = await wrapped.GET(new Request("http://localhost/test"));
  expect(res.status).toBe(200);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  expect(await res.json()).toEqual({ ok: true });
});

test("cors preserves the wrapped handler's status code", async () => {
  const wrapped = cors({ GET: (_req: Request) => Response.json({ error: "not_found" }, { status: 404 }) });
  const res = await wrapped.GET(new Request("http://localhost/test"));
  expect(res.status).toBe(404);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
});
