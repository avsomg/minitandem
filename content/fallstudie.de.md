# Minitandem: eine Web-App, gebaut und betrieben mit KI-Agenten

Ein Verzeichnis von Familienangeboten im Kanton Freiburg. Von Alex Shamrai.

[Knöpfe:] Zur App · Code auf GitHub · [Video, sobald V8 fertig ist]

## Worum es geht

Minitandem sammelt Angebote für Familien mit Kindern von 0 bis 6 Jahren im ganzen Kanton Freiburg, von Spielen und
Natur bis Musik und Pferden. Eltern filtern nach Alter, Ort und Kategorie. Die App gibt es auf Deutsch,
Französisch und Englisch.

Schwierig ist nicht die Seite, sondern die Daten. Angebote ändern sich, und ein Sprachmodell erfindet leicht eine
Antwort, wenn eine Quelle nichts dazu sagt.

## Die Regel

**Modelle lesen und schlagen vor. Code entscheidet und schreibt.**

- Jede Angabe braucht ein wörtliches Zitat aus einer Quelle, die das Programm selbst abgerufen hat.
- Ein zweiter, unabhängiger Lauf prüft, ob das Zitat die Angabe wirklich stützt.
- Ein Entwurf darf sich nur auf geprüfte Angaben stützen. Ein weiterer Lauf genehmigt ihn.
- Was nicht belegt ist, bleibt «unbekannt».
- Nichts wird automatisch veröffentlicht. Das entscheide ich.

[Schema, 5 Kästchen in einer Reihe:] Quelle abrufen (Programm) → Angabe mit Zitat (Such-Agent) → Bedeutung prüfen
(Prüf-Agent) → Entwurf und Genehmigung (Editor- und Prüf-Agent) → Katalog (nur das Programm schreibt)

## Ein Beispiel: Eine falsche Angabe wird abgefangen

Aus der Demo im Repository. Sie läuft ohne Netz und ohne Modell, mit aufgezeichneten Antworten (`npm run demo`).

1. Der Such-Agent liest die Seite einer Spielgruppe. Er findet «children aged 2 to 4 years» und schlägt ein Alter von
   2 bis 4 Jahren vor. Aus «Registration is not needed» macht er «kostenlos».
2. Der Prüf-Agent bestätigt das Alter. «Kostenlos» lehnt er ab: Das Zitat sagt nur, dass man sich nicht anmelden
   muss. Auf derselben Seite steht ein Beitrag von CHF 5 pro Familie und Besuch.
3. Der Editor-Agent schreibt trotzdem «kostenlos» in seinen Entwurf. Das Programm weist den Entwurf ab, weil er sich
   auf eine abgelehnte Angabe stützt.
4. Der zweite Entwurf enthält nur geprüfte Angaben: das Alter und dass ein Elternteil dabeibleibt. Er wird genehmigt. Der Preis bleibt «unbekannt», bis ihn ein Such-Agent
   mit einem Zitat belegt.

## Zahlen

Stand 14. Oktober 2026.

- 295 Einträge im Katalog, 26 im Archiv
- alle 7 Bezirke des Kantons
- 462 Quellen
- 491 automatische Tests. Auf GitHub laufen sie bei jedem Push; 6 davon werden dort übersprungen.
- bewusst «unbekannt» gelassen: die Sprache bei 263 Einträgen, der Preis bei 189, das Mindestalter bei 199

### Pipeline, 2. bis 13. Oktober 2026

Die meisten Modell-Läufe (197 von 205) gingen noch über die frühere Route
mit OpenAI Codex (2. und 3. Oktober), 8 über Claude. Die Regeln im Code sind für beide gleich.

- 205 Modell-Läufe: 72 Suche, 100 Prüfung, 33 Editor
- 1219 vorgeschlagene Angaben. Bei 46 fand das Programm das Zitat nicht wörtlich in der Quelle, bei 33 stammte es
  nicht von einer offiziellen Seite des Angebots. Diese Angaben wurden auf «unbekannt» gesetzt.
- 1078 Urteile des Prüf-Agenten: 567 bestätigt, 123 abgelehnt, 388 «braucht eine andere Quelle»
- Entwürfe des Editor-Agenten: 20 genehmigt und übernommen, 5 wies das Programm ab, 5 lehnte der Prüf-Agent ab
- 12 Antworten verletzten die Regeln (Schema oder Belege) und wurden verworfen, darunter die 5 abgewiesenen Entwürfe
- Der Circuit Breaker hat sich nie geöffnet; einmal musste ein Mensch eingreifen.

[Quelle: interne Queue, gezählt mit learning/pipeline-counts.mjs, nur lesend; nicht im öffentlichen Repository.]

## Betrieb

- Die Seite läuft in Docker-Containern auf einem Server in der Schweiz (Infomaniak Public Cloud), mit HTTPS über
  Caddy. Auch diese Fallstudie kommt von dort.
- Jede Nacht wird gesichert. Die Wiederherstellung wurde am 14. Oktober 2026 auf dem laufenden Server geübt.
- Alle fünf Minuten prüft der Server, ob die Seite antwortet. Wenn nicht, kommt eine E-Mail.
- Die Redaktions-Pipeline läuft nicht auf dem Server, sondern auf meinem Rechner.

## Was ich mache und was die Agenten machen

Den Code schreiben KI-Agenten: Claude Code, früher Codex. Meine Arbeit:

- Ich lege fest, was das Produkt tut und was nicht. Zum Beispiel: keine Namen von Privatpersonen im Katalog.
- Ich lege die Anforderungen und Regeln fest. Die Agenten schreiben daraus die Specs, ich gebe sie frei.
- Ich prüfe die Ergebnisse: Die Agenten führen Tests und Audits durch, ich lese ihre Berichte und sehe mir die
  laufende Seite selbst an.
- Ich entscheide, was veröffentlicht wird. Domain und Server habe ich ausgewählt und bezahlt.
  Agenten haben beides nach meiner Freigabe eingerichtet.

Code lese ich noch nicht flüssig. Die Abläufe kann ich erklären: Die vier wichtigsten Wege durch den Code stehen in
[`docs/architektur.md`].

## Grenzen

- Alle Einträge gibt es auf Deutsch, Französisch und Englisch. Sprachmodelle haben die deutschen und französischen
  Texte übersetzt. Ein Programm hat Zahlen, Uhrzeiten, Wochentage und Ähnliches geprüft, weitere Sprachmodelle den
  Sinn. Gelesen hat die Texte noch niemand mit Deutsch oder Französisch als Muttersprache. Die einfachen
  Einzelseiten ohne JavaScript (unter /places/) gibt es bisher nur auf Englisch.
- Viele Felder sind «unbekannt». Das ist Absicht, aber für Eltern weniger bequem.
- Fällt der ganze Server aus, kann er keine E-Mail mehr schicken. Eine Prüfung von aussen fehlt noch.
- Den Abgleich zwischen Geräten gibt es öffentlich nur für eine Demo-Familie.

## Kontakt

Alex Shamrai · hello@minitandem.ch · github.com/avsomg
