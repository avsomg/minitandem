# Publication scope

What goes into the first public repository of Minitandem and what stays private, with the reason for each group, sizes and file counts, and the result of a scan for secrets and personal data. Status: 14 October 2026. Written before the first commit, which is where this repository's history starts.

The file list comes from `git add -n .` (a dry run that stages nothing). It respects `.gitignore`, so it is exactly what a first `git add .` would add.

## How the line is enforced

A path is private when it is ignored. That is written down in three places that must agree, and tests check that they do:

| Where | What it does | Checked by |
| --- | --- | --- |
| `.gitignore` | keeps private paths out of git | `editorial/public-audit.mjs --strict` (`npm run audit:public`) fails if a private path is missing here; `publication-files.test.mjs` |
| `.dockerignore` | an allow-list for the Docker build context, with the private paths named again at the end, so a build from a working folder cannot copy private state into an image | `docker-files.test.mjs` |
| `PRIVATE` in `editorial/public-audit.mjs` | the one list of private paths; private files are not audited | `editorial/public-audit.test.mjs` |

## What goes into the public repository

| Group | What | Why it is public | Files | Size |
| --- | --- | --- | ---: | ---: |
| Interface, service and build | `index.html`, `styles.css`, scripts, `sw.js`, `strings-*.js`, `server.mjs`, `build.mjs`, `site.mjs`, `.vercelignore`, `vercel.json` | Everything a visitor receives, plus the code that builds and serves it. Nothing in it is secret; the site is plain files. | 32 | 320 KB |
| Catalogue data | `data.js`, `data-practical.js`, `data-reviewed.js` (generated), `data-geo.js` (generated), `regions.js`, `research.md` (generated) | The product. Contacts are organisation contacts only; see the decision of 14 October 2026 below. | 6 | 1,335 KB |
| Assets | icons, Leaflet and Lucide bundles with their licences, one public-domain photograph | Needed by the site; licences are included. | 12 | 710 KB |
| Design | the approved mockup and screenshots of the real app | Shows how the product should look. The screenshots show activity lists and an organisation card, no private contact. | 13 | 2,318 KB |
| Pipeline code and editor panel | `editorial/*.mjs`, `extract-municipalities.py`, `admin.*` | The core of the project: the controller, the queue, the evidence capture, the worker adapters, the release gates. It contains no data of the queue. | 46 | 370 KB |
| Pipeline configuration and generated statistics | `agent-policy.json`, `cycle-policy.json`, `source-watch.json`, field and baseline files, venue registry, geocoding candidates, coverage and profile statistics, early search logs of the See district | Policies and public inputs the code needs to build and test. The monitored sources are public web addresses. The statistics are counts, not state. | 24 | 651 KB |
| Tests | `*.test.mjs` at the root and in `editorial/`, `test-support.mjs`, the browser checks `verify*.mjs` and `screenshots.mjs` | Proof that the code does what it says. Fixtures are invented or taken from the public catalogue. | 61 | 517 KB |
| Demo | `demo/run.mjs` and `demo/fixtures/` | The pipeline rejecting a wrong result on three invented cards; no real data. | 8 | 25 KB |
| Container, server, CI and scripts | `Dockerfile`, `compose*.yaml`, `docker/`, `ops/`, `.github/workflows/test.yml`, `package.json`, `scripts/`, `.dockerignore`, `.gitignore`, `.nvmrc`, `.env.example` | Prepared deployment and CI; they hold no secret (the server `.env` is ignored). | 14 | 19 KB |
| Documents | `README.md`, `README.de.md`, `docs/`, `editorial/OPERATIONS.md`, `AGENTS.md`, `METHOD.md` | Explanation for readers and for the coding agents that work on the project. | 8 | 92 KB |
| **Total** | | | **224** | **6,355 KB** |

`git add -n .` lists **224 files, 6.2 MB (6,355 KB)** (counted with this document in place).

## What stays private

| Group | Paths | Why it stays private | Files | Size |
| --- | --- | --- | ---: | ---: |
| 1. Private editorial state | `editorial/workflow-state/` (the job queue `jobs.sqlite`, release snapshots, queue backups, cycle logs), `agent-artifacts/`, `external-candidates/`, `external-disputes/`, `external-decisions/`, `external-review-receipts.json`, `family-venues-visitor-check-2026-09-27.json`, `corrections/`, `correction-versions/`, `monitor-state.json`, `discovery-state.json`, `discovery-report.json`, `heartbeat-state.json`, `versions/`, `page-records/`, `typesafe-runtime/`, `calibration-runtime/`, `catalogue-runtime/`, `catalog-versions/`, `audit/` (reports of the sampled accuracy audit) | The queue and everything the workers produced: captured source texts (third-party page copies), search candidates with review and rating pages, disputes, receipts and submitted corrections. It is operating state and evidence, partly written in Russian, partly third-party content and, for corrections, family input. The code that reads and writes it is public; the state is not. | 2,385 | 95.7 MB |
| 2. Generated snapshots of that state | `editorial/external-review-report.json`, `external-pipeline-report.json`, `operations-report.json`, `workflow-report.json`, `quality-report.json`, `work-packets.json` | Rebuilt by their commands; they change with every pipeline run and mirror the queue and the receipts. Nothing reads them to build or test. | 6 | 947 KB |
| 2b. Dated working papers of the first rollout | `editorial/catalogue-shape-audit-2026-10-02.json`, `dependency-audit-2026-10-02.json`, `memo-booking-browser-check-2026-10-02.json`, `workflow-rollout-2026-10-02.json` | History of the Codex period, not an input of anything; they name the earlier tool's automations. | 4 | 6 KB |
| 3. Release identity and local settings | `editorial/release-identity.json`, `.playwright-path`, `.env`, `.workspace-in-use`, `.minitandem-workspace` | Account identifiers of the Vercel release, paths and markers of this Mac, and the server's environment file. | 4 | 1 KB |
| 4. Data of a running service | `server-state/` | Family keys (hashed), family profiles, submitted corrections. Empty today. | 0 | 0 KB |
| 5. The Russian archive | `archive-ru/`, `translation/` | The original layers, journal and documents of the first project phase. Never public; the audit enforces that the public files contain no Cyrillic. | 1,841 | 9.4 MB |
| 6. Dependencies and build output | `node_modules/`, `editorial/node_modules/`, `.publish/`, `.vercel/` | Reproducible from `package-lock.json` and the build. `.vercel/` links a local folder to a Vercel project. | 2,285 | 12.5 MB |

Sizes were measured in the workspace on 14 October 2026 (metadata only; the private files were not opened).

## Scan for secrets and personal data

Method: `node scripts/scan-public.mjs` over every file git would track (rules for private keys, API and bearer tokens, JWTs, Vercel identifiers, personal computer paths, Cyrillic text, and e-mail addresses or phone numbers outside the catalogue files), plus searches by hand for the owner's address and name, the names and numbers of the catalogue contacts in every other file, and the account name of the release. The scan is repeatable (`npm run scan:public`), is covered by `scan-public.test.mjs`, and runs in CI after the build and in the local QA, next to the strict audit below. Result at the end of this work: **no finding outside the catalogue files.**

| Finding | Where | What was done |
| --- | --- | --- |
| Absolute path of this Mac (the folder of a coding tool's Playwright) | 9 browser scripts (`verify*.mjs`, `screenshots.mjs`) and `prepare.mjs` | Removed. `playwright-loader.mjs` finds Playwright through `MINITANDEM_PLAYWRIGHT_DIR`, a local `.playwright-path` file (ignored) or the repository itself; `prepare.mjs` takes its folder as an argument. |
| Absolute path of the owner's private knowledge folder | `editorial/AGENTS.md` | Reworded; the folder is described, not located. |
| Vercel project id and team id | `editorial/agent-policy.json` | Moved to `editorial/release-identity.json` (private, ignored). `release.mjs` reads it through `releaseIdentity()`; `release-identity.example.json` shows the shape with placeholders. |
| Vercel scope name (derived from the owner's account name) | `editorial/release.mjs` | Same file as above. |
| A real private mobile number in a test fixture | `editorial/external-pipeline.test.mjs` (2 lines) | Replaced by the invented number `026 000 00 00`. |
| Two Cyrillic code points written as letters in a detector regex | `i18n.test.mjs` | Written as an escape sequence for the block U+0400 to U+04FF, same meaning. |
| A file that names the earlier project's path and a private migration script | `.workspace-in-use` | Ignored. |
| Dated working papers of the first rollout (they name the earlier coding tool's automations and in-app browser) | four files `editorial/*-2026-10-02.json` | Ignored (group 2b below). |

Looked for and **not found** in tracked files: private keys, API tokens (`sk-`, `ghp_`, `github_pat_`, `AKIA`, `xox`, `vercel_`), bearer tokens, JWTs, `.env` files, the owner's e-mail address, any e-mail address or phone number outside the catalogue files that is not obviously invented (test fixtures use `example.org` and `026 000 00 00`), the names, numbers or addresses of catalogue contacts anywhere except the catalogue files (`data.js`, `research.md`, the design mockup). False alarms that were checked: `sk-catalog-…` source keys in a generated report (that file is now ignored), `…/WWW/Users/…` inside the URL of a commune's PDF, and `user:secret@family.example.ch` in a test of address validation.

### Decision of 14 October 2026: organisation contacts only

The owner decided that the public catalogue keeps organisation contacts only. The catalogue data was changed the same day: in `data.js` 61 cards changed, 34 contacts were removed whole and 31 were changed in place. Removed were every Swiss mobile number, the contacts of private persons and e-mail addresses that carry a person's name; 11 text strings on 9 cards that repeated those numbers were reworded. Cards without a direct contact went from 46 to 74. Every card keeps its source links, and a card without a contact says that the sources lead to the organiser.

The rule: a public contact is an organisation's name, landline and role address (info@, secretariat@ …), never a mobile number, a private person's name or an e-mail address that carries a person's name. Such a contact is left out; the source link leads families to it. Three places enforce it:

1. **Field contract** (`editorial/field-contract.mjs`). The meaning of `contacts` states the rule, and the controller refuses a worker claim, an editor patch or a full-review row whose contact holds a written-out Swiss mobile number. The refusal names the position (`contacts[1] holds a Swiss mobile number`), never the value. The pattern is kept in one place, `editorial/contact-rule.mjs`.
2. **Worker instructions** (`editorial/agent-run.mjs`). The research worker records organisation contacts only; editor and reviewer never copy a contacts claim that holds anything else. Contacts are still copied whole from one approved claim.
3. **Strict audit** (`npm run audit:public`, group "private contacts"). It fails on a written-out Swiss mobile number in `data.js`, `data-reviewed.js`, `data-practical.js`, `research.md` or the built site (digits in web addresses do not count), and on any contact of the assembled catalogue, approved updates included, that is missing from `editorial/public-contacts-reviewed.json`. That file holds sha256 digests only, with the rule and the review date. `node editorial/review-contacts.mjs` lists missing contacts by card and position, with their values in the terminal only; `--accept` records them. Only the main chat or the owner runs `--accept`, after checking that each is an organisation contact; a private contact is removed from the card instead. The first list holds every contact on the cards on 14 October 2026, all reviewed that day. A pattern cannot recognise a person's name, so the reviewed list is what catches a new one. The audit needs no private file: CI runs it on a clean clone right after the build (`.github/workflows/test.yml`, after `npm test`), and the local QA runs it on the site it has just built (`PUBLIC_GATES` in `editorial/agent-run.mjs`), so a new contact that no person has reviewed fails both and a release job is not created. The same audit also fails on a private path that git tracks, because `.gitignore` only keeps untracked files out. Neither CI nor QA ever records a digest; only a person does, with `--accept`.

The previous contact values are kept outside the repository, on the owner's machine.

Names of people in descriptions were decided the same day: in 50 strings on 29 cards (who leads, introductions, notes, research findings, two contact labels) a private person's name became their role, such as "the group leader" or "a music teacher". Card titles keep the name where it is the name of the person's own business. A name in a new description is not caught by code; the worker instructions ask for roles, and the main chat checks before a release.

## Other decisions and limits

- **Licence:** decided by the owner on 14 October 2026: MIT for the code (`LICENSE`); the catalogue data is not licensed (see the README). Third-party files in `assets/` carry their own licences (Leaflet, Leaflet.markercluster, Lucide). `assets/papiliorama-outside.jpg` is a public-domain photograph, credited on its card.
- **Internal identifier:** `editorial/project-id.mjs` keeps the value of an earlier working title, because queue, artifacts and journal entries are stamped with it. The audit exempts exactly that string. The README says so.
- **Approved updates on a clean clone:** each entry of `editorial/approved-updates.json` carries what is needed to check and apply it: the approved draft, the base record, the verifier's approval summary (verdict, draft hash, checked fields and bindings; not its reasons) and the digests of the private approval artifact and of the applied record. `editorial/compile-review.mjs` checks those internal digests everywhere. Where `editorial/agent-artifacts/` and `editorial/correction-versions/` exist (owner's machine, QA, release) it also checks every entry against them and fails on a missing or different file; without them it runs only for `--public` and reports `privateCrossCheck: skipped` (shown by the build as `approvalCrossCheck`). The first entry (15 October 2026) predates the summary and got it once from its artifact by `editorial/migrate-journal-approval-2026-10-15.mjs`.
- **Publication gates in a public build:** the gates read the private receipts, so `node build.mjs --public` skips them on a clean clone and says so in its output. In the owner's workspace the same command still runs them. The Docker build always uses `--public`; the gates must therefore be passed on the owner's machine before a commit is deployed.
- **Release source revision:** the files added or changed by this preparation (`build.mjs`, `server.mjs`, `editorial/*.mjs`, new tests) change the source revision that `editorial/release.mjs` compares with a tested release. A release tested before this change is void; QA has to run again before any release. Running controllers see the changed `editorial/` code and stop with "editorial runtime changed".

## Tests that need private state

Six tests run only in the owner's workspace. On a clean clone each is skipped with a message that starts with `private-only:`.

| File | Test | Needs |
| --- | --- | --- |
| `catalog.test.mjs` | follow-up status decisions cover all sixteen new venues without implying age suitability | `editorial/family-venues-visitor-check-2026-09-27.json` |
| `catalog.test.mjs` | visitor research covers sixteen venues and preserves provenance for nine enrichments | the same file |
| `editorial/corrections.test.mjs` | all thirteen October 2 corrections match the compiled catalogue, not just their status | `editorial/corrections/` |
| `editorial/corrections.test.mjs` | address fixes keep the original identity source of their external review receipt | `editorial/external-review-receipts.json` |
| `editorial/external-pipeline.test.mjs` | the real receipts reconcile with the current published catalogue | the same receipts |
| `editorial/external-review.test.mjs` | every published card enters the external evidence queue without fabricated completion | the same receipts |

Four of them have a counterpart that runs on tracked data and stays in the clean-clone suite (the venue registry against the catalogue, the baseline that covers every current card, the visitor-research notes, the address-fix caveats). Two tests that used to read the real queue and the monitor state now use their own temporary data (`server.test.mjs`, `editorial/operations-report.mjs`).
