# Minitandem: a web app built and run with AI agents

A directory of family activities in canton Fribourg. By Alex Shamrai.

[Buttons:] Open the app · Code on GitHub · [Video, once V8 is done]

## What it is

Minitandem collects activities for families with children from 0 to 6 across canton Fribourg, from play and nature
to music and horses. Parents filter by age, place and category. The interface is in German, French and English.

The hard part is not the site but the data. Activities change, and a language model easily makes up an answer when
a source says nothing.

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

From the demo in the repository. It runs without network and without a model, on recorded answers (`npm run demo`).

1. The search agent reads a playgroup's page. It finds "children aged 2 to 4 years" and proposes an age of 2 to 4 years. From
   "Registration is not needed" it makes "free".
2. The verify agent confirms the age. It rejects "free": the quote only says that you do not need to register. The
   same page lists a contribution of CHF 5 per family and visit.
3. The editor agent still writes "free" into its draft. The program refuses the draft because it rests on a
   rejected fact.
4. The second draft has only checked facts: the age, and that a parent stays. It is approved. The price stays "unknown" until a search agent backs it with a quote.

## Numbers

As of 14 October 2026.

- 295 entries in the catalogue, 26 in the archive
- all 7 districts of the canton
- 462 sources
- 491 automated tests. On GitHub they run on every push; 6 of them are skipped there.
- deliberately left "unknown": the language for 263 entries, the price for 189, the minimum age for 199

### Pipeline, 2 to 13 October 2026

Most model runs (197 of 205) still went through the earlier route with OpenAI
Codex (2 and 3 October), 8 through Claude. The rules in the code are the same for both.

- 205 model runs: 72 search, 100 verify, 33 editor
- 1,219 proposed facts. For 46 the program did not find the quote word for word in the source, for 33 it did not
  come from an official page of the activity. These facts were set to "unknown".
- 1,078 verdicts by the verify agent: 567 approved, 123 rejected, 388 "needs another source"
- Drafts by the editor agent: 20 approved and applied, the program refused 5, the verify agent rejected 5
- 12 answers broke the rules (schema or evidence) and were discarded, including the 5 refused drafts
- The circuit breaker never opened; once a human had to step in.

## Operations

- The site runs in Docker containers on a server in Switzerland (Infomaniak Public Cloud), with HTTPS through
  Caddy. This case study comes from there too.
- It is backed up every night. Restoring was rehearsed on the live server on 14 October 2026.
- Every five minutes the server checks that the site answers. If not, an e-mail goes out.
- The editorial pipeline does not run on the server but on my own computer.

## What I do and what the agents do

AI agents write the code: Claude Code, earlier Codex. My part:

- I decide what the product does and what it does not. For example: no names of private persons in the catalogue.
- I set the requirements and the rules. The agents write the specs from them, and I approve them.
- I check the results: the agents run the tests and audits, I read their reports and look at the live site
  myself.
- I decide what gets published. I chose and paid for the domain and the server. Agents set up both after my approval.

I cannot read code fluently yet. I can explain how it works: the four main paths through the code are described in
[`docs/architektur.md`] (German).

## Limits

- The catalogue texts are in English. German and French are only there for the interface.
- Many fields are "unknown". That is on purpose, but less convenient for parents.
- If the whole server goes down, it cannot send an e-mail any more. An outside check is still missing.
- Syncing between devices is open to the public only for one demo family.

## Contact

Alex Shamrai · hello@minitandem.ch · github.com/avsomg
