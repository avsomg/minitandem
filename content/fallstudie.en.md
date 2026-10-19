# Minitandem: a web app built and run with AI agents

A directory of family activities in canton Fribourg. By Alex Shamrai.

[Buttons:] Open the app · Code on GitHub · [Video, once V8 is done]

## What it is

Minitandem collects activities for families with children from 0 to 6 across canton Fribourg, from play and nature
to music and horses. Parents filter by age, place and category. The app is in German, French and English.

The hard part is not the site but the data. Activities change, and a language model easily makes up an answer when
a source says nothing.

## What I do and what the agents do

AI agents write the code: Claude Code and Codex. My part:

- I decide what the product does and what it does not. For example: no names of private persons in the catalogue.
- I set the requirements and the rules. The agents write the specs from them, and I approve them.
- I check the results: the agents run the tests and audits, I read their reports and look at the live site
  myself.
- I decide what gets published. I chose and paid for the domain and the server. Agents set up both after my approval.

I cannot read code yet. I can explain how it works: the four main paths through the code are described in
[`docs/architektur.md`] (German).

## The rule

**Models read and propose. Code decides and writes.**

- Every fact needs a word-for-word quote from a source that the program fetched itself.
- A second, independent run checks that the quote really supports the fact.
- A draft may only rest on checked facts. Another run approves it.
- What is not backed by a source stays "unknown".
- Nothing is published automatically. I decide.

[Diagram, 5 boxes in a row:] Fetch the source (program) → Fact with quote (search agent) → Check the meaning
(verify agent) → Draft and approval (editor and verify agent) → Catalogue (only the program writes)

## An example: a wrong fact is caught

From the demo in the repository. It runs without network and without a model, on prepared example answers (`npm run demo`).

1. The search agent reads a playgroup's page. It finds "children aged 2 to 4 years" and proposes an age of 2 to 4 years. From
   "Registration is not needed" it makes "free".
2. The verify agent confirms the age. It rejects "free": the quote only says that you do not need to register. The
   same page lists a contribution of CHF 5 per family per visit.
3. The editor agent still writes "free" into its draft. The program refuses the draft because it rests on a
   rejected fact.
4. The second draft has only checked facts: the age, and that a parent stays. It is approved. The price stays "unknown" until a search agent backs it with a quote.

## Numbers

As of 17 October 2026.

- 295 entries in the catalogue, 26 in the archive
- all 7 districts of the canton
- 462 sources. The entries were checked between 22 September and 2 October, most of them on 27 and 28 September.
- 904 automated tests. On GitHub they run on every push; 7 of them are skipped there.
- deliberately left "unknown": the language for 263 entries, the price for 189, the minimum age for 199

### Pipeline, 2 to 17 October 2026

Most model runs (197 of 234) went through the earlier route with OpenAI Codex (2 and 3 October), and 37 have gone through Claude since 8 October. The rules in the code are the same for both.

- 234 model runs: 77 search, 111 verify, 46 editor
- 1,340 proposed facts. For 51 the program did not find the quote word for word in the source; for 36 it did not
  come from an official page of the activity. These facts were set to "unknown".
- 1,199 verdicts by the verify agent: 637 confirmed, 127 rejected, 435 "needs another source"
- Drafts by the editor agent: 23 approved, the program refused 9, the verify agent rejected 8
- 16 answers broke the rules (schema or evidence) and were discarded, including the 9 refused drafts
- The circuit breaker never opened. 6 jobs went to a human for a decision.

## Operations

- The site runs in Docker containers on a server in Switzerland (Infomaniak Public Cloud), with HTTPS through
  Caddy. This case study is served from there too.
- New versions go online only through a deploy script. It first starts the new version in a preview on the server.
  On 16 October the script found an error in the preview, so the new version did not go live. The script kept the old version running, and the site stayed up without interruption. A quarter of an hour later the corrected version was online.
- A backup is made every night, and my computer fetches a copy. Restoring was rehearsed on the live server on
  14 October 2026.
- Every five minutes the server checks whether the site responds. If not, an e-mail goes out. Every 30 minutes it also
  checks that the editorial pipeline is running and that its backup has arrived.
- The editorial pipeline does not run on the server but on my own computer.

## Checks before sending

On 17 October, before this page was sent, AI agents and automated tools checked the app. The yardsticks were WCAG 2.2
AA, OWASP ASVS (level 1) and Core Web Vitals; eight typical tasks were also walked through in a phone-sized browser. One finding: the age filter for children under 1
hid a baby swimming course "from 4 months". Nine issues were fixed the same day, and the fixes were published after my approval.

## Limits

- All entries are in German, French and English. Language models translated the German and French texts. A
  program checked numbers, times, weekdays and the like, and further language models checked the meaning. No native
  speaker of German or French has read them yet. The plain single pages without JavaScript (under /places/)
  are so far only in English.
- Many fields are "unknown". That is on purpose, but less convenient for parents.
- If the whole server goes down, it cannot send an e-mail any more. An outside check is still missing.
- Syncing between devices exists in the code but is switched off. Records therefore stay in the browser where they were made.

## Contact

Alex Shamrai · hello@minitandem.ch · github.com/avsomg
