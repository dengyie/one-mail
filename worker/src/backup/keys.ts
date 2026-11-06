/**
 * Pure naming/selection helpers for D1 backups. No runtime imports so the
 * module can be unit-tested with plain `node --test`.
 */

export const BACKUP_KINDS = ["daily", "weekly", "monthly"] as const;

export type BackupKind = (typeof BACKUP_KINDS)[number];

export const BACKUP_OBJECT_PREFIX = "d1";

export function isBackupKind(value: unknown): value is BackupKind {
    return typeof value === "string" && (BACKUP_KINDS as readonly string[]).includes(value);
}

function utcDateString(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

/** `d1/<kind>/YYYY-MM-DD.sql` — the date is the UTC run date. */
export function backupObjectKey(kind: BackupKind, date: Date = new Date()): string {
    return `${BACKUP_OBJECT_PREFIX}/${kind}/${utcDateString(date)}.sql`;
}

/** Parses the UTC date out of a backup key, or null when it is not ours. */
export function backupKeyDate(key: string): Date | null {
    const match = /^d1\/(daily|weekly|monthly)\/(\d{4})-(\d{2})-(\d{2})\.sql$/.exec(key);
    if (!match) return null;
    const [, , year, month, day] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * One export per day, with a weekly snapshot on Mondays and a monthly snapshot
 * on the first of the month (UTC). Daily always runs so there is never a gap.
 */
export function selectBackupKind(now: Date = new Date()): BackupKind {
    if (now.getUTCDate() === 1) return "monthly";
    if (now.getUTCDay() === 1) return "weekly";
    return "daily";
}
