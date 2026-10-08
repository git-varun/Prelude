import { login, logout, me } from "./routes/auth";
import { createUser } from "./routes/users";
import { createPatient, listPatients, getPatient, updatePatient, addMarker, getPatientSnapshot, getMarkerTrend } from "./routes/patients";
import { createOrOpenVisit, listVisits } from "./routes/visits";
import { uploadDocument, getDocument, getDocumentFile } from "./routes/documents";
import { getDocumentFacts, patchFact, signOffFact, reopenFact } from "./routes/facts";
import { getConflict, annotateConflict, resolveConflict } from "./routes/conflicts";
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
      PATCH: requireRole(["staff", "oncologist"], updatePatient),
    }),
    "/patients/:id/markers": cors({
      POST: requireRole(["staff", "oncologist"], addMarker),
    }),
    "/patients/:id/snapshot": cors({
      GET: requireRole(["staff", "oncologist"], getPatientSnapshot),
    }),
    "/patients/:id/markers/:trackedMarkerId/trend": cors({
      GET: requireRole(["staff", "oncologist"], getMarkerTrend),
    }),
    "/patients/:id/visits": cors({
      GET: requireRole(["staff", "oncologist"], listVisits),
      POST: requireRole(["staff", "oncologist"], createOrOpenVisit),
    }),
    "/patients/:id/documents": cors({
      POST: requireRole(["staff", "oncologist"], uploadDocument),
    }),
    "/documents/:id": cors({
      GET: requireRole(["staff", "oncologist"], getDocument),
    }),
    "/documents/:id/file": cors({
      GET: requireRole(["staff", "oncologist"], getDocumentFile),
    }),
    "/documents/:id/facts": cors({
      GET: requireRole(["staff", "oncologist"], getDocumentFacts),
    }),
    "/facts/:id": cors({
      PATCH: requireRole(["staff", "oncologist"], patchFact),
    }),
    "/facts/:id/sign-off": cors({
      POST: requireRole(["oncologist"], signOffFact),
    }),
    "/facts/:id/reopen": cors({
      POST: requireRole(["oncologist"], reopenFact),
    }),
    "/conflicts/:id": cors({
      GET: requireRole(["staff", "oncologist"], getConflict),
    }),
    "/conflicts/:id/annotate": cors({
      POST: requireRole(["staff", "oncologist"], annotateConflict),
    }),
    "/conflicts/:id/resolve": cors({
      POST: requireRole(["oncologist"], resolveConflict),
    }),
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Prelude API listening on http://localhost:${server.port}`);
