type UserIdentityDb = {
  prepare: (query: string) => {
    bind: (...params: unknown[]) => {
      first: (column?: string) => Promise<unknown>;
    };
  };
};

export const isActiveUser = async (
  db: UserIdentityDb | null | undefined,
  userId: unknown,
  userEmail: unknown,
): Promise<boolean> => {
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
    return false;
  }
};
