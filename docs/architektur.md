# Architektur: vier Wege durch den Code

Kurzer Leitfaden für Leserinnen und Leser des Codes. Er erklärt vier Abläufe: eine Anfrage an den Server, die Lease eines Jobs samt Versuchen und Circuit Breaker, einen einzelnen Worker-Lauf und einen ganzen Zyklus. Zu jedem Ablauf steht, was er tut, warum er so gebaut ist und was bei einem Fehler passiert. Verweise nennen Datei und Funktion, keine Zeilennummern, damit sie nicht veralten.

Gemeinsames Prinzip aller vier Wege: **Modelle lesen und schlagen vor, Code entscheidet und schreibt.** Einziger Schreibpfad für Katalogänderungen ist `commitResult` in `editorial/workflow.mjs`, und zwar über die Outbox der Queue.

## 1. Eine Anfrage an den Server

**Dateien:** `server.mjs` (`createServer`, `readDb`, `saveDb`, `auth`, `cleanProfile`, `staticFile`, `isClientError`), `site.mjs` (erlaubter Origin).

**Was passiert.**
1. Jede Antwort bekommt `X-Content-Type-Options` und `Referrer-Policy`. Trägt die Anfrage einen `Origin`-Header, wird er gegen eine feste Liste geprüft (die Seite selbst, localhost, optional `MINITANDEM_ORIGINS`). Ein fremder Origin ergibt 403, `OPTIONS` beantwortet der Server selbst.
2. `GET /healthz` (und `HEAD`) antwortet sofort aus dem Speicher: kein Schlüssel, kein Zugriff auf Dateien.
3. Alles ausser `/api/…` ist ein statischer Zugriff (`staticFile`). Er antwortet auf `GET` und `HEAD`, weist Pfade mit Punkt-Segmenten oder `..` ab und löst den Pfad innerhalb von `.publish/` auf. Für einen Ordner liefert er dessen `index.html`; fehlt der Schrägstrich am Ende, leitet er zuerst mit 301 auf die Adresse mit Schrägstrich um. Das Editor-Panel (`/admin`) kommt aus `editorial/`.
4. Unter `/api/v1/…` wird der Zustand gelesen und der Bearer-Schlüssel geprüft: `auth` bildet den SHA-256-Hash des Schlüssels und schlägt ihn in `families.json` nach. Der Schlüssel selbst wird nie gespeichert. Editor-Routen vergleichen mit `adminHash`.
5. `PUT /api/v1/family` liest den Body (JSON, höchstens 1 MB), liest den Zustand **erneut**, prüft die Revision und schreibt. Zwischen dem erneuten Lesen und `saveDb` gibt es kein `await`; der Prozess läuft in einem einzigen Thread, daher können zwei gleichzeitige Schreiber sich nicht überholen. Der zweite bekommt 409 mit der aktuellen Kopie.
6. `saveDb` kopiert die bisherige Datei als `backup-….json` (die letzten 20 bleiben) und ersetzt `families.json` atomar (temporäre Datei, dann `rename`).
7. `POST /api/v1/corrections` validiert die Meldung mit `MinitandemExchange.report`, bildet aus ihr eine Kennung (Hash) und legt sie als `pending-review` ab. Dieselbe Meldung ergibt dieselbe Kennung und schreibt nichts doppelt. Der Katalog wird dadurch nie verändert.

**Warum so.** Eine Datei mit atomarem Austausch genügt für eine kleine Familienzahl und braucht keine Datenbank, die betrieben werden müsste. Dass die Schlüssel nur als Hash gespeichert werden, begrenzt den Schaden, falls die Zustandsdatei in falsche Hände gerät. Die Revisionsprüfung verhindert, dass ein Gerät unbemerkt die Änderungen eines anderen überschreibt: Der Client muss die Kopie des Servers zusammenführen.

**Wenn etwas schiefgeht.** Fehlender oder falscher Schlüssel: 401. Fremder Origin: 403. Revision veraltet: 409 mit der aktuellen Kopie. Zu viele Korrekturen warten auf die Prüfung (Standard 500): 429. Ungültiger Body, zu grosser Body oder ein Fehler des Aufrufers: 400 (`isClientError`; Fehlercodes der Module `planning` und `exchange` haben die Form `plan.invalidVisit`). Alles andere ist 500 mit der festen Meldung «Server error»; der Grund geht nur ins Log (`console.error`). Eine beschädigte `families.json` ergibt ebenfalls 500 für genau diese Anfrage; der Prozess läuft weiter. Als Ausweg dient dann eine der Sicherungen `backup-*.json` (siehe `docs/betrieb.md`).

## 2. Lease, Versuche und Circuit Breaker in der Queue

**Dateien:** `editorial/jobs.mjs` (`JobQueue`: `enqueue`, `reconcile`, `claim`, `renew`, `finish`, `fail`, `retryInside`, `noteFailure`, `resetCircuit`, `flush`; `failureCategory`).

**Was passiert.**
- **Einreihen.** Ein Job ist eindeutig durch `(kind, card_id, input_revision)`. Dieselbe Aufgabe für denselben Stand eines Eintrags (im Code `card`) entsteht nicht zweimal. `reconcile` setzt Jobs auf `superseded`, die der aktuelle Stand nicht mehr verlangt.
- **Lease.** `claim` läuft in einer `BEGIN IMMEDIATE`-Transaktion. Zuerst werden abgelaufene Leases wie ein Fehler behandelt («Lease expired»). Dann wählt es den Job mit der höchsten Priorität, auf dessen Eintrag kein anderer Job gerade eine Lease hält. QA, Patch-Review und Release schliessen sich gegenseitig aus. Der Job bekommt ein Token und ein Ablaufdatum (Standard 15 Minuten) und zählt den Versuch hoch.
- **Abschluss.** `finish` verlangt Token, passende Rolle und eine nicht abgelaufene Lease. Das Ergebnis wird als unveränderliches Artefakt (Hash über den Inhalt) gespeichert, die zu schreibenden Dateien kommen in die **Outbox**, Folgejobs werden in derselben Transaktion eingereiht. `flush` schreibt die Outbox erst danach in die Dateien (Pfad-Whitelist, temporäre Datei plus `rename`, Artefakte dürfen nicht abweichend überschrieben werden).
- **Versuche.** `retryInside` setzt den Job auf `retry` mit Wartezeit `min(24 h, 1 h · 2^(Versuch−1))`. Nach dem dritten Versuch wird daraus `attention`: Ein Mensch muss hinsehen. Die Zählung wird nicht zurückgesetzt. Eine Ausnahme ist der Ausfall des Anbieters (Nutzungslimit, Anmeldung): `releaseUncounted` gibt den Versuch zurück und hält den Job zehn Minuten in `retry`; Vertragsfehler zählen immer.
- **Circuit Breaker.** `fail` ruft `noteFailure` auf. `failureCategory` ordnet die Meldung ein (`provider-limit`, `provider-configuration`, `contract`). Drei Fehler **derselben Kategorie bei drei verschiedenen Einträgen** innerhalb einer Stunde seit dem letzten Reset öffnen den Breaker; bei `contract` müssen sie zudem dieselbe Job-Art betreffen. Solange er offen ist, gibt `claim` für alle Rollen ausser `qa` und `release` nichts mehr heraus. Zurücksetzen geht nur mit `resetCircuit(grund)`, und der Grund darf nicht leer sein.
- **Gegendruck.** Sammelt sich bei Verify, Editor und QA ein Rückstau von 24 Jobs, hört die gewöhnliche Suche auf; dringende Jobs bleiben möglich.

**Warum so.** Die Queue ist die einzige Quelle der Wahrheit; ein abgestürzter Worker hinterlässt nur eine ablaufende Lease. Outbox und Transaktion verhindern, dass ein Ergebnis halb geschrieben wird: Entweder sind Artefakt, Folgejobs und Dateien eingetragen oder nichts. Eindeutige Schlüssel machen wiederholtes Einreihen harmlos. Der Breaker ist für den Fall gedacht, dass ein ganzer Anbieter ausfällt oder die Antworten einen Vertrag nicht mehr erfüllen: Ohne ihn würde derselbe Fehler bei jedem Eintrag einen der drei Versuche verbrauchen.

**Wenn etwas schiefgeht.** Ein Worker, der seine Lease verliert, kann nicht mehr abschliessen («Invalid, expired or wrong-role lease»). Fehler zählen als Versuch und steigern die Wartezeit. Ein offener Breaker stoppt die Modellarbeit, nicht QA und Release. Der Zustand liegt in einer SQLite-Datei (WAL-Modus, `busy_timeout` 10 s); `workflow.mjs backup` legt Kopien an.

## 3. Ein Worker-Lauf

**Dateien:** `editorial/agent-run.mjs` (`runJobs`, `prepareEvidence`, `captureClaims`, `captureDraft`, `recordRejectedOutput`, `modelRoute`, `promptFor`), `editorial/claude-worker.mjs` (`runClaudeWorker`, `claudeSettings`, `claudeArgs`), `editorial/worker-schema.mjs` (`decodeWorkerOutput`), `editorial/evidence.mjs` (`captureUrl`, `locateQuote`), `editorial/workflow.mjs` (`commitResult`, `validateClaims`, `validateBindings`, `validateDraft`).

**Was passiert** (eine Schleife in `runJobs`, höchstens 4 Jobs pro Lauf).
1. **Vorprüfung.** Hat sich der Code unter `editorial/` seit dem Start geändert (`runtime-contract.mjs`), bricht der Lauf ab. Vor dem ersten Modell-Job prüft ein Mini-Request, ob der Claude-Login wirklich funktioniert; sonst bleibt nur QA übrig.
2. **Synchronisieren und Übernehmen.** `syncQueue` leert die Outbox und gleicht die Queue mit dem aktuellen Katalog ab; danach wird ein Job übernommen.
3. **Quellen holen.** Über `prepareEvidence` ruft der **Controller** die Quellen selbst ab (`captureUrl`: nur öffentliche https-Adressen, DNS-Prüfung gegen private Bereiche, Grössenlimit, höchstens 4 Weiterleitungen) und trägt jeden Schnappschuss in die Queue ein.
4. **Worker.** `runClaudeWorker` startet genau einen `claude -p`-Prozess in einem temporären Verzeichnis ausserhalb der Home-Ordner, mit den Werkzeugen Read, WebSearch und WebFetch, ohne Bash und Schreibrechte, ohne MCP, mit frischem Kontext, einem JSON-Schema für die Antwort, Zeitlimit (12 Minuten) und Budgets für Werkzeugaufrufe und Ausgabegrösse. Die Quellen liegen als Dateien im Verzeichnis.
5. **Vertrag.** `decodeWorkerOutput` prüft die Antwort strikt gegen das Schema der Job-Art (Ajv).
6. **Belege.** `captureClaims` prüft jedes Zitat wörtlich im vom Controller abgeholten Text; was nicht passt, wird zu «unbekannt», und ein kritischer Claim ohne offizielle Quelle für genau dieses Angebot wird heruntergestuft. `captureDraft` bindet die Belege eines Editor-Entwurfs an registrierte Schnappschüsse.
7. **Commit.** `commitResult` läuft in einer einzigen Transaktion: Lease prüfen, prüfen, dass der Eintrag seit der Übernahme unverändert ist, dann Prüfungen je Job-Art (Claims, Verdikte, Entwurf, Evidenz-Bindungen, Review per Hash, Editor ≠ Reviewer), Folgejobs einreihen, Dateien über die Outbox schreiben.

**Warum so.** Der Worker hat nichts, womit er etwas verändern könnte, und alles, was er behauptet, wird im Controller gegen eigene Belege geprüft; ein Zitat ist nur ein Beleg, wenn der Controller es im selbst abgeholten Text findet. Dass ein Zitat vorhanden ist, beweist aber nicht, dass es den Wert stützt. Deshalb urteilt ein zweiter, unabhängiger Lauf über die Bedeutung, und ein Entwurf darf nur auf genehmigte Claims bauen. `npm run demo` zeigt genau diese Kette.

**Wenn etwas schiefgeht.** Fehlschlag oder Abweisung beim Commit: Die Antwort wird als Artefakt mit `rejected: true` aufbewahrt (`recordRejectedOutput`), nichts erreicht den Katalog, der Job geht über `queue.fail` in `retry` (siehe Weg 2), und die Fehlermeldung steht im Prompt des nächsten Versuchs. Ein Fehler des Anbieters (Login, Limit) beendet den ganzen Lauf, damit nicht jeder weitere Job einen Versuch verbraucht. Ist die Zeit des Batches (30 Minuten) aufgebraucht, hört der Lauf mit Grund `run-time-budget` auf.

## 4. Ein Zyklus

**Dateien:** `editorial/cycle.mjs` (`runCycle`, `plan`, `acquireLock`, `queueMarks`, `digest`, `needsOwner`, `codexSchedules`), `editorial/cycle-policy.json`.

**Was passiert.** `runCycle` ist die Routine für einen Timer, ohne Modell in der Schleife.
1. Existiert `editorial/cycle.pause`, endet der Zyklus sofort mit einem Vermerk.
2. Sind die in der Policy genannten Codex-Automationen noch aktiv, wird nichts gestartet: Zwei Zeitpläne sollen nie gleichzeitig an der Queue arbeiten.
3. `plan` entscheidet nach Tag und Stunde. Einmal pro Tag (nach der Stunde aus der Policy) läuft die tägliche Wartung: `monitor`, `review`, `discover-events`, `canton-audit`, `work-packets`. Danach folgen immer `workflow sync`, ein Batch (`agent-run --chain`, begrenzt durch `limitPerRun` und die Tagesgrenze `maxJobsPerDay`), an Wartungstagen eine Sicherung der Queue, die beiden externen Reports und `workflow report`. Die führende Rolle wechselt bei normalen Läufen reihum.
4. `acquireLock` legt ein Verzeichnis `lock` mit der Prozess-ID an. Ein Lock gilt höchstens drei Stunden und nur, solange der Prozess lebt; ein verwaister Lock wird entfernt.
5. Jeder Schritt ist ein eigener Node-Prozess mit Zeitlimit. Schlägt `sync` fehl, werden alle Schritte übersprungen, die davon abhängen.
6. Am Ende fasst `digest` die Ereignisse der Queue zusammen, die während dieses Zyklus entstanden sind: übernommen, abgeschlossen, Wiederholungen, Aufmerksamkeit, Breaker, Login. Gezählt wird ab der Ereignisnummer, die der Zyklus beim Start liest; Änderungen zwischen zwei Zyklen, etwa durch Läufe von Hand, erscheinen in dieser Zusammenfassung nicht. Dann schreibt der Zyklus `latest.json`, ein Tagesprotokoll und den neuen Zustand.

**Warum so.** Der Zyklus ersetzt einen früheren Chat-Zeitplan durch Code, den man lesen und testen kann; jeder Schritt hat eine Obergrenze, damit ein hängender Schritt den Zyklus nicht blockiert. Die Tagesgrenze begrenzt, wie viele Modelljobs ein Tag verbrauchen kann.

**Wenn etwas schiefgeht.** Ein fehlgeschlagener Schritt steht im Protokoll (`failedSteps`) und der Prozess endet mit Exit-Code 1. `needsOwner` löst eine Benachrichtigung auf dem Mac aus, wenn der Zyklus blockiert war (etwa wegen aktiver Codex-Zeitpläne), ein Schritt scheiterte, ein Job Aufmerksamkeit braucht, der Breaker sich öffnete, der Login fehlte oder der Batch aus einem Grund stoppte. Läuft schon ein Zyklus, wird der neue ohne Fehler übersprungen. Auf dem Server (`docs/betrieb.md`) läuft dieser Zyklus nicht: Er gehört auf den Rechner des Eigentümers.
