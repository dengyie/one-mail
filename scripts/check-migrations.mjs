#!/usr/bin/env node
/**
 * Migration drift gate, read-only.
 *
 * Every migration under db/ must eventually be reflected in the canonical
 * schema files (db/schema.sql for legacy-static, db/shard-schema.sql for
 * SHARD_MODE fleets). A migration that creates a table, index or trigger
 * without the same object appearing in a schema file is drift: a fresh
 * database initialized from schema.sql would silently miss that object.
 *
 * The check is text-level on object names — deliberately not a SQL parser —
 * so it can never block on exotic statements, only on missing objects.
 * Run from anywhere: `node scripts/check-migrations.mjs`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_DIR = join(ROOT, "db");
const SCHEMA_FILES = ["schema.sql", "shard-schema.sql"];
const MIGRATION_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-.*\.sql$/;

/** CREATE TABLE / INDEX / TRIGGER names, normalized (quotes stripped). */
function objectsIn(sql) {
    const objects = new Map();
    const renamedAway = new Set();
    const dropped = new Set();
    const patterns = [
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."`[\]]+)/gi,
        /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."`[\]]+)\s+ON/gi,
        /CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."`[\]]+)/gi,
    ];
    for (const pattern of patterns) {
        for (const match of sql.matchAll(pattern)) {
            const name = normalizeName(match[1]);
            objects.set(name, (match[0] || "").trim().split(/\s+/)[1] || "object");
        }
    }
    for (const match of sql.matchAll(/ALTER\s+TABLE\s+([A-Za-z0-9_."`[\]]+)\s+RENAME\s+TO\s+([A-Za-z0-9_."`[\]]+)/gi)) {
        renamedAway.add(normalizeName(match[1]));
    }
    for (const match of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z0-9_."`[\]]+)/gi)) {
        dropped.add(normalizeName(match[1]));
    }
    return { objects, renamedAway, dropped };
}

function normalizeName(raw) {
    // Drop surrounding quotes and any schema prefix: "main"."emails" -> emails.
    return raw.split(".").pop().replace(/["`[\]]/g, "");
}

function loadSchemaText() {
    return SCHEMA_FILES
        .map((name) => {
            const path = join(DB_DIR, name);
            return { name, text: readFileSync(path, "utf8") };
        })
        .reduce((acc, { text }) => `${acc}\n${text}`, "");
}

function main() {
    const schemaText = loadSchemaText();
    const known = objectsIn(schemaText).objects;

    const drift = [];
    let checked = 0;

    for (const entry of readdirSync(DB_DIR)) {
        if (!MIGRATION_PATTERN.test(entry)) continue;
        const file = join(DB_DIR, entry);
        if (!file.endsWith(".sql")) continue;
        const sql = readFileSync(file, "utf8");
        checked += 1;
        const { objects, renamedAway, dropped } = objectsIn(sql);
        for (const [name, kind] of objects) {
            // A table rebuilt through a temporary name (CREATE v2 -> RENAME) or
            // dropped as part of an idempotent rebuild is not a permanent
            // schema object; only its final name is checked.
            if (renamedAway.has(name) || dropped.has(name)) continue;
            if (!known.has(name)) {
                drift.push({ migration: entry, kind, name });
            }
        }
    }

    if (drift.length > 0) {
        console.error("Migration objects missing from the canonical schema files:");
        for (const { migration, kind, name } of drift) {
            console.error(`- ${name} (${kind}) created by ${relative(ROOT, join(DB_DIR, migration))} is absent from schema.sql / shard-schema.sql`);
        }
        console.error("\nAdd the object to db/schema.sql (and db/shard-schema.sql when the feature targets shard fleets).");
        process.exitCode = 1;
    } else {
        console.log(`Migration drift check passed (${checked} migrations; all objects in canonical schema).`);
    }
}

main();