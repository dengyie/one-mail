type UserIdentityDb = {
  prepare: (query: string) => {
    bind: (...params: unknown[]) => {
      first: (column?: string) => Promise<unknown>;
    };
  };
};

/**
 * Three-state result:
 *  - true / false: DB answered — the user exists with this identity or not.
 *  - null: the DB itself failed (timeout / transient error), so liveness is
 *    *unknown*. Callers must treat null as "temporary backend failure"
 *    (e.g. 503), never as an invalid credential — otherwise a D1 hiccup
 *    would reject a perfectly valid token and the frontend's 401 self-heal
 *    would log the user out.
 * Invalid arguments (no db / malformed id or email) are still false: those
 * tokens are structurally broken, not a backend problem.
 */
export const isActiveUser = async (
  db: UserIdentityDb | null | undefined,
  userId: unknown,
  userEmail: unknown,
): Promise<boolean | null> => {
  const validId = typeof userId === "number"
    ? Number.isInteger(userId) && userId > 0
    : typeof userId === "string" && userId.length > 0;
  if (!db || !validId || typeof userEmail !== "string" || userEmail.length === 0) {
    return false;
  }
  try {
    const row = await db.prepare(
      "SELECT id FROM users WHERE id = ? AND user_email = ?",
    ).bind(userId, userEmail).first("id");
    return row !== undefined && row !== null;
  } catch {
    return null;
  }
};
