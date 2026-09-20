// The web app (apps/web) is served from a different port than the API in
// dev, so this is a genuine cross-origin request even though both run on
// localhost. Credentialed requests need an explicit allowed origin (not a
// wildcard) plus Allow-Credentials, and a handled OPTIONS preflight.
const ALLOWED_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

type AnyHandler = (...args: any[]) => Promise<Response> | Response;

function withCors<H extends AnyHandler>(handler: H): H {
  return (async (...args: Parameters<H>) => {
    const res = await handler(...args);
    const headers = new Headers(res.headers);
    for (const [key, value] of Object.entries(corsHeaders())) {
      headers.set(key, value);
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }) as H;
}

function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/** Wraps a { GET, POST, ... } route method map with CORS headers + an OPTIONS preflight handler. */
export function cors<T extends Record<string, AnyHandler>>(methods: T): T & { OPTIONS: AnyHandler } {
  const wrapped: Record<string, AnyHandler> = { OPTIONS: corsPreflight };
  for (const [method, handler] of Object.entries(methods)) {
    wrapped[method] = withCors(handler);
  }
  return wrapped as T & { OPTIONS: AnyHandler };
}
