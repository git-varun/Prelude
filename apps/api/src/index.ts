import { login, logout, me } from "./routes/auth";
import { createPatient, addMarker } from "./routes/patients";
import { createOrOpenVisit } from "./routes/visits";
import { requireRole } from "./middleware/roles";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3001),
  routes: {
    "/health": () => Response.json({ ok: true }),
    "/auth/login": { POST: login },
    "/auth/logout": { POST: logout },
    "/auth/me": { GET: me },
    "/patients": {
      POST: requireRole(["staff", "oncologist"], createPatient),
    },
    "/patients/:id/markers": {
      POST: requireRole(["staff", "oncologist"], addMarker),
    },
    "/patients/:id/visits": {
      POST: requireRole(["staff", "oncologist"], createOrOpenVisit),
    },
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`OPD API listening on http://localhost:${server.port}`);
