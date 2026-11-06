#!/usr/bin/env node
/**
 * Code file line budget, borrowed from OmniMail's scripts/check-file-lines.mjs.
 *
 * Frontend implementation files (frontend/src, .ts/.tsx/.vue) are capped at
 * 500 lines; every other code file at 600. i18n message data is exempt: the
 * locale sources and the aggregate registry are generated translation tables,
 * not implementation.
 *
 * FROZEN_OVERSIZED lets the gate land on a codebase that already has oversized
 * files without a mass rewrite. Each entry is a hard ceiling frozen at the
 * file's current size: the file may shrink but may never grow. Delete an entry
 * once the file is under the normal limit; the script reminds you when it is.
 *
 * Run from anywhere: `node scripts/check-file-lines.mjs`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LIMIT = 600;
const FRONTEND_LIMIT = 500;

const IGNORED_DIRS = new Set([
    ".git", ".turbo", ".venv", ".vite", ".wrangler", "__pycache__", "build",
    "coverage", "dist", "node_modules", "playwright-report", "test-results",
]);
const SKIPPED_FILES = new Set(["package-lock.json", "pnpm-lock.yaml"]);
const CODE_EXTENSIONS = new Set([
    ".cjs", ".css", ".html", ".js", ".jsx", ".json", ".jsonc", ".mjs", ".scss",
    ".sql", ".svg", ".ts", ".tsx", ".vue", ".yaml", ".yml",
]);
const EXEMPT_PREFIXES = ["frontend/src/i18n/"];

// path -> maximum allowed lines (frozen at the size when the gate landed).
const FROZEN_OVERSIZED = new Map([
    ["frontend/src/views/UnifiedInbox.vue", 1284],
    ["worker/src/common.ts", 1075],
    ["worker/src/unified/federation.test.mjs", 978],
    ["worker/src/mails_api/send_mail_api.ts", 961],
    ["frontend/src/views/DomainMailbox.vue", 842],
    ["worker/src/unified/federation.ts", 813],
    ["worker/src/core/d1_quota.test.mjs", 786],
    ["frontend/src/components/MailBox.vue", 775],
    ["worker/src/unified/mutation_jobs.ts", 774],
    ["worker/src/user_api/mail_accounts.ts", 710],
    ["worker/src/mails_api/send_mail_limit_utils.ts", 628],
    ["frontend/src/views/admin/Account.vue", 594],
    ["frontend/src/views/user/UserMailAccounts.vue", 583],
    ["frontend/src/components/SendBox.vue", 518],
]);

function countLines(filename) {
    const source = readFileSync(filename, "utf8");
    if (!source) return 0;
    return source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0);
}

function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory()) {
            return IGNORED_DIRS.has(entry.name) ? [] : walk(join(directory, entry.name));
        }
        if (SKIPPED_FILES.has(entry.name) || !CODE_EXTENSIONS.has(extname(entry.name))) return [];
        return [join(directory, entry.name)];
    });
}

function toRepoPath(filename) {
    return relative(ROOT, filename).split("\\").join("/");
}

function limitFor(path) {
    // Implementation code only: .vue files and TS under frontend/src.
    return /^frontend\/src\/.*\.(ts|tsx|vue)$/.test(path) ? FRONTEND_LIMIT : DEFAULT_LIMIT;
}

const files = walk(ROOT)
    .map(toRepoPath)
    .filter((path) => !EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix)));

const violations = [];
const removable = [];

for (const path of files) {
    const lines = countLines(join(ROOT, path));
    const limit = limitFor(path);
    const frozen = FROZEN_OVERSIZED.get(path);

    if (frozen !== undefined) {
        if (lines > frozen) {
            violations.push({ path, lines, limit: frozen, reason: `grew past frozen budget of ${frozen}` });
        } else if (lines <= limit) {
            removable.push({ path, lines, limit });
        }
        continue;
    }

    if (lines > limit) {
        violations.push({ path, lines, limit, reason: `exceeds the ${limit}-line limit` });
    }
}

if (violations.length > 0) {
    console.error("Code files exceed their line budget:");
    for (const { path, lines, limit, reason } of violations) {
        console.error(`- ${path}: ${lines} lines (${reason}; limit ${limit})`);
    }
    console.error("\nSplit the file, or — only for files that already exceeded the limit before this gate — add a frozen ceiling in scripts/check-file-lines.mjs.");
    process.exitCode = 1;
} else {
    console.log(
        `File line budget passed (${files.length} files; ` +
        `frontend implementations ${FRONTEND_LIMIT}, others ${DEFAULT_LIMIT}; ` +
        `${FROZEN_OVERSIZED.size} frozen).`,
    );
}

if (removable.length > 0) {
    console.log("Frozen entries that are now under the limit; remove them from FROZEN_OVERSIZED:");
    for (const { path, lines, limit } of removable) {
        console.log(`- ${path}: ${lines} lines (limit ${limit})`);
    }
}
