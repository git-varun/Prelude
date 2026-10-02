import index from "../index.html";

// Runtime config for the browser. `process.env` doesn't exist client-side and
// Bun only inlines env vars that are set at process start, so the one public
// value the client needs is served explicitly; nothing else leaks to the bundle.
const apiUrl = process.env.PUBLIC_API_URL || "http://localhost:3001";

const server = Bun.serve({
  port: Number(process.env.WEB_PORT ?? 3000),
  routes: {
    "/": index,
    "/config.json": () => Response.json({ apiUrl }, { headers: { "Cache-Control": "no-store" } }),
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Prelude web app listening on http://localhost:${server.port}`);
