# Admin Attachment Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an administrator attachment management tab that lists unified inbox messages containing attachments and downloads available attachment bytes from the existing VPS-backed storage path.

**Architecture:** Extend the existing unified email list query with a server-side `has_attachments=1` filter. Add an admin-only navigation route and a focused Vue view that uses the existing authenticated unified list and binary download APIs; no new storage or attachment endpoint is introduced.

**Tech Stack:** Cloudflare Worker TypeScript, Vue 3 SFC, Naive UI, existing unified API client, registry-backed i18n.

## Global Constraints

- Attachment bytes remain on the existing VPS storage service; do not add R2 or another storage provider.
- The management scope is view and download only; do not add delete or mutation controls.
- Preserve existing unified mailbox authorization and rate limiting for every list and download request.
- Update Chinese and English changelogs and all supported locale sources when adding message keys.

---

### Task 1: Filter unified email list to messages with attachments

**Files:**
- Modify: `worker/src/unified/unified_query.ts`
- Modify: `frontend/src/api/contracts.ts`

**Interfaces:**
- Consumes existing `buildEmailFilters` query parsing.
- Produces `has_attachments=1` filtering through `api.unified.listEmails`.

- [x] Add a strict `has_attachments` query condition accepting only `1` or `0`.
- [x] Add the optional field to `UnifiedListQuery`.
- [x] Keep the condition parameter-free and preserve all existing authorization scope composition.

### Task 2: Add admin attachment navigation and route dispatch

**Files:**
- Modify: `frontend/src/components/layout/AppSidebar.vue`
- Modify: `frontend/src/views/Admin.vue`
- Create: `frontend/src/views/admin/AttachmentManagement.vue`

**Interfaces:**
- Consumes `api.unified.listEmails({ has_attachments: 1, ... })` and `api.unified.downloadAttachment`.
- Produces the `/admin/attachments` route view and active sidebar state.

- [x] Add `adminAttachments` to the admin navigation at `/admin/attachments`.
- [x] Map that path to a new `attachments` admin view and render the component with an admin heading.
- [x] Implement cursor pagination, search, loading, empty, error, and refresh states.
- [x] Parse only normalized public attachment metadata and show a download control only when `downloadable` is true.
- [x] Download through the existing binary API, honor `Content-Disposition`, revoke object URLs, and surface non-cancellation errors.

### Task 3: Add localized copy and release notes

**Files:**
- Modify: `frontend/src/i18n/message-registry.ts`
- Modify: `frontend/src/i18n/locales/source/de.ts`
- Modify: `frontend/src/i18n/locales/source/es.ts`
- Modify: `frontend/src/i18n/locales/source/ja.ts`
- Modify: `frontend/src/i18n/locales/source/ptBR.ts`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG_EN.md`

**Interfaces:**
- Provides `workspace.adminAttachments`, `views.Admin.attachmentsTitle`, and `views.Admin.attachmentsSubtitle` in every supported locale.

- [x] Add translated navigation and page heading strings to the registry and additional locale files.
- [x] Add the feature entry under the current changelog version in both languages.

### Task 4: Review the implementation and verify the frontend build

**Files:**
- Review all files changed by Tasks 1-3.

- [x] Inspect the final diff for authorization, cursor reset, object URL cleanup, and localization parity.
- [ ] Run the smallest existing frontend type/build or lint verification available without adding tests.
- [x] Report any verification limitation rather than claiming unverified success.
