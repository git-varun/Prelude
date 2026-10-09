import { login, logout, me } from "./routes/auth";
import { createUser } from "./routes/users";
import { createPatient, listPatients, getPatient, updatePatient, addMarker, getPatientSnapshot, getMarkerTrend, getPatientTimeline } from "./routes/patients";
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
    "/patients/:id/timeline": cors({
      GET: requireRole(["staff", "oncologist"], getPatientTimeline),
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
  // Security review finding: this was hardcoded truthy regardless of
  // NODE_ENV, so an unhandled exception in any route returned Bun's dev-mode
  // error page (exception class/message, internal stack frames, the
  // server's absolute working directory) to the caller -- reachable even
  // unauthenticated, via a malformed /auth/login body that throws a Postgres
  // type-mismatch error. apps/web/src/server.ts already gates this the same
  // way; this brings the API in line with it.
  development: process.env.NODE_ENV === "production" ? false : { hmr: true, console: true },
  // Defense in depth alongside the NODE_ENV gate above: never let an
  // unhandled exception's message/stack reach the client, even if something
  // sets development wrong in a future change.
  error(error) {
    console.error(error);
    return new Response("Something went wrong!", { status: 500 });
  },
});

console.log(`Prelude API listening on http://localhost:${server.port}`);
