import { getAuthedUser, jsonError, type AuthedUser } from "./auth";
import { isDictationEnabledFor } from "../services/dictation";

/**
 * Dictation routes (AM-02): 401 without a session; for anyone who is not the flagged oncologist the route does not
 * exist (404), so staff cannot detect the feature. Never 403.
 */
export function requireDictation<Req extends Request = Request>(handler: (req: Req, user: AuthedUser) => Promise<Response> | Response) {
  return async (req: Req): Promise<Response> => {
    const user = await getAuthedUser(req);
    if (!user) return jsonError(401, "unauthenticated", "Sign in required.");
    if (!isDictationEnabledFor(user)) return jsonError(404, "not_found", "Not found.");
    return handler(req, user);
  };
}
