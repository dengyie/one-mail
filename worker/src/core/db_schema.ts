type ColumnDefinition = readonly [name: string, definition: string];

async function tableColumns(db: D1Database, table: string): Promise<Set<string>> {
    const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    return new Set(results.map(column => column.name));
}

/** Table/column definitions come only from static migration code, never request input. */
export async function ensureTableColumns(
    db: D1Database,
    table: string,
    definitions: readonly ColumnDefinition[],
): Promise<string[]> {
    const existing = await tableColumns(db, table);
    const missing = definitions.filter(([name]) => !existing.has(name));
    if (!missing.length) return [];
    try {
        // One atomic D1 request: avoid one PRAGMA and network call per column.
        await db.batch(missing.map(([name, definition]) =>
            db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)));
    } catch (error) {
        if (!String(error).toLowerCase().includes('duplicate column')) throw error;
        // A racing migration may have completed the batch. Only accept that
        // result if every required column now exists; partial repair must fail.
        const repaired = await tableColumns(db, table);
        if (missing.some(([name]) => !repaired.has(name))) throw error;
        return [];
    }
    return missing.map(([name]) => name);
}
