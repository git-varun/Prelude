import { login, logout, me } from "./routes/auth";
import { createUser } from "./routes/users";
import { createPatient, listPatients, getPatient, addMarker } from "./routes/patients";
import { createOrOpenVisit } from "./routes/visits";
import { uploadDocument } from "./routes/documents";
import { getDocumentFacts } from "./routes/facts";
import { requireRole } from "./middleware/roles";
import { cors } from "./middleware/cors";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3001),
  // m1-backlog B3: hard cap on request body size (documents.ts enforces the
  // same 25MB limit earlier via Content-Length/file.size for a clean 400).
  maxRequestBodySize: 25 * 1024 * 1024,
  routes: {
    "/health": () => Response.json({ ok: true }),
    "/auth/login": cors({ POST: login }),
    "/auth/logout": cors({ POST: logout }),
    "/auth/me": cors({ GET: me }),
    "/users": cors({
      POST: requireRole(["oncologist"], createUser),
    }),
    "/patients": cors({
      GET: requireRole(["staff", "oncologist"], listPatients),
      POST: requireRole(["staff", "oncologist"], createPatient),
    }),
    "/patients/:id": cors({
      GET: requireRole(["staff", "oncologist"], getPatient),
    }),
    "/patients/:id/markers": cors({
      POST: requireRole(["staff", "oncologist"], addMarker),
    }),
    "/patients/:id/visits": cors({
      POST: requireRole(["staff", "oncologist"], createOrOpenVisit),
    }),
    "/patients/:id/documents": cors({
      POST: requireRole(["staff", "oncologist"], uploadDocument),
    }),
    "/documents/:id/facts": cors({
      GET: requireRole(["staff", "oncologist"], getDocumentFacts),
    }),
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`OPD API listening on http://localhost:${server.port}`);
