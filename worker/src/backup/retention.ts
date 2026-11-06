/**
 * Backup retention. Keys carry their UTC run date, so pruning is a pure
 * date comparison plus bounded `list`/`delete` calls. Deletes are capped per
 * run: a cron tick must never turn into an unbounded bucket scan.
 */

import { BACKUP_KINDS, backupKeyDate, type BackupKind } from "./keys.ts";

export const RETENTION_LIST_PAGE_SIZE = 1000;
export const RETENTION_MAX_LIST_PAGES = 10;
export const RETENTION_MAX_DELETES = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export function retentionCutoff(kind: BackupKind, now: Date, retentionDays: number): Date {
    return new Date(now.getTime() - retentionDays * DAY_MS);
}

/** Pure filter: keys strictly older than the cutoff date. */
export function expiredBackupKeys(
    keys: string[],
    cutoff: Date,
): string[] {
    const cutoffDay = Date.UTC(
        cutoff.getUTCFullYear(),
        cutoff.getUTCMonth(),
        cutoff.getUTCDate(),
    );
    return keys.filter((key) => {
        const date = backupKeyDate(key);
        if (!date) return false;
        return date.getTime() < cutoffDay;
    });
}

type BucketLike = {
    list: (options: {
        prefix: string;
        cursor?: string;
        limit?: number;
    }) => Promise<{
        objects: Array<{ key: string }>;
        truncated?: boolean;
        cursor?: string;
    }>;
    delete: (keys: string[]) => Promise<void>;
};

export async function pruneBackups(
    bucket: BucketLike,
    retentionDays: Record<BackupKind, number>,
    now: Date = new Date(),
): Promise<{ deleted: number; scanned: number }> {
    let deleted = 0;
    let scanned = 0;

    for (const kind of BACKUP_KINDS) {
        if (deleted >= RETENTION_MAX_DELETES) break;
        const cutoff = retentionCutoff(kind, now, retentionDays[kind]);
        const prefix = `d1/${kind}/`;
        let cursor: string | undefined;

        for (let page = 0; page < RETENTION_MAX_LIST_PAGES; page += 1) {
            const listed = await bucket.list({
                prefix,
                cursor,
                limit: RETENTION_LIST_PAGE_SIZE,
            });
            const keys = listed.objects.map((object) => object.key);
            scanned += keys.length;
            const expired = expiredBackupKeys(keys, cutoff);
            if (expired.length > 0) {
                const room = RETENTION_MAX_DELETES - deleted;
                const toDelete = expired.slice(0, room);
                await bucket.delete(toDelete);
                deleted += toDelete.length;
            }
            if (!listed.truncated || !listed.cursor) break;
            cursor = listed.cursor;
        }
    }

    return { deleted, scanned };
}
