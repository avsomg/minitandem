# German review, pass 1: changes applied

A plain record of the lines changed after the first-pass German language review (14 October 2026). Item numbers refer to that review (23 items). The wording is the reviewer's proposal; the notes at the end list where a rule had to be applied by analogy. Only the changed lines are listed, with their new text and line number.

## `README.de.md` (11 lines)

Line 8 (item 16):

```text
Minitandem ist ein Verzeichnis von Aktivitäten für Familien mit Kindern von 0 bis 6 Jahren im Kanton Freiburg (Schweiz). Es besteht aus einer statischen Web-App (Oberfläche auf Englisch, Deutsch und Französisch; die Katalogtexte sind englisch) und einer redaktionellen Pipeline, die den Katalog laufend überprüft: Modell-Worker mit engen Befugnissen recherchieren und verifizieren Fakten, und nur ein deterministischer Controller mit einer SQLite-Queue darf schreiben.
```

Line 12 (item 13):

```text
- **Das Produkt:** eine einfache Webseite ohne Framework und ohne externe Anfragen. Besucherinnen und Besucher filtern Einträge (im Code `card`) nach Alter, Ort und Kategorie. Favoriten, Notizen und Besuchspläne bleiben im eigenen Browser; ein optionaler kleiner Dienst kann die Daten einer Familie zwischen Geräten abgleichen.
```

Line 13 (item 2):

```text
- **Der Gedanke hinter der Pipeline:** Ein Modell darf das Web lesen und Vorschläge machen, aber es schreibt nie. Jede Behauptung braucht ein wörtliches Zitat aus einer Quelle, die der Controller selbst abgeholt hat. Ein zweiter, frischer Lauf beurteilt, ob das Zitat die Behauptung wirklich stützt. Ein Editor entwirft eine Änderung, ein dritter Lauf genehmigt den Entwurf anhand seines Hashes, und erst dann hängt der Controller sie an ein Journal an. Was nicht belegt ist, bleibt «unbekannt».
```

Line 50 (item 13):

```text
Ein Worker ist ein einzelner `claude -p`-Lauf mit nur den Werkzeugen Read, WebSearch und WebFetch, in einem temporären Verzeichnis, mit frischem Kontext und einem JSON-Schema für die Antwort. Grenzen: 4 Jobs pro Lauf, 30 Minuten pro Batch, 50 Werkzeugaufrufe pro Job, 15 Minuten Lease, 3 Versuche, bevor ein Job Aufmerksamkeit braucht. Drei Fehler derselben Kategorie bei verschiedenen Einträgen innerhalb einer Stunde öffnen einen Circuit Breaker. Siehe [`editorial/OPERATIONS.md`](editorial/OPERATIONS.md) (englisch) und [`docs/architektur.md`](docs/architektur.md).
```

Line 71 (item 3, 13):

```text
**Die Demo.** `npm run demo` lässt drei erfundene Übungseinträge durch den echten Controller-Code laufen, mit einer temporären Queue: Ein Such-Worker zieht Claims mit wörtlichen Zitaten aus einer abgeholten Seite; der Verifizierer weist einen Claim zurück, dessen Zitat ihn nicht stützt; der Controller lehnt einen Entwurf ab, der auf diesem Claim aufbaut; ein korrigierter Entwurf wird genehmigt und angewendet; die redaktionellen Release-Gates sind bestanden. Das Web und die Modelle sind durch aufgezeichnete Antworten ersetzt: Die Seite ist eine gespeicherte Datei, und die Worker-Antworten sind von Hand geschriebene Fixtures, die dem Worker-Vertrag folgen. Kein Modell hat sie erzeugt. Die QA-Stufe des Release-Checks wird eingereiht, aber nicht ausgeführt. Nichts berührt das Netzwerk oder die echte Queue.
```

Line 82 (item 23, 13):

```text
Wo sich eine Prüfung aufteilen liess, bleibt der Teil, der nur versionierte Daten braucht, in der Suite für saubere Klone (zum Beispiel: Jeder aktuelle Eintrag ist bereits von der versionierten External-Review-Baseline gedeckt, ein Build braucht also keine Belege). Auf einem sauberen Klon läuft der Build mit `--public`: Die Publikations-Gates brauchen die privaten Belege, werden daher übersprungen, und die Ausgabe des Builds sagt `publicationGates: skipped`. Im Arbeitsordner des Eigentümers führt derselbe Befehl sie weiterhin aus.
```

Line 91 (item 23):

```text
- die Vercel-Kontoidentität des Releases (`editorial/release-identity.json`; ein Beispiel mit Platzhaltern ist versioniert), lokale Maschineneinstellungen und Schlüssel;
```

Line 106 (item 13):

```text
Es belegt weder, wie viele Personen die Seite nutzen, noch wie viel Traffic sie hat, noch wie genau oder wie vollständig der Katalog ist. Jeder Eintrag zeigt, wann er geprüft wurde und was noch unbestätigt ist; die Abdeckungszahlen in `editorial/canton-coverage.generated.json` sagen, was durchsucht wurde, nicht dass eine Suche vollständig wäre. Der Katalog führt Kontakte auf, die Veranstalter selbst veröffentlichen; ob namentlich genannte Personen in einem öffentlichen Repository erscheinen sollen, ist eine offene Entscheidung des Eigentümers (siehe `docs/publication-scope.md`).
```

Line 112 (item 13):

```text
- Build: `node build.mjs` schreibt die Seite nach `.publish/` (Seite, Skripte, pro Eintrag eine einfache Seite unter `places/`, `sitemap.xml`, `research.md`). `site.mjs` hält den öffentlichen Origin.
```

Line 120 (item 11):

```text
Favoriten, Notizen, Status, Besuchspläne, das Alter des Kindes und der gespeicherte Startpunkt für Wegbeschreibungen liegen im Browser der Besucher (Speicherschlüssel `minitandem-…`; Schlüssel der früheren Version verschiebt `storage-migration.js` einmalig). Nichts wird irgendwohin gesendet, solange der Besucher den optionalen Abgleichdienst nicht verbindet.
```

Line 126 (item 13):

```text
Bis dahin wird keine Lizenz erteilt. Fremde Dateien in `assets/` behalten ihre eigenen Lizenzen (Leaflet, Leaflet.markercluster, Lucide; die Lizenztexte liegen daneben). Die Fotografie `assets/papiliorama-outside.jpg` ist auf dem Eintrag, der sie zeigt, mit Quelle angegeben (gemeinfrei, Wikimedia Commons).
```

## `docs/architektur.md` (10 lines)

Line 29 (item 13):

```text
- **Einreihen.** Ein Job ist eindeutig durch `(kind, card_id, input_revision)`. Dieselbe Aufgabe für denselben Eintragsstand (im Code `card`) entsteht nicht zweimal. `reconcile` setzt Jobs auf `superseded`, die der aktuelle Stand nicht mehr verlangt.
```

Line 30 (item 13):

```text
- **Lease.** `claim` läuft in einer `BEGIN IMMEDIATE`-Transaktion. Zuerst werden abgelaufene Leases wie ein Fehler behandelt («Lease expired»). Dann wählt es den Job mit der höchsten Priorität, auf dessen Eintrag kein anderer Job gerade eine Lease hält. QA, Patch-Review und Release schliessen sich gegenseitig aus. Der Job bekommt ein Token und ein Ablaufdatum (Standard 15 Minuten) und zählt den Versuch hoch.
```

Line 33 (item 13):

```text
- **Circuit Breaker.** `fail` ruft `noteFailure` auf. `failureCategory` ordnet die Meldung ein (`provider-limit`, `provider-configuration`, `contract`). Drei Fehler **derselben Kategorie bei drei verschiedenen Einträgen** innerhalb einer Stunde seit dem letzten Reset öffnen den Breaker; bei `contract` müssen sie zudem dieselbe Job-Art betreffen. Solange er offen ist, gibt `claim` für alle Rollen ausser `qa` und `release` nichts mehr heraus. Zurücksetzen geht nur mit `resetCircuit(grund)`, und der Grund darf nicht leer sein.
```

Line 34 (item 8):

```text
- **Gegendruck.** Sammelt sich bei Verify, Editor und QA ein Rückstau von 24 Jobs, hört die gewöhnliche Suche auf; dringende Jobs bleiben möglich.
```

Line 36 (item 22, 13):

```text
**Warum so.** Die Queue ist die einzige Quelle der Wahrheit; ein abgestürzter Worker hinterlässt nur eine ablaufende Lease. Outbox und Transaktion verhindern, dass ein Ergebnis halb geschrieben wird: Entweder sind Artefakt, Folgejobs und Dateien eingetragen oder nichts. Eindeutige Schlüssel machen wiederholtes Einreihen harmlos. Der Breaker ist für den Fall gedacht, dass ein ganzer Anbieter ausfällt oder die Antworten einen Vertrag nicht mehr erfüllen: Ohne ihn würde derselbe Fehler bei jedem Eintrag einen der drei Versuche verbrauchen.
```

Line 46 (item 14):

```text
2. **Synchronisieren und Übernehmen.** `syncQueue` leert die Outbox und gleicht die Queue mit dem aktuellen Katalog ab; danach wird ein Job übernommen.
```

Line 47 (item 1):

```text
3. **Quellen holen.** Über `prepareEvidence` ruft der **Controller** die Quellen selbst ab (`captureUrl`: nur öffentliche https-Adressen, DNS-Prüfung gegen private Bereiche, Grössenlimit, höchstens 4 Weiterleitungen) und trägt jeden Schnappschuss in die Queue ein.
```

Line 51 (item 4, 13, 14):

```text
7. **Commit.** `commitResult` läuft in einer einzigen Transaktion: Lease prüfen, prüfen, dass der Eintrag seit der Übernahme unverändert ist, dann Prüfungen je Job-Art (Claims, Verdikte, Entwurf, Evidenz-Bindungen, Review per Hash, Editor ≠ Reviewer), Folgejobs einreihen, Dateien über die Outbox schreiben.
```

Line 64 (item 12):

```text
3. `plan` entscheidet nach Tag und Stunde. Einmal pro Tag (nach der Stunde aus der Policy) läuft die tägliche Wartung: `monitor`, `review`, `discover-events`, `canton-audit`, `work-packets`. Danach folgen immer `workflow sync`, ein Batch (`agent-run --chain`, begrenzt durch `limitPerRun` und die Tagesgrenze `maxJobsPerDay`), an Wartungstagen eine Sicherung der Queue, die beiden externen Reports und `workflow report`. Die führende Rolle wechselt bei normalen Läufen reihum.
```

Line 67 (item 14):

```text
6. Am Ende vergleicht `digest` die Ereignisse der Queue seit dem letzten Zyklus (übernommen, abgeschlossen, Wiederholungen, Aufmerksamkeit, Breaker, Login) und der Zyklus schreibt `latest.json`, ein Tagesprotokoll und den neuen Zustand.
```

## `docs/betrieb.md` (2 lines)

Line 18 (item 17):

```text
- `docker/Caddyfile`: `www.minitandem.ch` leitet dauerhaft auf `minitandem.ch` um; `minitandem.ch` wird mit `encode zstd gzip` ausgeliefert, die Editor-Pfade (`/admin`, `/api/v1/admin/*`) sind am Proxy gesperrt (404), alles andere geht an `app:8787`.
```

Line 101 (item 18):

```text
**Nur eine beschädigte `families.json`:** Der Dienst antwortet für die betroffene Anfrage mit 500 und läuft weiter. Aus dem Volume die jüngste unbeschädigte Kopie wählen: `docker compose exec app ls -1t /state` zeigt die `backup-*.json`; die gewählte Datei wird als `families.json` zurückkopiert (`docker compose exec app cp /state/backup-… /state/families.json`).
```

## `strings-de.js` (19 lines)

Line 5 (item 9):

```text
  'meta.description': 'Angebote für Familien mit Kindern von 0 bis 6 Jahren im Kanton Freiburg: Alter, Zeiten, Preis, Adresse und Quellen. Ohne Konto.',
```

Line 14 (item 9):

```text
  'intro.title': 'Angebote für Familien mit Kindern von 0 bis 6 Jahren im Kanton Freiburg',
```

Line 30 (item 7):

```text
  'pill.age': 'Alter des Kindes',
```

Line 58 (item 9):

```text
  'filter.ageHint': '0 bedeutet unter 1 Jahr. Das Verzeichnis deckt das Alter von 0 bis 6 Jahren ab.',
```

Line 103 (item 19):

```text
  'preset.short': 'Höchstens 1 Std. oder früher gehen möglich',
```

Line 170 (item 20):

```text
  'parent.no.long': 'Ohne Begleitung: Das Kind nimmt ohne erwachsene Person teil',
```

Line 172 (item 10):

```text
  'parent.unknown.long': 'Nicht angegeben, ob eine erwachsene Person dabeibleibt',
```

Line 294 (item 21):

```text
  'visit.savedMemory': 'Der Besuch ist nur bis zum Schliessen der Seite gespeichert. Exportieren Sie eine Sicherung.',
```

Line 303 (item 5):

```text
  'visit.bring': 'Mitzubringende Dinge, eines pro Zeile',
```

Line 322 (item 6):

```text
  'usefulness.yes': 'Ja, wir haben ihn hier ausgewählt',
```

Line 323 (item 6):

```text
  'usefulness.no': 'Nein, wir kannten ihn schon',
```

Line 373 (item 21):

```text
  'shared.savedMemory': 'Die Auswahl ist nur bis zum Schliessen der Seite geöffnet; Speichern ist nicht möglich.',
```

Line 397 (item 9, 15):

```text
  'about.intro': 'Ein Verzeichnis von Familienangeboten im Kanton Freiburg für Kinder von 0 bis 6 Jahren. Alle sieben Bezirke sind abgedeckt, die Auswahl ist aber keine vollständige Erhebung der Orte: Einige Gemeinden und Formate sind noch nicht geprüft. Der Status jedes Eintrags und seine offenen Fragen werden getrennt angezeigt. Das Datum der letzten Prüfung steht bei jedem Eintrag. Ausgewählte Quellenseiten werden von einem Überwachungsprogramm verglichen, und die Änderungen werden geprüft, bevor sie veröffentlicht werden.',
```

Line 406 (item 11):

```text
  'about.privacy': 'Gemerkte Angebote, Pläne und Notizen werden in diesem Browser gespeichert. Wenn Sie den optionalen Abgleichdienst verbinden, werden sie zusätzlich an diesen Dienst gesendet. Der Zugangsschlüssel wird getrennt von der Sicherung im Browser gespeichert. Geht die Verbindung verloren, bleiben Ihre Änderungen lokal, bis der nächste Versuch erfolgt. Es lohnt sich, eine Sicherungsdatei an einem anderen Ort aufzubewahren.',
```

Line 411 (item 11):

```text
  'data.syncTitle': 'Abgleich zwischen Geräten (optional)',
```

Line 434 (item 21):

```text
  'data.storageOff': 'Lokaler Speicher ist nicht verfügbar; Ihre Aufzeichnungen bleiben nur bis zum Schliessen dieser Seite gespeichert.',
```

Line 453 (item 21):

```text
  'planImport.memory': 'Der Plan ist nur bis zum Schliessen der Seite gespeichert. Exportieren Sie eine Sicherung.',
```

Line 469 (item 21):

```text
  'import.memory': 'Die Aufzeichnungen sind nur bis zum Schliessen der Seite geöffnet. Speichern ist nicht möglich: Exportieren Sie eine Sicherung.',
```

Line 480 (item 15):

```text
  'report.note': 'Machen Sie keine Angaben zu Ihrem Kind oder zu anderen Familien. Die Korrektur wird geprüft, bevor etwas veröffentlicht wird.',
```

## `strings-en.js` (2 lines)

Line 397 (item 15, English counterpart):

```text
  'about.intro': 'A directory of family activities in canton Fribourg for children aged 0–6. All seven districts are covered, but the selection is not a complete census of places: some communes and formats are not checked yet. The status of each card and its open questions are shown separately. The date of the last check is on every card. Selected source pages are compared by a monitor, and changes are reviewed before they are published.',
```

Line 480 (item 15, English counterpart):

```text
  'report.note': 'Do not include details about your child or other families. The correction is checked before anything is published.',
```

## `strings-fr.js` (2 lines)

Line 397 (item 15, French counterpart):

```text
  'about.intro': 'Un répertoire d’activités en famille dans le canton de Fribourg, pour les enfants de 0 à 6 ans. Les sept districts sont couverts, mais la sélection n’est pas un recensement complet des lieux : certaines communes et certains formats ne sont pas encore vérifiés. Le statut de chaque fiche et ses questions ouvertes sont indiqués séparément. La date de la dernière vérification figure sur chaque fiche. Un outil de veille compare des pages sources choisies, et les changements sont examinés avant leur publication.',
```

Line 480 (item 15, French counterpart):

```text
  'report.note': 'N’indiquez aucun détail sur votre enfant ni sur d’autres familles. La correction est vérifiée avant toute publication.',
```

Total changed lines: 46 in 6 files.

## Notes on how rules were applied

- Item 13 ("Karte" for a catalogue entry becomes "Eintrag"): applied to every card meaning in `README.de.md` and `docs/architektur.md`, including the compounds "Übungskarten" (now "Übungseinträge") and "Kartenstand" (now "Eintragsstand"), and the matching articles and pronouns (die/der, sie/er). "Karte" meaning the geographic map was left alone (`README.de.md` line 111 and every map string in `strings-de.js`). The explanation "(im Code `card`)" appears once per document: `README.de.md` line 12 and `docs/architektur.md` line 29.
- Item 14: "Claimen" in the step heading became "Übernehmen" (capitalised, because it is a noun in a heading). "beantragt" in the cycle digest list became "übernommen"; the review gives no explicit target for it, but the digest counts the queue event `claimed`. "Claim" meaning a statement made by the model, and function names in backticks (`claim`, `captureClaims`, `validateClaims`), were not touched.
- Item 7: the primary proposal "Alter des Kindes" was used. The fallback "Alter" was not needed: the label is not truncated at 320, 360, 375 or 390 px wide.
- Item 21: the five strings were changed by the review's pattern. Where the original said "geöffnet" (lines 373 and 469) the participle was kept, because saving is not possible there and "gespeichert" would contradict the next sentence. Line 373 gained "nur" to match the pattern; line 434 uses "dieser Seite" as in the original.
- Item 15: `strings-en.js` and `strings-fr.js` now use the same passive construction as the German text, so the three languages no longer promise a human editorial team. No dictionary key was added, removed or renamed.
- Item 19 was applied verbatim; the longer chip text fits on one line at 320 px.

## Not applied

- The review's section of optional suggestions (the original is acceptable there, the variant only reads slightly better): not part of the 23 items, so left as it is. These are `README.de.md` lines 98 to 100 and 112, `docs/betrieb.md` lines 86 and 113, `docs/architektur.md` line 14, and `strings-de.js` lines 398 and 403.
- Not listed in the review but the same pattern as item 9: `strings-de.js` lines 280 and 281 ("Alter von 1–6 Kindern und 1–4 Erwachsenen"). Left unchanged; for the reviewer to decide.
- "Familienabgleich" (`README.de.md` lines 66 and 113) is a different term from "Familiendienst" and was left unchanged.
