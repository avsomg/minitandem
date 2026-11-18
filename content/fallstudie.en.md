# Minitandem: a web app built and run with AI agents

A directory of family activities in the canton of Fribourg. By Alex Shamrai.

[Buttons:] Open the app · Code on GitHub · [Video, once V8 is done]

## What it is

Minitandem collects activities for families with children aged 0 to 6 across the canton of Fribourg, from play and
nature to music and horses. Parents filter by age, place and category. A separate tab lists crèches, childminders
and playgroups from the canton’s public list, with four guides for parents. The app is in German, French and English.

The hard part is not the site but the data. Activities change, and a language model easily makes up an answer when
a source says nothing about it.

## What I do and what the agents do

AI agents wrote the code: Claude Code and Codex. I do not program myself, and I cannot read code yet. My part:

- I decide what the product does and does not do. For example: no names of private individuals in the catalogue.
- I set the requirements and the rules. The agents turn them into specifications, which I approve.
- I check the results: the agents run the tests and audits; I read their reports and look at the live site myself.
- I decide what gets published. I chose and paid for the domain and the server. Agents set up both after my approval.

All commits in the repository carry my name; the agents wrote them. I can explain how it works: the four main paths
through the code are described in [`docs/architektur.md`] (German).

## The rule

**Models read and propose. Code decides and writes.**

- Every claim needs a word-for-word quote from a source that the program fetched itself.
- A second, independent run checks that the quote really supports the claim.
- A draft may only rest on checked claims. Another run approves it.
- What is not backed by a source stays “unknown”.
- Nothing is published automatically. I decide.

[Diagram, 5 boxes in a row:] Fetch the source (program) → Claim with quote (search agent) → Check the meaning
(verification agent) → Draft and approval (editor and verification agent) → Catalogue (only the program writes)

## An example: a wrong claim is caught

From the demo in the repository. It runs without network access or a model, using prepared sample answers
(`npm run demo`).

1. The search agent reads a playgroup’s page. It finds “children aged 2 to 4 years” and proposes an age of 2 to 4
   years. It turns “Registration is not needed” into “free”.
2. The verification agent confirms the age. It rejects “free”: the quote only says that you do not need to register.
   The same page lists a contribution of CHF 5 per family per visit.
3. The editor agent still writes “free” into its draft. The program refuses the draft because it rests on a
   rejected claim.
4. The second draft contains only checked claims: the age range and the fact that a parent stays with the child. It is approved.
   The price stays “unknown” until a search agent backs it with a quote.

## Numbers

As of 18 November 2026.

- 294 entries in the catalogue, 31 in the archive
- all 7 districts of the canton
- 492 sources. The initial check of all entries ran from 22 September to 2 October; 209 entries were checked
  again after 17 October (recheck or strict chain).
- 1,052 automated tests. On GitHub they run on every push; 8 of them are skipped there.
- deliberately left “unknown”: the language for 270 entries, the price for 190, the minimum age for 206

### Pipeline in the first weeks, 2 to 17 October 2026

Most model runs in this period (197 of 234) went through the earlier route with OpenAI Codex (2 and 3 October), and
37 went through Claude from 8 October. The rules in the code are the same for both.

- 234 model runs: 77 search, 111 verification, 46 editor
- 1,340 proposed claims. For 51 the program did not find the quote word for word in the source; for 36 it did not
  come from an official page of the activity. These claims were set to “unknown”.
- 1,199 verdicts by the verification agent: 637 confirmed, 127 rejected, 435 “needs another source”
- Drafts by the editor agent: 23 approved, the program refused 9, the verification agent rejected 8
- 16 answers broke the rules (schema or evidence) and were discarded, including the 9 refused drafts
- The circuit breaker never tripped in this period. Six jobs went to a human for a decision.

## Operations

- The site runs in Docker containers on a server in Switzerland (Infomaniak Public Cloud), with HTTPS through
  Caddy. This case study is served from there too.
- New versions go online only through a deploy script. It first starts the new version in a preview on the server.
  On 16 October the script found an error in the preview, so the new version did not go live. The script kept the
  old version running, and the site stayed up without interruption. A quarter of an hour later the corrected
  version was online.
- A backup is made every night, and my computer fetches a copy. A restore from backup was rehearsed on the live
  server on 14 October 2026.
- Every five minutes the server checks whether the site responds. If not, an e-mail goes out. Every 30 minutes it
  also checks that the editorial pipeline is running and that its backup has arrived.
- The editorial pipeline does not run on the server but on my own computer.
- The overnight runs of the editorial pipeline from 30 October to 8 November went through Claude.

## App review

On 17 October 2026 AI agents and automated tools reviewed the live app. The yardsticks were WCAG 2.2 AA, OWASP ASVS
(level 1) and Core Web Vitals; eight typical tasks were also carried out in a phone-sized browser. One finding:
the age filter for children under 1 hid a baby swimming course “from 4 months”. Nine issues were fixed the same
day, and the fixes were published after my approval.

## Limits

- So far 426 changes to 213 entries have been through the strict chain of quote and independent check. The other
  claims come from the initial check of 22 September to 2 October, with sources on every entry.
- All entries are in German, French and English. Language models translated the texts from English into German and
  French. A program checked numbers, times, weekdays and the like, and further language models checked the meaning.
  No native speaker of German or French has read the translations yet.
- When an entry’s translation is out of date, the basic entry pages (under /places/) show the English text with a
  note.
- Many fields are “unknown”. That is on purpose, but less convenient for parents.
- If the whole server goes down, it cannot send an e-mail any more. An external availability check is still missing.
- Syncing between devices exists in the code but is switched off. Favourites, notes and visit plans therefore stay
  in the browser where they were created.

## Contact

Alex Shamrai · hello@minitandem.ch · github.com/avsomg
