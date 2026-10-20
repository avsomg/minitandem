# Decisions

The decisions that shape Minitandem, newest last. Each says what was decided, why, and what follows from it. The owner makes them; the agents propose and carry them out. Operations are described in German in [`betrieb.md`](betrieb.md), the code paths in [`architektur.md`](architektur.md).

## 8 October 2026 · The workers run on Claude, by subscription

- **Decision:** the editorial workers (search, verify, editor, arbitrate) move from OpenAI Codex to Claude Code. Model work runs on the owner's subscriptions only, never on a paid API as a hidden substitute.
- **Why:** one tool for the code and the workers; a predictable cost.
- **Follows:** throughput is capped by the subscription's weekly limit; the earlier Codex route stays selectable in `editorial/agent-policy.json`.

## 13 October 2026 · Minitandem, for every family with young children in canton Fribourg

- **Decision:** the earlier private project becomes Minitandem: activities for families with children aged 0 to 6, in English, German and French. The card texts are rewritten once, directly in English.
- **Why:** a service anyone in the canton can use, readable by people who do not read the earlier working language.
- **Follows:** German and French come from checked translations of the English (`catalogue-i18n.js`); a card whose English changed is shown in English until it is translated again.

## 14 October 2026 · Organisation contacts only

- **Decision:** the catalogue lists only organisation contacts: the organisation's name, a landline, a role address such as info@. No mobile numbers, no private persons' names. A person is named by role ("the group leader").
- **Why:** families need a way to reach an offer, not someone's private number.
- **Follows:** `npm run audit:public` fails on any contact that no person has reviewed (`editorial/public-contacts-reviewed.json`); a card without a contact points to its sources.

## 14 October 2026 · Code MIT, data without a licence

- **Decision:** the code is MIT-licensed; the catalogue data carries no licence.
- **Why:** the code is meant to be read and reused; the data describes other people's offers.

## 14 October 2026 · Own small server in Switzerland

- **Decision:** the site runs on one small server at Infomaniak in Switzerland, with Docker and Caddy, instead of a hosting platform.
- **Why:** everything stays inspectable and under the owner's control, in the country of the users.
- **Follows:** nightly backups pulled to the owner's Mac and a rehearsed restore (14 October); e-mail alerts when the site does not answer.

## 14 October 2026 · Nothing is published without the owner's yes

- **Decision:** every push, every deployment and every release of editorial changes needs the owner's explicit yes. Approved editorial changes are collected and published once a week.
- **Why:** the owner answers for what families read.
- **Follows:** the pipeline never publishes by itself; the weekly session shows each change before and after.

## 15 October 2026 · A daily editorial cycle

- **Decision:** the editorial cycle runs on the owner's Mac six times a day, at most four model jobs per run (24 a day). A file `editorial/cycle.pause` stops it.
- **Why:** a steady pace inside the subscription, with every step visible in a receipt.
- **Follows:** about six cards a day can pass the full chain; urgent signals (closures, address changes, events in the next 14 days) go first.

## 15 October 2026 · Alerts and the editorial copy leave the Mac

- **Decision:** the server watches the Mac's cycle (a heartbeat after every run) and receives a daily copy of the private editorial state, through one SSH key that can do only these two things. No new third-party account.
- **Why:** a silent or broken cycle, or a lost Mac, must not go unnoticed.
- **Follows:** an e-mail when the cycle is silent for 12 hours, fails, or the copy is older than 36 hours.

## 15 October 2026 · One command to deploy

- **Decision:** a deployment goes only through `ops/deploy.sh <commit>`: the tests on GitHub must be green for that commit, the new version runs first as a preview on the server, and the script refuses when visible cards drop by more than 15 % and rolls back by itself on failure.
- **Why:** fewer hand-typed steps, and a guard against a broken build reaching families.
- **Follows:** on 16 October the guard stopped a release whose preview could not read its own files; the live site stayed up.

## 15 October 2026 · An independent review, and facts only where they fit

- **Decision:** OpenAI Codex reviewed the whole system; its fourteen findings were fixed. Its proposal to make single facts the unit of work is adopted for the structured fields only (dates, ages, prices, booking, addresses); free text keeps the editor and the second reading.
- **Why:** three quarters of what families read is prose that no template should write; the structured fields are where code can compose and recheck.
- **Follows:** one capture of each source page for monitor and editors, and a private fact ledger that says per field whether its value was verified by the pipeline or inherited from earlier work.

## 16 October 2026 · Family sync off; legal pages; a short access log

- **Decision:** the optional sync between a family's devices is switched off until it is shown on purpose (one setting turns it back on). The site has an Impressum and a privacy notice in three languages. The web server's access log masks IP addresses and keeps no record longer than six days; its error log keeps no visitor address.
- **Why:** collect only what the site needs, and say exactly what happens.
- **Follows:** the server refuses family data with 503; the privacy notice lists every outside request the page can make.

## 17 October 2026 · A review before the link goes out

- **Decision:** before the link is sent, the live site is checked against WCAG 2.2 AA, OWASP ASVS level 1 and Core Web Vitals, with eight family tasks walked through on a phone-sized screen; the findings are fixed the same day.
- **Why:** a first visit should work.
- **Follows:** for example, the age filter "under 1" now includes offers from four months, and past closure notices are no longer shown.

## 20 October 2026 · The web server serves the catalogue itself

- **Decision:** Caddy serves the built pages and files from its own image of each release; only `/api/*` and `/healthz` reach the service.
- **Why:** a fault in the service can no longer take the catalogue with it (finding F01 of the review), and the files, their headers and the API of one release are switched and rolled back together.
- **Follows:** the switch was rehearsed on the owner's Mac and on the server before the site was touched. That found three faults in the deployment path, among them a check that ended a deployment early and still reported success; all three are fixed and tested. A rollback to the previous release and forward again was practised the same day.
