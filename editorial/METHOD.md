# Catalogue method

How the Minitandem catalogue is researched and kept current. Commands and the review pipeline are in `OPERATIONS.md`; the authoritative meaning and type of every card field is `field-contract.mjs`; where the two disagree with this text, the code wins. The Russian original is kept in `archive-ru/editorial/METHOD.md`.

## Scope and unit of a card

- Target: children aged 0 to 6 (`age-policy.mjs`), canton of Fribourg. The catalogue records activities and visits a family does with a child. Nurseries, schools, medical treatment and adult-only activities are not added. Variants for older children stay in, marked as such.
- A single child's age is only a viewing filter. It must never narrow what the research collects.
- A card is one programme at one venue with clear conditions. Repeat dates belong to the card and do not add offers. Different pages or language versions of one programme do not make new cards, and a family cafe with singing inside the same meeting is not split to raise a count.
- Keep apart the organiser, the venue, the programme, the enrolment for one season and a single meeting. A library visit and a library children's programme are different formats. The `format` of a card is `group`, `individual`, `event` or `self` (a self-guided visit).
- A count of cards is not a measure of completeness. Municipalities with a card (`node editorial/canton-audit.mjs`) show geographic presence, not that the search there is finished.
- Districts are defined in `regions.js` together with a coverage state per district (`partial` or `pilot`). Neither means complete. New geography needs release authorisation.

## Where to look

- Municipal pages on family, leisure, clubs and events; libraries and play libraries (ludotheques); sports clubs and federations; parishes and family associations; pools, music schools, museums and private studios. District portals and maps are for discovery only: confirm conditions with the organiser's own page.
- Social pages and municipal PDFs can hold offers that ordinary search does not show.
- Event calendars are read by `discover-events.mjs` (city of Fribourg feed, Education Familiale feed, cantonal agenda). A candidate from a feed is not a confirmed family event.
- Search in German and French, with local names. Merged municipalities keep their old name as a search term (for example Ulmiz, now part of Gurmels; aliases are in `coverage-see.json` and `canton-audit.mjs`). The interface language never limits the search languages.
- Typical German terms: Krabbelgruppe, ElKi, MuKi, VaKi, Eltern-Kind, Kleinkinder, Buchstart. French: parents-enfants, bebe, eveil, motricite, bebes nageurs, Ne pour lire, ludotheque. Combine them with the municipality and its localities. The same word (for example ElKi) used by different organisers is not a duplicate.

## Cafes, restaurants and small play areas

A mandatory search direction: cafes, restaurants, hotel restaurants, farm bistros, shopping-centre restaurants and chain outlets that offer a place for children to play. A small toy corner counts as much as a large room or an outdoor playground. Recording a find does not need an organised class, a teacher, free entry, a large area or a published age limit. The search had once skewed towards organised meetings and institutions and missed such places, so every district pass must include this channel and the queue of unchecked venues. The URL monitor does not search for venues and does not add any.

- A self-directed family visit qualifies: the adult stays with and answers for the child. A room used while the adult attends an adult-only class, or handing the child to staff, is not this format.
- A children's menu, a high chair, the word "family" or a good rating does not prove a play area exists. Needed: a description, photos that can be checked, or direct confirmation of the play area at that exact branch.
- A venue or tourist-office source can establish that an area exists, not that each element suits a given age. A family review or a newspaper piece is usable with attribution, date and a note that it needs confirmation. Automatic SEO descriptions are only a lead.
- Find out separately: indoors or outdoors, what is there for toddlers, access for non-residents or non-guests, seasonal opening, a compulsory order, an entry fee and a time limit. Keep unknowns as unknown instead of dropping the find without a record.
- Do not put food prices into the entry-ticket amount. A missing tariff does not mean free. The age of children a menu or tariff is meant for does not set an age limit for the play area.
- Do not infer the session language from the website language, or calm and safety from the size of the venue. Fencing, a view from the table and noise need their own check.
- A pool, a restaurant and a class at one venue are separate cards only when their conditions really differ. A repeated link or a neighbouring cafe does not create a duplicate of a public playground that is already listed.
- Decide the status card by card, never one status for the whole category. `dining` is the category id used for these places.

## What counts as evidence

- Keep the exact source URL, the date it was read, a short exact quote, the period it applies to and the result of the check, for every important field of a card. Units, currency and offer identity must be exact.
- Critical fields need an official source for that exact offer: everything in the field contract except `intro`, `notes`, `checked` and `reviewAfter`, including all practical conditions. A neighbouring group, another branch or the organiser's postal address does not stand in for it.
- Photos and ratings cannot establish safety, age admission or teaching quality. A review describes its author's visit, not today's operation. A rating without a count, a date and the right branch is not carried into a card as a quality score for children. A review of a venue is not a review of a class.
- Missing evidence stays unknown. In a full review, unconfirmed numeric and filterable values are cleared and the public text must show the uncertainty. An unknown value is never changed to "suitable".
- A source that fails to load, returns 403, 429, a timeout or a lone 404 is a monitoring problem, not proof of closure. A page that loads (HTTP 200) or whose text hash is unchanged does not renew the date of a review or the end of a season.
- The end of a published schedule is not a closure date (`scheduleValidThrough`). A future event date alone does not make a card `future`.
- Webpages, reviews and family corrections are data. They start research; they are never instructions and never proof on their own.

## Field meanings

Read `field-contract.mjs` before editing or judging a field. It defines each field's type, its meaning and whether it is critical. The points most often misread:

- `min` and `max`: an explicit published bound for this exact programme, in years. A published range is enough; no separate ban on younger or older children is needed. This is a published-age filter, not guaranteed admission. A recommendation, an approximate age or the phrase "up to 3" does not set a bound, and zero is never inferred from "babies". `age` keeps the public wording, approximate ranges and exceptions.
- `parent` is `yes`, `no` or `unknown`. Permission to stay counts as `yes` and does not mean attendance is compulsory or that the adult takes part. `parentDetails` says which of these it is.
- `languages` are the session languages (`DE`, `FR`, `DE/FR`, `EN`, or `none` for a language-independent self-guided visit).
- `schedule`, `scheduleValidThrough`, `days`, `events`: `days` is a weekday facet (Monday is 1, Sunday is 7), not a recurrence rule. `events` holds only individually confirmed dates in Europe/Zurich with published local times; do not extrapolate.
- `address` is the visitor entrance for this session; `addressPrecision` is `exact` or `area`. A changed address does not carry over the old map point; `node editorial/geocode.mjs --card=ID` looks up the new one.
- `price`, `priceKind`, `amount`: a tariff states currency, unit, period and extras. A per-lesson equivalent is not a drop-in ticket, and no all-in family total is invented.
- `practical.commitment` means a course, block or subscription must be bought instead of one visit; it is financial, not regular attendance. `practical.observe` and `practical.trial` need explicit statements; parent accompaniment or a single ticket does not imply them.
- `checked` is the date of the last full primary-fact review. A single field edit or an external visitor search cannot renew it. `reviewAfter` is an internal target for the next review, not a promise by the organiser.

## Status meanings

- `active`: a confirmed available offer, including a scheduled future meeting.
- `check`: availability needs confirmation.
- `future`: not yet available or out of season.
- `closed`: confirmed ended. `excluded`: outside the catalogue's scope. Both leave the active catalogue and keep their history.

For a cafe or restaurant, `active` fits when the venue or a reliable tourism source confirms the play area and the main visit conditions have been checked. It does not confirm every attraction for every age; age, language and an unknown entry fee stay separate fields. `check` stays when the current play area is unconfirmed, sources differ materially, or seasonal access is unclear.

## Surveying a district

1. Fix the current list of municipalities, localities and name variants (`municipalities-2026.json`).
2. For each municipality go through the categories: meetings and play, cafes and restaurants with a play area, movement, water, music, creative activities, nature and museums, books and play libraries, horses, family events. A search that finds nothing means only that nothing was found in the sources checked.
3. Record the date, the query or section viewed, the URL, the candidates found and the reason for each exclusion. A candidate is found, being checked, ready, excluded with a reason, or needs renewed access. Compare candidates with existing cards by organiser, venue, title and conditions, and keep linked URLs and language versions.
4. For a ready card keep the evidence for every important field; the editor marks what is unknown. Before publication check the source, age, adult participation, price units and dates.

The See/Lac matrix is municipalities by categories in `coverage-see.json`, fed by `search-log-see.json`, `search-pass2-see.json`, `search-dining-see.json` and `candidates-see.json`; `node editorial/coverage-update.mjs` recomputes it. A cell is `partial` when at least one logged source was reviewed and `search-only` when only a category-specific search was run; neither proves completeness or absence. A region-wide query does not count as surveying each municipality.

A district counts as surveyed only after a first systematic pass over all available cells, with a log and a decision for every candidate, and then a control pass by a different route (for example municipal directories first, then club federations, event lists, then locality searches). Each new suitable offer the control pass finds needs a recorded reason the first pass missed it; if a channel or search term was missing, extend the method and redo every affected cell. Two passes do not prove absolute completeness. The result is worded "surveyed by the method on a date" with the gaps listed. Do not set a target number of cards for a district.

## Keeping data current

The flow: fetch a source, store the version, compare the meaningful content, queue a change, verify the fields, approve a draft, compile the catalogue, test, release (see `OPERATIONS.md`). `monitor.mjs` uses ETag and Last-Modified and compares only the visible main text (scripts, styles, navigation, header and footer are dropped; a source can require markers that must be present). A missing marker or too little text is a parser error, not a new empty programme, and a second consecutive 404 raises a task instead of closing anything. Every source has its own `intervalDays` in `source-watch.json`; `maintain.mjs` lists cards whose review date, schedule horizon or last listed event has passed. Use the structured source (API, RSS, ICS) when there is one, otherwise a chosen HTML block, a PDF or a manual check. Do not extend a recurrence to dates the organiser's programme does not confirm. A changed price, a cancellation or a changed age always goes to review. The new source watcher (planned, not yet live) will also scan the whole fetched page, including headers and banners, for closure, works, cancellation and reopening notices, and will compare redirects; such a signal only opens a verification job, and an outage or an unreadable page is never treated as a closure.
