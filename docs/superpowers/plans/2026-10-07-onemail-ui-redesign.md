# One Mail workspace UI implementation plan

> **For agentic workers:** Execute this plan task-by-task in the existing isolated worktree. Use executing-plans for inline execution; no additional workers are needed.

**Goal:** Rebuild One Mail as a coherent, accessible email workspace across inbox, reading, sending, account management, and mobile screens.

**Architecture:** Keep the Vue router, credential channels, API contracts, polling limits, and sanitized email renderer. Introduce shared visual tokens and page primitives, reuse awesome-ui Vue components, and replace the main shell and inbox presentation. All preview data belongs to browser test fixtures, never application code.

**Tech Stack:** Vue 3, Naive UI, Tailwind 4, existing awesome-ui components, Vitest and Playwright.

## Global constraints

- Work in `/Users/mango/project/one-mail-ui-redesign` on `feat/onemail-ui-redesign`, based on `origin/main` at `bdb73f0`.
- UTF-8 without BOM. No primary worktree edits, dependency additions, production changes, or email sends.
- Preserve locale routes, multi-channel logout, Passkey, remote-content consent, provider mutations, and minimum 30-second polling.
- Use awesome-ui UiIcon first; missing mail-specific icons come from the existing @vicons/material dependency.
- Update both CHANGELOG.md and CHANGELOG_EN.md.

### Task 1: Workspace foundation and navigation

**Files:** `frontend/src/styles/workspace.css`, `frontend/src/theme.js`, `frontend/src/components/ui/MailIcon.vue`, `frontend/src/components/layout/AppSidebar.vue`, `frontend/src/components/layout/AppNavbar.vue`, `frontend/src/components/ai/ThemeToggle.vue`, `frontend/src/App.vue`, `frontend/src/main.js`, `frontend/src/i18n/message-registry.ts`.

**Interfaces:** Theme tokens are CSS `--mail-*` properties; the theme factory returns Naive UI overrides. MailIcon accepts `name` and `size`. Navigation uses existing locale-aware routes and preserves existing authorization visibility.

- [x] Inspect current main, status, worktrees, routed documentation, and source component inventory.
- [x] Verify baseline: `cd frontend && pnpm test` — 28 files, 198 tests passing.
- [x] Build the shared color, spacing, typography, focus, motion, and responsive styles.
- [x] Replace sidebar and navbar; expose working inbox search, compose, account, language, and theme actions.
- [x] Keep all logout credential resets and show the mobile navigation as a closable drawer.

### Task 2: Inbox and reading experience

**Files:** `frontend/src/views/UnifiedInbox.vue`, `frontend/src/views/UnifiedInboxDetail.vue`, `frontend/src/components/ui/WorkspaceEmpty.vue`, `frontend/src/components/inbox/InboxMessageRow.vue`.

**Interfaces:** InboxMessageRow receives an email and emits `open`, `star`, `read`, and `copy-code`; the parent retains all API mutations and request fences. WorkspaceEmpty receives icon, title, and description with an action slot.

- [x] Replace noisy rows with sender, subject, account, timestamp, unread state, accessible quick actions, and code copying.
- [x] Add route-backed search/filter navigation and useful loading, error, filtered-empty, and signed-out states.
- [x] Rebuild the reading toolbar, sender metadata, attachments, and optional mail overview without changing the HTML safety pipeline.
- [x] Verify star/read failure rollback, query propagation, keyboard activation, and HTML/image consent through browser fixtures.

### Task 3: Remaining workspace pages

**Files:** `frontend/src/views/DomainMailbox.vue`, `frontend/src/views/user/UserLogin.vue`, `frontend/src/views/common/Appearance.vue`, `frontend/src/views/user/UserMailAccounts.vue`, `frontend/src/views/user/AddressManagement.vue`, `frontend/src/views/user/UserSettings.vue`, `frontend/src/views/index/SendWorkbench.vue`, `frontend/src/views/index/SendMail.vue`, `frontend/src/views/Footer.vue`.

- [x] Apply consistent page headers, sections, surfaces, form controls, and icon treatment to domain mailbox, login, account settings, appearance, and sending.
- [x] Preserve authentication/registration/OAuth/Passkey handlers and send idempotency.
- [x] Inspect 1440px, 1024px, and 390px layouts in both themes; eliminate horizontal document overflow.

### Task 4: Verification and delivery

**Files:** `frontend/src/components/inbox/__tests__/InboxMessageRow.test.js`, browser fixture/check script under `frontend/scripts/`, both changelogs, this plan.

- [x] Add behavior tests for row activation and nested actions; verify empty states and synchronized theme controls in the browser.
- [x] Run `cd frontend && pnpm test`; confirm every suite passes.
- [x] Run the production Vite build into a new temporary output directory; confirm exit zero.
- [x] Use local browser fixtures to test inbox, filters, codes, read/star updates, reader consent, login, compose, language, theme, and mobile drawer. Never send a real email.
- [x] Save desktop/mobile screenshots, review `git diff --check`, inspect final scope, and confirm the primary checkout stays clean.
- [x] Update both changelogs and deliver the reviewable worktree with a local preview.


## Verification record — 2026-10-07

- Frontend: 30 Vitest files, 212 tests passed (baseline: 28 files / 198 tests).
- Production Vite build succeeds. Existing large-chunk and mixed-import warnings remain; this change does not claim bundle-size optimization.
- Browser checks use `frontend/scripts/workspace-preview.mjs` with synthetic `.example` mail only. No real messages are read, sent, deleted, or moved, and no production settings are changed.
- Verified desktop light/dark, 1024px English inbox, 390px inbox/reader/login/account forms/security/domain mailbox, mobile drawer navigation, slash search shortcut, keyboard message activation, source/query filters, code copying, successful and failed star/read mutations, empty/error/retry states, external image consent and reset, language switching, account modal, compose controls, and sign-in/register/password visibility.
- Both instances of the theme control on Appearance stay synchronized. Document overflow checks report the expected 1024px and 390px widths.
- Main worktree remains clean. Changes stay on `feat/onemail-ui-redesign`; no commit, push, merge, or deployment was requested.

### Reproducing the browser preview

Run the frontend with its existing dependencies. From a Playwright script, import `installWorkspacePreview` from `frontend/scripts/workspace-preview.mjs`, call it before navigating to the local Vite URL, and use a fresh browser context for each authentication scenario. Options: `{ signedIn: false }` for login and `{ admin: true }` for the domain workspace. The default is a signed-in ordinary user.

The returned fixture state allows `empty`, `failList`, and `failNextMutation` to be toggled before the next UI request. This fixture is never imported by application code. A normal Vite tab still requires the normal development backend.


## Documentation alignment and hardening — 2026-10-07

### Source mapping and engineering decisions

| Repository source | Requirement applied |
| --- | --- |
| `CLAUDE.md` | Keep changes in the feature worktree; update both changelogs. |
| `docs/superpowers/specs/2026-08-22-architecture-refactor-monorepo.md` | Preserve Vue + JavaScript/JSDoc; reuse the API factory and add only concrete transport types. |
| `docs/superpowers/specs/2026-08-21-frontend-backend-separation.md` | Preserve the existing frontend/Worker boundary and verify prod/Pages builds. |
| `docs/remote-content-blocking-completion.md` | Remote images require consent in every rendering path, including the local overview. |
| `docs/send-mail-workbench.md` | One sidebar entry to `/sendmail`; self/system history stays inside the workbench. |
| `docs/send-mail-external-accounts.md` | Preserve existing account ownership and `can_send` checks; its draft proposals do not override implemented endpoint contracts. |
| `docs/unified-inbox-sharding.md` | Minimum 30-second refresh, one-row no-count probes, cursor pagination beyond offset limits, explicit partial results and retryable boundaries. |
| `docs/provider-message-identity-upgrade.md` | Preserve opaque provider/mail identifiers and existing mutation endpoints. |

No backend domain/service hierarchy was added for a presentation task. Existing endpoints remain the I/O boundary, with transport DTOs in `frontend/src/api/contracts.ts` and JSDoc at the call sites. Cursor history uses a Map with O(1) lookup and O(visited pages) storage. Account options use Set/Map deduplication in O(n). The overview reuses bounded candidate extraction instead of allocating global match arrays for the whole mail body.

### Verified defect corrections

- Healthy shard rows remain visible, counts become unknown, and forward navigation cannot cross an incomplete cursor boundary. Recovery reloads the same page even if the newest mail is unchanged.
- All read channels and row mutations propagate AbortSignal through axios; unmount, deactivation, navigation, or credential changes invalidate stale responses. Refresh probes stay single-flight and advance their baseline only after a successful load.
- Search drafts do not change background API requests until committed to the route. External account filters use account IDs so aliases remain in scope.
- Stale 401 responses cannot erase newer credentials; an attached failed admin password is removed without destroying the user session. Creating a key uses an explicit request header rather than temporary global session mutation.
- Overview text cannot create Markdown/HTML images or links from mail fields; derived overview state is discarded across mail/identity changes. Existing sanitized HTML and per-mail image consent remain intact.
- Failed optimistic row updates roll back, duplicate detail updates are guarded, and copy feedback timers are cleaned up.
- Typed locale trees resolve pre-existing TypeScript errors without weakening strict mode or adding dependencies.

### Verification approach

The original 7 failing safety cases, 3 failing cursor/detail cases, 2 duplicate sending-entry assertions, 4 HTTP ownership failures, the unmount mutation failure, and 2 partial-recovery failures were reproduced before their fixes. Source-string tests for inbox auth/refresh/codes were replaced with actual mounted Vue behavior checks. Existing frontend suites remain part of the full validation.

Browser checks use intercepted synthetic mail, including 47-message cursor navigation, an unavailable shard, and a subject containing a remote Markdown image. Real backend writes and real email sends are outside this verification scope. Existing router alias warnings and large bundle warnings are retained as known baseline limitations; this task does not claim whole-system zero defects.


### Final hardening verification

- Full frontend suite: **32 files / 229 tests passed** (2026-10-07, final run 11:49 local time).
- TypeScript: exit 0, no diagnostics. This worktree reuses the primary checkout's dependency installation; the final command was `node /Users/mango/project/one-mail/node_modules/typescript/bin/tsc --noEmit -p frontend/tsconfig.json`.
- Production and Pages builds: both exit 0, including service-worker generation. Outputs: `/tmp/onemail-ui-delivery-prod-20261007` and `/tmp/onemail-ui-delivery-pages-20261007`.
- Browser: desktop light/dark and 390px mobile verified; document width remains 390px. Cursor requests omit offset, request counts only on the first page, and retry the exact same boundary after shard recovery. A malicious Markdown-image subject produces no overview image or remote body image before consent. No page runtime exceptions observed in these checks.
- The key-creation lifecycle regression also reproduces the prior logout race and verifies that a late response cannot restore a credential.
- `git diff --check`: clean. All 52 changed/untracked delivery files decode as UTF-8 without BOM. Primary worktree remains clean; no commit, push, merge, or deployment.
- Preview screenshots: `/Users/mango/project/codex/onemail-hardening-desktop.png`, `/Users/mango/project/codex/onemail-hardening-dark.png`, `/Users/mango/project/codex/onemail-hardening-mobile.png`.
- Remaining baseline warnings: large Vite chunks; Vue Router locale-alias parameter warnings; JSDOM canvas/localStorage warnings. The fixture deliberately blocks the external Turnstile script. OAuth/Passkey providers, live sending, and a real sharded backend were not exercised by these UI fixtures.


## Production review corrections — 2026-10-07

The user authorized root-cause fixes, GitHub publication, production deployment, and an Obsidian update. The feature worktree was rebased onto `origin/main` at `64a8dd4` before the fixes; the upstream mailbox onboarding changes are retained.

The review reproduced four runtime defects that the earlier isolated API mocks missed: unread writes returned at enqueue time, provider polling omitted administrator credentials, cancellation/deadlines did not cover status requests, and successful row mutations left stale filtered results/counts. The earlier lifecycle verification record above describes the view/base-client tests only and does not establish the old installed adapter's behavior.

- All five writes now compose `createUnifiedMutationApi` at API construction time. The startup monkey patch and separate raw-fetch transport/auth implementation are removed. Reads, writes, folders, and status polling share the existing HTTP client, credential selection, and 401 handling.
- Terminal polling propagates cancellation to HTTP and delays, enforces a real deadline even during a pending response, checks identity again after responses, and releases timers/listeners. Moving, deleting, and folder loading also share the component/credential lifetime. Cancelling local waiting does not cancel a durable server job.
- Filter-changing writes invalidate cursor history, return to page one, and reload authoritative rows/counts; failures retain the previous row and boundary.
- Removed the redundant offset-to-cursor adapter and its implementation-only tests, unreachable nested locale entries, and unused `.inbox-count` style.

Verification: the initial production API regression suite failed all 9 cases; filtered-membership cases failed 3; the corrected component-lifecycle harness failed 3 against the original component. All pass against the final implementation. Full frontend suite: **34 files / 255 tests**. TypeScript and prod/Pages builds succeeded. Browser fixture verified that removing a non-top star removes the row and issues a first-page count request; no horizontal overflow. Tests use synthetic mail and do not send or delete real mail. Production release evidence is recorded in the canonical Obsidian operations manual after deployment.
