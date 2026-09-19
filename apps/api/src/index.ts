import { login, logout, me } from "./routes/auth";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3001),
  routes: {
    "/health": () => Response.json({ ok: true }),
    "/auth/login": { POST: login },
    "/auth/logout": { POST: logout },
    "/auth/me": { GET: me },
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`OPD API listening on http://localhost:${server.port}`);
