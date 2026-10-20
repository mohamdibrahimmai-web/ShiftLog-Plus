# ShiftLog+ test Worker

Target: mohamdibrahimmai-web/ShiftLog-Plus and Cloudflare shiftlog-plus-test only.
The original ShiftLog repository is outside this change.

## Deploy

1. Install dependencies with pnpm install --frozen-lockfile (Node 22.13+).
2. Run npm test.
3. Run npm run migrate:remote after confirming the account and test database.
   Migration adds branch_state and login_attempts. Existing staff, breaks and
   manager_actions are untouched. Their schema/data is not automatically imported.
4. Configure SESSION_SECRET and BRANCH_PASSWORDS using Cloudflare encrypted
   Worker secrets (never Git, build variables, wrangler vars, or browser storage).
5. Run npm run deploy, or configure the connected Workers build with npm test
   and deploy command npx wrangler deploy. No static-only deploy command.

SESSION_SECRET must be a random value of at least 32 characters.
BRANCH_PASSWORDS is a JSON object keyed by the exact branch names:
Motor City, Al Rigga, DIFC, Festival, Um Al Sheif, Al Qana.
Each value is the hex HMAC-SHA256 digest of branch + "|" + a long random
branch password, keyed by SESSION_SECRET. Provision credentials privately.
Missing branch digest disables that branch's login. Each branch credential grants
all existing application actions, including manager edits and deletion; this
version does not implement individual staff/manager roles.

Sessions expire after eight hours. Cookies are Secure, HttpOnly and SameSite=Strict.
Writes require a matching Origin and custom header. Login attempts are limited
in D1 by IP/branch/time window. The API fails closed if authentication is absent.

## Synchronization and migration

public/index.html is the application. public/sync.js synchronizes every five
seconds and on edits/reconnection. Each branch has separate D1 state and cache.
Atomic revision checks reject stale updates. This version uses complete branch
snapshots rather than row-level automatic merging. Conflicts retain the local
copy, stop editing and offer export plus explicit server-copy recovery.
Local changes survive an offline connection and page reload.

Old localStorage data is never silently assigned to a different branch. Use
Import old data for this branch only when its branch matches. Unlabelled old
data requires manual review and a branch-labelled backup before restore.
Before importing old data, export a backup. Root index.html routes readers to
the Worker; GitHub Pages cannot run this protected API.

## Live two-device acceptance

Use two different devices or independent browser profiles at the Worker URL.
Sign in to Motor City on both. Add a synthetic employee on A; within five seconds
it must appear on B. Start a break on A, end it on B, add a manager adjustment,
and verify history on A. Sign into DIFC separately and confirm that none of those
Motor City records appear. Test simultaneous edits: the stale device must show a
conflict and retain an exportable local copy. Test offline/reconnect, sign-out,
and anonymous API requests. Do not report this live test complete until performed.

Local node tests exercise the real SQL through SQLite and two independent session
cookies, plus frontend branch switching, offline retention, and conflict guards.
They do not replace live Cloudflare deployment/browser tests.
