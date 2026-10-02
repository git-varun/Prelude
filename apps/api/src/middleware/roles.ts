import type { UserRole } from "@prelude/shared";
import { getAuthedUser, jsonError, type AuthedUser } from "./auth";

export type RoleHandler<Req extends Request = Request> = (req: Req, user: AuthedUser) => Promise<Response> | Response;

/**
 * Wraps a route handler so it only runs for an authenticated user whose role
 * is in `roles`. Matches the frozen spec's per-endpoint role table (§11/§12):
 * unauthenticated -> 401, wrong role -> 403. Bun's router exposes path params
 * as `req.params` (see Bun.serve route typing), so the wrapped handler reads
 * them directly off `req` rather than through a separate argument.
 */
export function requireRole<Req extends Request = Request>(roles: UserRole[], handler: RoleHandler<Req>) {
  return async (req: Req): Promise<Response> => {
    const user = await getAuthedUser(req);
    if (!user) {
      return jsonError(401, "unauthenticated", "Sign in required.");
    }
    if (!roles.includes(user.role)) {
      return jsonError(403, "forbidden", `Requires role: ${roles.join(" or ")}.`);
    }
    return handler(req, user);
  };
}
