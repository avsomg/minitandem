# Betrieb: Server, Sicherung, Überwachung

Dieses Dokument beschreibt den Betrieb von Minitandem auf einem kleinen Server. Seit dem 14. Oktober 2026 läuft die Seite nach dieser Anleitung unter https://minitandem.ch (siehe «Stand der Prüfung» ganz unten).

Zielsystem (nur zur Referenz): Ubuntu 24.04 LTS, 1 vCPU, 2 GB RAM, eingehend offen sind 22, 80 und 443 auf IPv4. Ausgehend ist Port 25 gesperrt.

## Überblick

```
Internet ──80/443──> Caddy (Container "caddy")  ──intern──> app (Container "app", Port 8787, nicht veröffentlicht)
                       │ automatisches HTTPS                  │ site + Dienst (server.mjs)
                       │ www -> minitandem.ch                 └─ Volume "state": /state
                       └─ Volumes "caddy-data", "caddy-config"
```

- `Dockerfile`: baut die Seite mit `node build.mjs --public` und startet `server.mjs` als unprivilegierter Benutzer. Der Healthcheck fragt `/healthz` ab.
- `compose.yaml`: zwei Dienste, `app` und `caddy`, Projektname `minitandem`. Nur Caddy veröffentlicht Ports. Der Zustand liegt im benannten Volume `minitandem_state`.
- `docker/Caddyfile`: `www.minitandem.ch` leitet dauerhaft auf `minitandem.ch` um; `minitandem.ch` wird mit `encode zstd gzip` ausgeliefert, die Editor-Pfade (`/admin`, `/api/v1/admin/*`) sind am Proxy gesperrt (404), alles andere geht an `app:8787`.
- `ops/deploy.sh <Commit>`: das Update mit Prüfungen, vom Rechner des Eigentümers aus (siehe «Update»).
- `docker/entrypoint.sh`: legt beim ersten Start **genau eine Demo-Familie** an (Schlüssel in `/state/demo-family-key.txt`) und startet den Dienst. Ein **Editor-Schlüssel** (`server.mjs new-admin`) wird auf dem Server **nie** erzeugt; ohne ihn antworten alle Editor-Routen mit 401.
- Die redaktionelle Pipeline (`editorial/cycle.mjs`, die Worker) läuft **nicht** auf dem Server, sondern auf dem Rechner des Eigentümers; der Server hat keine Modell-Zugänge. Zu unterscheiden ist, was wo liegt:
  - **App-Image** (Container `app`): die öffentliche Seite und der Dienst, **keine** privaten redaktionellen Daten. Das Image wird mit `--public` aus einem sauberen Checkout gebaut, und `.dockerignore` hält alle privaten Pfade aus dem Build-Kontext.
  - **Volume `minitandem_state`** (Familien-Zustand): gehashte Familienschlüssel, Profile, eingereichte Korrekturen und die Demo-Familie. Das sind Familiendaten, keine redaktionellen Daten; sie gehören dem Dienst und werden von `ops/backup.sh` gesichert (Abschnitt «Sichern und Wiederherstellen des State-Volumes»).
  - **Host-Verzeichnis `~/editorial-backups`** (ausserhalb von Docker, Benutzer `ubuntu`, Modus 700): die tägliche Kopie des **privaten redaktionellen Zustands** vom Mac des Eigentümers (Warteschlange, Belege, Quelltexte), ohne Familiendaten. Kein Container bindet es ein (Abschnitt «Redaktioneller Zyklus: Überwachung und Kopie ausser Haus»).

## Vorbereitung (einmalig)

1. **DNS.** A-Einträge für `minitandem.ch` und `www.minitandem.ch` auf die IPv4-Adresse des Servers. **Keinen AAAA-Eintrag setzen:** Von aussen ist nur IPv4 offen, und Let's Encrypt würde sonst über IPv6 prüfen und scheitern.
2. **Docker.** Docker Engine und das Compose-Plugin nach der offiziellen Anleitung für Ubuntu installieren (apt-Repository von Docker). `docker compose version` muss antworten.
3. **Firewall.** `ufw allow 22/tcp`, `ufw allow 80/tcp`, `ufw allow 443/tcp`, optional `ufw allow 443/udp` (HTTP/3; ist UDP 443 nicht offen, wird einfach HTTP/2 genutzt). Hinweis: Docker setzt veröffentlichte Ports an `ufw` vorbei durch. Das ist hier unkritisch, weil nur Caddy (80/443) Ports veröffentlicht und `app` keinen.
4. **Benutzer.** Einen normalen Benutzer mit SSH-Schlüssel verwenden, in der Gruppe `docker`; kein Login als root.

## Erstes Deployment

```
git clone <URL-DES-REPOSITORYS> /opt/minitandem
cd /opt/minitandem
cp .env.example .env
nano .env                       # ACME_EMAIL eintragen (Pflicht)
sed -i "s/^MINITANDEM_TAG=.*/MINITANDEM_TAG=$(git rev-parse --short HEAD)/" .env
docker compose config -q        # prüft die Datei und die Variablen
docker compose up -d --build
docker compose ps               # beide Dienste "running", app "healthy"
curl -fsS https://minitandem.ch/healthz     # {"status":"ok","records":...,"revision":...,"commit":...}
```

Beim ersten Start holt Caddy die Zertifikate; das dauert meist unter einer Minute (`docker compose logs caddy`). Den Schlüssel der Demo-Familie zeigt `docker compose exec app cat /state/demo-family-key.txt`. Er schützt nur Demo-Daten.

Die Seite wird beim Bauen des Images erzeugt, **ohne** die Publikations-Gates (sie brauchen private Belege, die nicht im Repository liegen; die Build-Ausgabe sagt `publicationGates: skipped`). Diese Gates laufen vor dem Commit auf dem Rechner des Eigentümers. Vor dem Deployment also nur Stände aus dem Repository nehmen, die dort geprüft wurden. Die öffentlichen Prüfungen `npm run audit:public` und `npm run scan:public` brauchen keine privaten Belege und laufen in der CI; `ops/deploy.sh` verlangt für den Commit eine grüne CI.

## Welche Version läuft?

`/healthz` nennt die laufende Version, ohne Schlüssel:

```
curl -fsS https://minitandem.ch/healthz
{"status":"ok","records":321,"revision":"e2705429a88dd340","catalogueUpdated":"2026-10-15","commit":"1a2b3c4"}
```

- `records`: Zahl der Karten im Katalog.
- `revision`: Prüfsumme (SHA-256, 16 Zeichen) der Katalogdateien, aus denen die Seite gebaut wurde. `build.mjs` schreibt sie mit `catalogueUpdated` (Datum der jüngsten Prüfung im Katalog) und `records` nach `.publish/build-info.json`; die Datei enthält keine Uhrzeit, derselbe Stand ergibt dieselbe Datei. Der Dienst liest sie beim Start. Die Revision ändert sich nur, wenn sich der Katalog ändert, nicht bei Änderungen am Code.
- `commit`: der Wert von `MINITANDEM_TAG` aus `.env` (kurze Commit-ID, siehe «Update»). `compose.yaml` gibt ihn als `MINITANDEM_COMMIT` an den Dienst weiter. Ist der Tag leer oder läuft der Dienst ausserhalb von Compose, fehlt das Feld; mit dem Standardwert `current` aus `.env.example` steht dort `current`.

Nichts davon ist geheim.

## Update

Ein Update ist ein Aufruf auf dem Rechner des Eigentümers, mit dem **vollständigen** Commit (40 Zeichen). Es gibt keinen Standardwert; der redaktionelle Zyklus startet das Skript nie.

```
git push                                     # GitHub-CI muss für diesen Commit durchlaufen
ops/deploy.sh "$(git rev-parse HEAD)"        # oder ein anderer Commit, der auf GitHub liegt
```

Gebraucht werden auf dem Mac `gh` (angemeldet), Node und `ssh` mit dem Admin-Schlüssel. Auf dem Server laufen Bash, Git, Docker und curl. Das Skript prüft zuerst den neuesten Lauf von **`test.yml` für exakt den angeforderten Commit** (`headSha`, Status completed, Schluss success). Ein anderer grüner Workflow genügt nicht.

Danach läuft die gesamte Operation in **einer SSH-Sitzung** auf dem Server. Ein atomar angelegtes Verzeichnis `/opt/minitandem/.deploy-lock` sperrt Aufbau, Vorschau, Umschalten, Prüfung und Fehlerbehandlung. Jeder Aufruf erhält eine zufällige Operations-ID. Die Sperre nennt ID und PID des Servers. Ein zweiter Aufruf scheitert sofort, auch bei einer unvollständigen oder verwaisten Sperre. Es gibt keine automatische Übernahme nach einer Zeitfrist.

Die Datei `.deployments/<Operations-ID>` hält vorherigen Checkout und Image-Tag, Ziel-Commit und Ziel-Tag, Phase und Zeitpunkt. Sie wird vor den jeweiligen Änderungen atomar ersetzt. Die Vorschau heisst `minitandem-preview-<Operations-ID>`, ist nur auf Loopback erreichbar und nutzt ein eigenes tmpfs statt des Familien-Volumes. Der Schrumpf-Schutz vergleicht `published`, also sichtbare Karten ohne closed/excluded, mit live (maximal 15 % Rückgang). `archived` zählt closed/excluded; beide Zahlen stehen neben `records` in `/healthz` und `build-info.json`. Eine Statuszeile nennt published und archived vorher → nachher. Fehlt dem alten Live-Image `published`, wird mit einer sichtbaren Warnung einmalig `records` als Vergleich verwendet. Die neue Vorschau muss beide Statuszahlen liefern, und ihre Summe muss `records` sein; das öffentliche Ergebnis muss Revision und Commit der Vorschau tragen.

Normale Fehler und die behandelten Signale HUP/INT/TERM versuchen den alten Zustand wiederherzustellen. Rollback und Aufräumen prüfen die eigene Sperr-ID; ein inzwischen anderer Besitzer bleibt unberührt. Vor einem Rollback nach dem Umschalten muss zudem der Live-Tag noch der dieser Operation sein. Bei einem gescheiterten Rollback bleibt die Sperre mit `recovery-needed` stehen. Stromverlust, SIGKILL und eine unterbrochene Verbindung garantieren keinen automatischen Rollback: Die Serverdatei zeigt, wo die Operation stand. Die öffentliche Seite und `/healthz` prüfen, bevor etwas von Hand geändert wird.

Am Ende nennt das Skript den vorherigen Tag und die Recovery-Datei. Umgebungsvariablen: `DEPLOY_HOST`, `DEPLOY_KEY`, `DEPLOY_DIR`, `DEPLOY_URL`, `DEPLOY_PORT`, `DEPLOY_MAX_DROP`, `DEPLOY_TRIES`, `DEPLOY_POLL`. Keine dieser Änderungen ist hier auf dem echten Server angewendet worden.

### Unterbrochenes Deployment wiederherstellen

Nur mit dem Eigentümer und dem Admin-Zugang. Zuerst auf dem Server `cat /opt/minitandem/.deploy-lock/owner` und die zugehörige `.deployments/<ID>` lesen. Solange die PID lebt, **nicht** übernehmen. Eine fehlende Owner-Datei nicht als tote Operation behandeln: Prozesse und laufende Docker-Builds zuerst untersuchen. Bei unbekanntem Live-Tag ebenfalls anhalten. Die folgende Folge gilt nur für eine vollständig geschriebene Sperre eines nachweislich beendeten Prozesses. Sie wird in einer Shell ausgeführt; kein `source` und kein `eval` auf dem Statusfile.

```sh
bash <<'RECOVER'
set -euo pipefail
cd /opt/minitandem
op=$(cat .deploy-lock/id)
[[ $op =~ ^[a-f0-9-]{36}$ ]]
mkdir .deploy-lock/recovery
trap 'rmdir .deploy-lock/recovery 2>/dev/null || true' EXIT
pid=$(sed -n 's/^pid=//p' .deploy-lock/owner)
[[ $pid =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ]
if kill -0 "$pid" 2>/dev/null; then echo 'Owner still alive; stop' >&2; exit 1; fi
[ "$(cat .deploy-lock/id)" = "$op" ]
record=.deployments/$op
cat "$record"
previous_ref=$(sed -n 's/^previous_ref=//p' "$record")
previous_tag=$(sed -n 's/^previous_tag=//p' "$record")
target_tag=$(sed -n 's/^target_tag=//p' "$record")
[ -n "$previous_ref" ]
[[ $previous_tag =~ ^[A-Za-z0-9._-]+$ ]]
live_tag=$(sed -n 's/^MINITANDEM_TAG=//p' .env)
[ "$live_tag" = "$previous_tag" ] || [ "$live_tag" = "$target_tag" ]
git checkout --quiet "$previous_ref"
sed "s/^MINITANDEM_TAG=.*/MINITANDEM_TAG=$previous_tag/" .env > .env.new
cat .env.new > .env
rm .env.new
docker compose up -d --no-build
curl -fsS https://minitandem.ch/healthz
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)" | grep -qx healthy
printf 'recovery=rolled-back at %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$record"
docker rm -f "minitandem-preview-$op" >/dev/null 2>&1 || true
[ "$(cat .deploy-lock/id)" = "$op" ]
rm .deploy-lock/id .deploy-lock/owner
rmdir .deploy-lock/recovery
rmdir .deploy-lock
trap - EXIT
RECOVER
```

Fehlt das alte Image, die Folge anhalten; zuerst am protokollierten alten Commit mit dem Eigentümer neu bauen. Eine Recovery, die an einer Prüfung scheitert, lässt die äussere Sperre stehen. Eine nach SIGKILL selbst verwaiste `recovery`-Sperre ebenfalls erst nach Prozessprüfung entfernen. Diese Befehle sind dokumentiert, nicht ausgeführt.

## Rollback

Nach einem erfolgreichen Deployment ist ein geplanter Rollback ein **neuer** Aufruf von `ops/deploy.sh <vollständiger alter Commit>` mit der Freigabe des Eigentümers. Er nimmt dieselbe Sperre, prüft CI und Vorschau und hinterlässt eine eigene Operations-ID. Alte Images erst löschen, wenn die neue Version ausreichend beobachtet wurde. Das Familien-Volume wird beim Deployment nicht ersetzt.

## Sichern und Wiederherstellen des State-Volumes

Im Volume `minitandem_state` liegen die gehashten Familienschlüssel und Profile (`families.json`), eingereichte Korrekturen (`corrections/`), die Datei `demo-family-key.txt` und die 20 letzten automatischen Kopien `backup-*.json`, die der Dienst bei jedem Schreiben anlegt. Der Dienst ersetzt Dateien atomar, ein Archiv im laufenden Betrieb ist deshalb in sich konsistent.

**Sichern.** `ops/backup.sh` legt beide Archive an und behält von beiden Archiven je die 14 neuesten. Auf dem Server ist es als `/usr/local/sbin/minitandem-backup` installiert und läuft jede Nacht um 3.15 Uhr UTC per Cron des Benutzers `ubuntu`:

```
sudo install -m 755 ops/backup.sh /usr/local/sbin/minitandem-backup
( crontab -l 2>/dev/null | grep -v minitandem-backup || true; echo '15 3 * * * /usr/local/sbin/minitandem-backup >> $HOME/backups/backup.log 2>&1' ) | crontab -
```

Die Archive liegen in `~/backups` und sind nur für diesen Benutzer lesbar, weil das Caddy-Archiv Zertifikatsschlüssel enthält. Danach auf einen anderen Rechner kopieren: Eine Sicherung auf demselben Server schützt nicht vor dessen Verlust. Dieselben Archive von Hand:

```
mkdir -p ~/backups
docker run --rm -v minitandem_state:/state:ro -v ~/backups:/backup alpine \
  tar czf /backup/minitandem-state-$(date +%F-%H%M).tgz -C /state .
docker run --rm -v minitandem_caddy-data:/data:ro -v ~/backups:/backup alpine \
  tar czf /backup/minitandem-caddy-$(date +%F).tgz -C /data .
```

Das zweite Archiv enthält die Zertifikate und das ACME-Konto. Ohne es stellt Caddy neue aus, was durch die Limits von Let's Encrypt zeitweise scheitern kann.

**Wiederherstellen** (Dienst anhalten, Volume leeren, Archiv einspielen, starten):

```
cd /opt/minitandem
docker compose stop app
docker run --rm -v minitandem_state:/state -v ~/backups:/backup:ro alpine \
  sh -c 'find /state -mindepth 1 -delete && tar xzf /backup/<DATEI>.tgz -C /state && chown -R 1000:1000 /state'
docker compose start app
curl -fsS https://minitandem.ch/healthz
```

Der Benutzer `node` im Image hat die ID 1000; deshalb das `chown`.

**Geübt am 14. Oktober 2026** auf dem laufenden Server: Volume geleert, Archiv nach dieser Anleitung eingespielt. Die Prüfsummen aller Dateien waren danach dieselben wie vorher, der Schlüssel der Demo-Familie funktionierte, die Seite war nach etwa 12 Sekunden wieder erreichbar.

**Nur eine beschädigte `families.json`:** Der Dienst antwortet für die betroffene Anfrage mit 500 und läuft weiter. Aus dem Volume die jüngste unbeschädigte Kopie wählen: `docker compose exec app ls -1t /state` zeigt die `backup-*.json`; die gewählte Datei wird als `families.json` zurückkopiert (`docker compose exec app cp /state/backup-… /state/families.json`).

## Logs

| Was | Wo |
| --- | --- |
| Zugriffe (JSON, eine Zeile pro Anfrage), Zertifikate | `docker compose logs -f --tail=200 caddy` |
| Dienst: Startmeldung und Serverfehler (500) | `docker compose logs -f --tail=200 app` |
| Dateien auf dem Host | `/var/lib/docker/containers/<container-id>/<container-id>-json.log`; Rotation durch `compose.yaml`: 10 MB, 5 Dateien je Dienst |
| Docker selbst | `journalctl -u docker` |
| Zustand der Container | `docker compose ps`; `docker inspect --format '{{.State.Health.Status}}' minitandem-app-1` |

Der Dienst schreibt keinen eigenen Zugriffsprotokollstrom, nur Startmeldung und Fehler. Wer Zugriffe sehen will, liest das Caddy-Log.

## Überwachung per E-Mail über ein authentifiziertes Relay (Port 587)

Der Server kann nicht direkt zustellen, weil ausgehend Port 25 gesperrt ist. Die Meldung geht deshalb über ein Relay mit Anmeldung auf Port 587 (STARTTLS): den Postausgang von Infomaniak (`mail.infomaniak.com`) mit dem Postfach `hello@minitandem.ch` als Absender. Verdrahtet wird das auf dem **Host**, nicht im Container:

1. Installieren: `sudo apt install curl msmtp msmtp-mta`. Das Paket `msmtp-mta` liefert den Befehl `sendmail`.
2. `/etc/msmtprc` anlegen (`chmod 600`, ohne das Passwort selbst):

```
defaults
auth           on
tls            on
tls_starttls   on
tls_trust_file /etc/ssl/certs/ca-certificates.crt
syslog         on

account        relay
host           mail.infomaniak.com
port           587
from           hello@minitandem.ch
user           hello@minitandem.ch
passwordeval   cat /etc/minitandem-smtp-password

account default : relay
```

   Das Passwort steht in `/etc/minitandem-smtp-password` (`chmod 600`, Eigentümer root). Es ist nicht das Passwort des Kundenkontos, sondern ein eigenes Passwort für Mailprogramme, das im Infomaniak-Kundenkonto beim Postfach erzeugt wird («Generate a password to use in an email client»). Der Eigentümer erzeugt es und legt es selbst auf den Server; es steht in keinem Chat und in keinem Repository. Wird der Server kompromittiert, muss nur dieses Passwort widerrufen werden.
3. Zustellweg prüfen: `printf 'To: EMPFAENGER\nSubject: Test\n\nHallo\n' | sendmail -t`. `EMPFAENGER` ist die private Adresse des Eigentümers. Schlägt es fehl, `journalctl -t msmtp` lesen. Erreichbarkeit des Relays: `openssl s_client -starttls smtp -connect mail.infomaniak.com:587`.
4. Das Skript `ops/healthcheck.sh` fragt `https://minitandem.ch/healthz` ab und schickt **eine** Mail, wenn der Zustand wechselt (wird unerreichbar, ist wieder erreichbar). Es ruft `sendmail -t` auf.
5. systemd-Dienst und Timer, alle fünf Minuten:

```
# /etc/systemd/system/minitandem-health.service
[Unit]
Description=Minitandem health check

[Service]
Type=oneshot
Environment=HEALTH_MAIL_TO=EMPFAENGER
Environment=HEALTH_MAIL_FROM=hello@minitandem.ch
StateDirectory=minitandem-health
Environment=HEALTH_STATE=/var/lib/minitandem-health/state
ExecStart=/opt/minitandem/ops/healthcheck.sh
SuccessExitStatus=0 1

# /etc/systemd/system/minitandem-health.timer
[Unit]
Description=Minitandem health check every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

   `EMPFAENGER` ist die private Adresse des Eigentümers. Sie steht nur in dieser Datei auf dem Server, nicht im Repository.

   Aktivieren mit `sudo systemctl daemon-reload && sudo systemctl enable --now minitandem-health.timer`. Prüfen mit `systemctl list-timers minitandem-health.timer` und `journalctl -u minitandem-health`.

**Grenze.** Fällt der ganze Server aus, kann er auch keine Mail mehr senden. Ein zweiter, externer Prüfer (ein Uptime-Dienst, der `https://minitandem.ch/healthz` abfragt) deckt diesen Fall ab; er ist hier nicht eingerichtet.

## Redaktioneller Zyklus: Überwachung und Kopie ausser Haus

Der Zyklus (`editorial/cycle.mjs`) läuft nicht auf diesem Server, sondern auf dem Mac des Eigentümers: launchd startet ihn sechsmal am Tag (07.30, 10.30, 13.30, 16.30, 19.30 und 22.30 Uhr Zürcher Zeit, Agent `ch.minitandem.editorial-cycle`). Dieser Abschnitt schliesst zwei Lücken, beide am 15. Oktober 2026 vom Eigentümer freigegeben und ohne neues Konto bei einem Dritten: eine Mail, wenn der Zyklus nicht lief oder scheiterte, und eine tägliche Kopie des privaten redaktionellen Zustands auf diesen Server. Beides läuft über einen einzigen, eingeschränkten SSH-Schlüssel.

```
Mac (launchd)                                                  Server
07.30 … 22.30  ops/cycle-run.mjs ──ssh "heartbeat"──────────>  minitandem-drop ─> /var/lib/minitandem-watch/heartbeat.json
06.50          ops/editorial-offsite.mjs ──ssh "backup DATUM SHA256"──> minitandem-drop ─> ~/editorial-backups/editorial-DATUM.tar.gz
                                                               alle 30 Min: ops/cycle-watch.sh ──sendmail──> Eigentümer
```

Die Teile auf dem Mac sind Node-Skripte, die `/usr/bin/ssh` und `/usr/bin/tar` selbst aufrufen. Der Grund: Ein launchd-Auftrag, der ein `/bin/sh`-Skript aus `~/Documents` startet, kann vom Datenschutz von macOS blockiert werden; `node` mit einer Datei dort (wie beim Zyklus selbst) nicht. `rsync` wird nicht gebraucht.

**Der Drop-Schlüssel.** Auf dem Mac gibt es einen eigenen Schlüssel `~/.ssh/minitandem_drop_ed25519` (ohne Passphrase, nur dafür). Auf dem Server steht sein öffentlicher Teil in `~/.ssh/authorized_keys` des Benutzers `ubuntu` mit genau diesem Vorspann:

```
restrict,command="/usr/local/sbin/minitandem-drop" ssh-ed25519 AAAA… minitandem-drop
```

`restrict` schaltet Terminal, Weiterleitungen und Agent ab. `command=` führt bei jeder Verbindung `ops/drop.sh` aus (installiert als `/usr/local/sbin/minitandem-drop`, Eigentümer root); was der Mac verlangt, steht in `SSH_ORIGINAL_COMMAND`. Angenommen werden genau zwei Befehle, alles andere endet mit einer Meldung auf stderr und Exit-Code 1:

- `heartbeat`: liest höchstens 16 KB aus stdin (eine Zeile JSON aus druckbaren ASCII-Zeichen, `{` bis `}`) und legt sie atomar als `/var/lib/minitandem-watch/heartbeat.json` ab.
- `backup JJJJ-MM-TT SHA256`: liest höchstens 2 GB aus stdin in eine Temporärdatei in `~/editorial-backups/`, prüft die SHA-256-Summe und dass es eine gzip-Datei ist, und benennt sie in `editorial-JJJJ-MM-TT.tar.gz` um. Das Datum darf nicht nach morgen (UTC) liegen. Ein vorhandenes Archiv mit anderem Inhalt wird nie überschrieben (dieselben Bytes noch einmal sind in Ordnung: Wiederholung nach abgebrochener Verbindung). Die 14 neuesten Archive bleiben, `/var/lib/minitandem-watch/backup.json` (`{at,name,bytes}`) hält den Eingang fest.

Jedes Argument wird streng geprüft (nur Buchstaben, Ziffern, Leerzeichen und Bindestrich im ganzen Befehl). Der Schlüssel kann nichts lesen, auflisten oder löschen; wer ihn stiehlt, kann innerhalb der Grenzen Heartbeats und Archive ablegen und diese Zustandsmeldungen verfälschen. Eine Dateisystemquota begrenzt zusätzlich den Schaden eines missbrauchten Schlüssels. Er wird widerrufen, indem man die Zeile aus `authorized_keys` löscht.

### Grenzen des Upload-Empfängers (noch nicht auf dem Host installiert)

`drop.sh` nimmt insgesamt nur einen Upload gleichzeitig an, Heartbeat oder Archiv. Eine zweite Verbindung wird sofort abgelehnt. Der gemeinsame Lock liegt in `/var/lib/minitandem-watch/.upload-lock` und nennt PID/Zeitkennung. Er wird bei normalem Ende und HUP/INT/TERM nur vom eigenen Prozess entfernt. Nach SIGKILL oder Stromverlust können Lock und Temporärdatei bleiben: Owner-PID und laufende Uploads untersuchen, erst dann den verwaisten Lock und die zugehörige `.incoming-*`-Datei entfernen. Eine lebende oder unbekannte Sperre nie wegen ihres Alters übernehmen.

`DROP_READ_SECONDS` begrenzt das Lesen (Standard 300 Sekunden), `DROP_GZIP_SECONDS` die gzip-Prüfung (30 Sekunden). Ein POSIX-Wächter beendet den jeweiligen Leser; `timeout` ist keine zusätzliche Installationsvoraussetzung. Der Eingang bleibt grössenbeschränkt. `DROP_TOTAL_BACKUP_BYTES` begrenzt bestehende Dateien **plus** eingehendes Archiv auf insgesamt 2147483648 Bytes (2 GiB). Eine einzelne Prüf-Byteprobe erkennt Überlauf; danach wird die neue Datei verworfen. Retention löscht erst nach erfolgreicher Prüfung. Deshalb muss vor dem Upload Platz für eine weitere Kopie vorhanden sein; ein gefüllter Bestand wird nicht vorab gelöscht. Auch ein identischer Retry braucht vorübergehend Platz. Es wird nichts entpackt.

Vor der Installation mit dem Eigentümer die Grösse des vorhandenen Archivverzeichnisses prüfen; liegt sie schon über dem Budget, lehnt der neue Empfänger Uploads ab. Ein anderes Budget nur ausdrücklich festlegen. Danach in dieser Reihenfolge auf dem Server (hier **nicht ausgeführt**):

```sh
cd /opt/minitandem
sh -n ops/drop.sh
dash -n ops/drop.sh
sudo install -o root -g root -m 755 ops/drop.sh /usr/local/sbin/minitandem-drop
```

Mit dem bestehenden projektspezifischen Drop-Schlüssel einen kleinen Test-Heartbeat und ein Testarchiv über den normalen Client senden; Prüfsumme, Rechte und fehlende Temporärdateien prüfen. Kein Test mit Familiendaten. Der Watcher und die Timer bleiben zunächst unverändert. Ein abgelehnter paralleler Upload hat Exit-Code 1; der Client wiederholt ihn nicht als Netzwerkfehler. Nach Ende des ersten Uploads gezielt erneut senden oder den nächsten geplanten Lauf prüfen.

### Empfohlene Benutzer- und Dateisystemgrenze (Vorschlag, nicht angewendet)

Der Skript-Lock und das Budget ersetzen keine Betriebssystemgrenze. Die folgenden Befehle sind eine **separate, vom Eigentümer freizugebende Host-Änderung**. Keine bestehenden Konten oder globalen SSH-Regeln ersetzen. Der neue Benutzer gehört nur zu diesem Projekt. Zuerst den dedizierten Empfänger vorbereiten:

```sh
sudo useradd --system --user-group --create-home --home-dir /var/lib/minitandem-drop --shell /bin/sh minitandem-drop
sudo install -d -o minitandem-drop -g minitandem-drop -m 700 /var/lib/minitandem-drop/editorial-backups
sudo install -d -o root -g root -m 755 /etc/ssh/authorized_keys
sudo install -o root -g root -m 600 /dev/null /etc/ssh/authorized_keys/minitandem-drop
sudoedit /etc/ssh/authorized_keys/minitandem-drop
```

In die letzte Datei **nur** den bereits geprüften öffentlichen Schlüssel dieses Projekts mit `restrict,command="/usr/local/sbin/minitandem-drop"` eintragen, keinen privaten Schlüssel. Ein erneutes `install /dev/null` würde die Datei leeren; diesen Vorbereitungsschritt nur einmal ausführen. Alte Archive mit dem Eigentümer kopieren und prüfen, bevor der Client umgestellt wird; nichts aus anderen Backup-Verzeichnissen übernehmen.

Eine feste root-eigene Wrapperdatei setzt die neuen Pfade, ohne vom SSH-Client gelieferte Umgebungsvariablen zu übernehmen:

```sh
sudo install -d -o root -g root -m 755 /usr/local/libexec
sudo install -o root -g root -m 755 /opt/minitandem/ops/drop.sh /usr/local/libexec/minitandem-drop
sudo tee /usr/local/sbin/minitandem-drop >/dev/null <<'WRAPPER'
#!/bin/sh
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export WATCH_DIR=/var/lib/minitandem-watch
export DROP_BACKUP_DIR=/var/lib/minitandem-drop/editorial-backups
export DROP_KEEP=14
export DROP_MAX_BACKUP_BYTES=2147483648
export DROP_MAX_HEARTBEAT_BYTES=16384
export DROP_TOTAL_BACKUP_BYTES=2147483648
export DROP_READ_SECONDS=300
export DROP_GZIP_SECONDS=30
exec /usr/local/libexec/minitandem-drop
WRAPPER
sudo chown root:root /usr/local/sbin/minitandem-drop
sudo chmod 755 /usr/local/sbin/minitandem-drop
```

Der Watch-Pfad muss beim tatsächlichen Wechsel dem neuen Benutzer gehören; der root-Watcher kann ihn weiter lesen. Nicht beide Client-Benutzer gleichzeitig betreiben. Erst nach einem geprüften Kopier-/Umschaltplan `sudo chown -R minitandem-drop:minitandem-drop /var/lib/minitandem-watch` ausführen und auf dem Mac `MINITANDEM_DROP_USER=minitandem-drop` setzen. Den alten Zugang erst nach erfolgreichen Tests widerrufen.

Die Quota-Befehle gelten **nur für ein bereits mit Benutzerquotas eingerichtetes ext4-Dateisystem**. Sie brechen sonst ab. Ein nötiger Umbau von Mount/Fstab, ein neues Volume oder eine XFS-Quota braucht einen eigenen Plan; nicht das Root-Dateisystem blind remounten. Nach der Freigabe:

```sh
sudo apt-get install quota
bash <<'QUOTA'
set -euo pipefail
quota_mount=$(findmnt -n -o TARGET --target /var/lib/minitandem-drop)
[ "$(findmnt -n -o FSTYPE --target /var/lib/minitandem-drop)" = ext4 ]
findmnt -n -o OPTIONS --target /var/lib/minitandem-drop | tr ',' '\n' | grep -qx usrquota
sudo quotaon -u "$quota_mount"
sudo setquota -u minitandem-drop 2097152 2097152 0 0 "$quota_mount"
sudo quota -u minitandem-drop
QUOTA
```

Soft- und Hard-Limit sind 2 GiB in KiB. Die Systemquota zählt auch Metadaten und andere Dateien dieses Benutzers; der nutzbare Archivraum kann deshalb etwas kleiner sein. Falls der Bestand nicht hineinpasst, anhalten und mit dem Eigentümer Platz/Retention entscheiden. Die App-Dateien und Familiendaten bleiben einem anderen Benutzer zugeordnet.

Optional den Benutzer zusätzlich in `/etc/ssh/sshd_config.d/minitandem-drop.conf` einschränken (Datei vorher auf Konflikte prüfen, nicht überschreiben):

```text
Match User minitandem-drop
    AuthorizedKeysFile /etc/ssh/authorized_keys/minitandem-drop
    ForceCommand /usr/local/sbin/minitandem-drop
    PermitTTY no
    AllowTcpForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitUserEnvironment no
    MaxSessions 1
Match all
```

Vor einem Reload `sudo sshd -t` und `sudo sshd -T -C user=minitandem-drop,host=localhost,addr=127.0.0.1` prüfen. Nur bei gültiger, erwarteter Ausgabe `sudo systemctl reload ssh`. Eine bestehende Admin-Sitzung offen halten, dann den beschränkten Zugang testen. Der Skript-Lock gilt über Verbindungen hinweg; `MaxSessions 1` allein wäre keine globale Upload-Grenze. Diese Benutzer-, Quota- und SSH-Änderungen wurden in diesem Auftrag weder angewendet noch am echten Host geprüft.

**Heartbeat: `ops/cycle-run.mjs`.** Das Programm in der plist des Zyklus ist nicht mehr `editorial/cycle.mjs`, sondern `ops/cycle-run.mjs`. Es startet den Zyklus mit denselben Argumenten, derselben Ausgabe und demselben Exit-Code und sendet danach einen Heartbeat: `{at, exit, ok, reason, paused, skipped, runId, startedAt, seconds, daily, failedSteps, needsOwner:{count,text}, approvedUpdates, jobsRun, record}`. Der Heartbeat enthält nur Zähler, Schrittnamen, Karten-IDs und kurze Codes, keine Kartentexte und keine Zitate. Ein Heartbeat, der nicht ankommt, wird im Log des Zyklus vermerkt (drei Versuche mit 15 und 45 Sekunden Pause bei nicht erreichbarem Server), ändert aber den Exit-Code nie. `--status` und `--dry-run` führen keinen Zyklus aus und senden nichts.

*Quittung und Lauf-ID.* Jeder Aufruf von `cycle-run.mjs` erzeugt eine zufällige Lauf-ID (`runId`) und gibt sie dem Zyklus in der Umgebungsvariable `MINITANDEM_CYCLE_RUN_ID` mit. `editorial/cycle.mjs` schreibt sie in seine Quittung `editorial/workflow-state/cycle/latest.json` (bei jedem Ausgang: Lauf, Pause, Überspringen, Blockade). Eine Quittung zählt nur, wenn sie diese ID trägt; eine fehlende, nicht lesbare, ältere oder von einem überlappenden Lauf geschriebene Quittung zählt nicht. `ok` und `reason` sagen, was daraus folgt:

| `ok` | `reason` | Bedeutung |
| --- | --- | --- |
| `true` | `null` | Der Lauf ist fertig und nichts braucht den Eigentümer. Zwei absichtliche Auslassungen sind hier erkennbar und gelten als lebendig, aber nicht als geleistete Arbeit: `paused:true` (Pause durch `editorial/cycle.pause`) und `skipped:"another cycle is still running"`. Der Wächter beurteilt beide nicht und lässt den Zustand «failed» unverändert. |
| `false` | `exit` | Der Zyklus endete mit einem Exit-Code ungleich 0. |
| `false` | `no-receipt` | Der Zyklus endete mit 0, aber zu diesem Aufruf gibt es keine Quittung. Über seine Arbeit ist nichts bekannt, deshalb gilt der Lauf nicht als Erfolg. |
| `false` | `needs-owner` | Die Quittung ist da, und der Zyklus meldet selbst, dass er den Eigentümer braucht (dieselbe Bedingung wie das Banner auf dem Mac, `needsOwner` in `editorial/cycle.mjs`). So geht auch ein Stapel, der wegen fehlendem Claude-Login nichts tat und mit 0 endete, nicht unter. |

Ein Heartbeat älterer Form hat kein `reason`; der Wächter meldet ihn weiterhin und schreibt «not stated (heartbeat from an older version)».

**Tägliche Kopie: `ops/editorial-offsite.mjs`.** Ein eigener launchd-Agent `ch.minitandem.editorial-offsite` startet es täglich um 06.50 Uhr, vor dem ersten Zyklus. Das Skript ruft `node editorial/backup.mjs create --to=<Zwischenordner>/<Datum>` und `verify` auf, packt den Ordner mit `tar -czf`, bildet die SHA-256-Summe und streamt das Archiv an `ssh … backup <Datum> <Summe>`. Danach löscht es Ordner und Archiv auf dem Mac: Die Platte ist knapp, der Server hält 14 Kopien. Der Zwischenordner liegt ausserhalb des Repositorys (`~/Backups/minitandem-editorial/staging`). Scheitert ein Schritt, nennt die Fehlermeldung den Schritt, der Exit-Code ist 1, und im Zwischenordner bleibt nichts liegen. `create` verweigert, solange ein Auftrag ausgeliehen ist; das ist um 06.50 Uhr normalerweise nicht der Fall, ein verpasster Tag wird vom Wächter erst nach 36 Stunden gemeldet. `--dry-run` macht alles ausser dem Hochladen und behält das Archiv (Pfad, Grösse und Summe stehen in der Ausgabe).

Das Archiv enthält den privaten redaktionellen Zustand (Warteschlange, Belege, Quelltexte), aber **keine Familiendaten** (`familyDataIncluded:false`). Auf dem Server liegt es in `~/editorial-backups` (Modus 700). Es liegt damit auf demselben Server wie die Seite: Es schützt vor dem Verlust des Macs, nicht vor dem Verlust des Servers. Der Agent `ch.minitandem.pull-backups` holt nur `backups/minitandem-*.tgz` und damit diese Kopien nicht zurück auf den Mac.

**Sperre: ein Lauf zur Zeit.** Der Zyklus (`editorial/workflow-state/cycle/cycle.lock`) und die tägliche Kopie (`<Zwischenordner>/.offsite.lock`) benutzen dieselbe Sperre (`editorial/process-lock.mjs`). Sie ist eine einzelne Datei mit Prozess-ID, Token, Startzeit und der Startzeit des Prozesses laut `ps`. Die Datei wird zuerst vollständig in eine Temporärdatei geschrieben und dann in einem Schritt an ihren Platz gelegt (`link` scheitert, wenn der Name vergeben ist): Es gibt nie eine Sperre ohne Besitzer, und zwei gleichzeitige Läufe können sie nicht beide bekommen. Der zweite Lauf meldet «another cycle is still running» (Zyklus) bzw. «another run is active» (Kopie) und tut nichts.

- Veraltet ist die Sperre nur, wenn der Prozess nicht mehr lebt oder seine Prozess-ID inzwischen einem anderen Prozess gehört (die Startzeit des Prozesses weicht von der notierten ab). Ein lebender Besitzer wird nie wegen der Zeit verdrängt: nicht nach drei Stunden, nicht nach einem Ruhezustand des Macs, nicht bei einer vorgestellten Uhr. Die frühere Regel («nach drei Stunden gilt eine Sperre als verwaist») gibt es nicht mehr.
- Einzige Ausnahme: Konnte beim Anlegen die Startzeit nicht ermittelt werden (`ps` fehlt oder antwortet nicht), lässt sich die gleiche Prozess-ID nicht von einer wiederverwendeten unterscheiden. Dann wird die Sperre nach 24 Stunden als veraltet behandelt; ein Lauf ist durch die Zeitlimits seiner Schritte auf wenige Stunden begrenzt.
- Eine veraltete Sperre entfernt genau ein Lauf: Er legt dafür eine Markierungsdatei an (`cycle.lock.reap-<Token>`, nur einer kann das), liest die Sperre noch einmal und entfernt sie nur, wenn es noch dieselbe ist. Eine inzwischen ersetzte Sperre bleibt. Die Markierung eines Prozesses, der dabei starb, verfällt nach zwei Minuten.
- Freigeben darf nur, wem das Token in der Datei noch gehört. Ein alter Besitzer, dessen Sperre ersetzt wurde, löscht die neue nicht; er schreibt «the lock was not ours any more» ins Log.
- Eine Sperrdatei, die sich nicht lesen lässt, bleibt zehn Minuten unangetastet und wird danach entfernt. Temporärdateien eines getöteten Laufs räumt der nächste Lauf nach einer Stunde weg.
- Der Zyklus liest den gemeinsamen Planungszustand (`state.json`, die Marken der Warteschlange) erst, nachdem er die Sperre hat; `--dry-run` ändert nichts und nimmt keine Sperre.

*Alte Sperre auf dem Mac beim ersten Lauf nach der Umstellung.* Frühere Versionen legten Verzeichnisse an (`editorial/workflow-state/cycle/lock/` mit `owner.json`, und `<Zwischenordner>/.lock/` mit `pid`). Die neue Version liest sie weiter: Ein Verzeichnis mit lebendem Besitzer, jünger als drei Stunden (die Grenze der alten Version), lässt den Lauf überspringen und bleibt unberührt, damit ein Lauf der alten Version nicht gestört wird. Ist der Besitzer nicht mehr da, ist das Verzeichnis älter als drei Stunden oder hat es keinen lesbaren Besitzer und ist älter als eine Minute, wird es entfernt und der Lauf geht normal weiter. Meist gibt es gar kein altes Verzeichnis, weil die alte Version es am Ende jedes Laufs löscht. Die neue Sperre liegt unter anderem Namen (`cycle.lock`, `.offsite.lock`); niemand muss etwas von Hand löschen. Meldet ein Lauf dauernd «still running», prüft man mit `cat editorial/workflow-state/cycle/cycle.lock` und `ps -p <pid>`, ob der Prozess wirklich läuft; läuft er nicht, räumt der nächste Lauf von selbst auf.

**Wächter: `ops/cycle-watch.sh`.** Ein systemd-Timer startet ihn alle 30 Minuten (`ops/systemd/minitandem-cycle-watch.service` und `.timer`). Er läuft als root wie `minitandem-health.service` (das Relay-Passwort ist nur für root lesbar) und nutzt dieselben Mail-Einstellungen (`HEALTH_MAIL_TO`, `HEALTH_MAIL_FROM`, `sendmail -t`). Er macht drei Prüfungen, jede mit eigenem gemerktem Zustand, und schickt **eine** Mail pro Zustandswechsel (Problem beginnt, Problem endet). Der Betreff beginnt mit «Minitandem editorial:».

| Betreff (nach dem Vorspann) | Wann | Was tun |
| --- | --- | --- |
| `cycle silent` / `cycle is running again` | kein Heartbeat seit mehr als `WATCH_SILENT_HOURS` (10) Stunden | Mac an und wach? `launchctl list \| grep minitandem`, `tail ~/Library/Logs/minitandem-editorial-cycle.log` |
| `cycle failed` / `cycle works again` | der letzte Heartbeat sagt `ok:false` (und nicht `paused`): Exit-Code ungleich 0 (`exit`), Exit-Code 0 ohne Quittung dieses Laufs (`no-receipt`) oder der Zyklus meldet selbst, dass er den Eigentümer braucht (`needs-owner`; dieselbe Bedingung wie das Banner auf dem Mac: fehlgeschlagener Schritt, Auftrag mit «attention», Circuit-Breaker, Claude-Login nicht verfügbar, Stapel abgebrochen); die Mail nennt in der Zeile `Reason:` den Grund, dazu Exit-Code und Schritte | `node editorial/cycle.mjs --status`, Log wie oben; bei `no-receipt` steht im Log `cycle-run: the cycle exited with 0 but left no receipt of run …` |
| `off-site copy missing` / `off-site copy is back` | kein Archiv seit mehr als `WATCH_BACKUP_HOURS` (36) Stunden | `tail ~/Library/Logs/minitandem-editorial-offsite.log` |

Das Alter einer Datei ist ihr Alter auf dem Server, eine falsche Uhr auf dem Mac kann ein Schweigen also nicht verdecken. Eine Datei, die noch nie ankam, zählt ab dem ersten Lauf des Wächters; wird er vor dem Mac eingerichtet, bleibt er bis zum Ablauf der Frist still. Ein Heartbeat mit `paused:true` oder `skipped` gilt als lebendig und lässt den Zustand «failed» unverändert. Eine Mail, die nicht rausging, wird nicht als gesendet gemerkt; der nächste Lauf versucht es noch einmal. Exit-Code: 0 alles in Ordnung, 1 ein Problem ist offen (`SuccessExitStatus=0 1`), 2 eine Mail liess sich nicht senden.

Die zehn Stunden für «silent» ergeben sich aus der Nachtpause von 9 Stunden zwischen 22.30 und 07.30 Uhr. Schläft der Mac nachts und wacht erst nach 08.30 Uhr auf, kommt die Mail zu Recht; wer das nicht will, erhöht den Wert mit `sudo systemctl edit minitandem-cycle-watch.service` (`Environment=WATCH_SILENT_HOURS=14`).

**Einrichten, Server** (in dieser Reihenfolge):

```
cd /opt/minitandem                                  # Stand mit den neuen Dateien, siehe «Update»
sudo install -m 755 ops/drop.sh /usr/local/sbin/minitandem-drop
sudo install -d -o ubuntu -g ubuntu -m 755 /var/lib/minitandem-watch
install -d -m 700 ~/editorial-backups
# die Zeile aus ~/.ssh/minitandem_drop_ed25519.pub des Macs mit dem Vorspann von oben eintragen:
echo 'restrict,command="/usr/local/sbin/minitandem-drop" ssh-ed25519 AAAA… minitandem-drop' >> ~/.ssh/authorized_keys
addr=$(systemctl show minitandem-health.service -p Environment --value | tr ' ' '\n' | sed -n 's/^HEALTH_MAIL_TO=//p')
sed "s|EMPFAENGER|$addr|" ops/systemd/minitandem-cycle-watch.service | sudo tee /etc/systemd/system/minitandem-cycle-watch.service >/dev/null
sudo install -m 644 ops/systemd/minitandem-cycle-watch.timer /etc/systemd/system/minitandem-cycle-watch.timer
sudo systemctl daemon-reload && sudo systemctl enable --now minitandem-cycle-watch.timer
sudo systemctl start minitandem-cycle-watch.service && journalctl -u minitandem-cycle-watch -n 3
```

Die letzte Zeile muss `cycle-watch: silent=ok failed=ok backup=ok` ausgeben. Die Adresse steht wie beim Gesundheitstest nur auf dem Server, nicht im Repository.

**Einrichten, Mac:**

```
ssh-keygen -t ed25519 -N '' -C minitandem-drop -f ~/.ssh/minitandem_drop_ed25519
ssh-keygen -F 179.237.77.144 > /dev/null || echo "Der Server-Schlüssel fehlt in known_hosts"
```

Das Programm ruft `ssh` mit `-F /dev/null -o StrictHostKeyChecking=yes -o BatchMode=yes` auf: Ein unbekannter oder geänderter Server-Schlüssel führt zu einem Fehler, nicht zu einer Rückfrage. Fehlt der Eintrag, ihn einmal von Hand aufnehmen und den Fingerabdruck mit `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` auf dem Server vergleichen. Host, Benutzer und Schlüssel lassen sich mit `MINITANDEM_DROP_HOST`, `MINITANDEM_DROP_USER` und `MINITANDEM_DROP_KEY` ändern. Dann, nachdem die Schlüsselzeile auf dem Server eingetragen ist:

```
ssh -F /dev/null -i ~/.ssh/minitandem_drop_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes ubuntu@179.237.77.144 id
# muss mit «minitandem-drop: unknown command» enden, Exit-Code 1: der Schlüssel führt nur den Drop aus

REPO=/Pfad/zum/Checkout                             # der Ordner mit ops/ und editorial/
node $REPO/ops/editorial-offsite.mjs --dry-run      # alles ausser dem Hochladen
node $REPO/ops/editorial-offsite.mjs                # einmal von Hand: das erste Archiv auf dem Server
sed -e "s|@REPO@|$REPO|g" -e "s|@HOME@|$HOME|g" $REPO/ops/launchd/ch.minitandem.editorial-offsite.plist > ~/Library/LaunchAgents/ch.minitandem.editorial-offsite.plist
plutil -lint ~/Library/LaunchAgents/ch.minitandem.editorial-offsite.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ch.minitandem.editorial-offsite.plist
```

Die bestehende `ch.minitandem.editorial-cycle.plist` ändert sich nur in einer Zeile: Im Feld `ProgramArguments` wird `…/editorial/cycle.mjs` zu `…/ops/cycle-run.mjs` (das Programm bleibt `/usr/local/bin/node`). Zwischen zwei Läufen, nie während eines Stapels:

```
sed -i '' 's|/editorial/cycle.mjs|/ops/cycle-run.mjs|' ~/Library/LaunchAgents/ch.minitandem.editorial-cycle.plist
launchctl bootout gui/$(id -u)/ch.minitandem.editorial-cycle
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ch.minitandem.editorial-cycle.plist
```

Im Log des Zyklus (`~/Library/Logs/minitandem-editorial-cycle.log`) steht nach dem nächsten Lauf `cycle-run: heartbeat sent`.

**Wiederherstellen aus der Kopie.** Das Archiv holen (mit dem Admin-Schlüssel des Eigentümers, nicht mit dem Drop-Schlüssel), auspacken, prüfen, in einen neuen Ordner einspielen:

```
scp ubuntu@179.237.77.144:editorial-backups/editorial-JJJJ-MM-TT.tar.gz ~/Downloads/
mkdir ~/restore && tar -xzf ~/Downloads/editorial-JJJJ-MM-TT.tar.gz -C ~/restore
cd $REPO
node editorial/backup.mjs verify ~/restore/JJJJ-MM-TT
node editorial/backup.mjs restore ~/restore/JJJJ-MM-TT --to="$HOME/restore/arbeitsbereich"
```

`verify` prüft Summen, Warteschlange und Umfang; `restore` verlangt einen neuen, leeren Zielordner, legt dort den Arbeitsbereich samt Warteschlange (`editorial/workflow-state/jobs.sqlite`) an und vergleicht den Katalog mit dem Manifest. Nichts wird überschrieben. Der Arbeitsbereich ersetzt den Checkout erst, wenn der Eigentümer es entscheidet, bei gesetzter Pause und ohne ausgeliehenen Auftrag. Familiendaten sind nicht im Archiv.

**Pausieren und abschalten.**

- Zyklus pausieren: `touch editorial/cycle.pause`. Der Zyklus tut nichts, die Heartbeats sagen `paused:true`, es kommt weder «silent» noch «failed». Aufheben: Datei löschen. Eine vergessene Pause wird nicht gemeldet.
- Tägliche Kopie anhalten: `launchctl bootout gui/$(id -u)/ch.minitandem.editorial-offsite` (wieder starten mit `bootstrap`). Nach 36 Stunden kommt «off-site copy missing».
- Wächter anhalten: `sudo systemctl stop minitandem-cycle-watch.timer` (starten mit `start`); die gemerkten Zustände bleiben erhalten.
- Jeden Zugriff des Macs sperren: die Zeile mit `minitandem-drop` aus `~/.ssh/authorized_keys` löschen.

**Stand.** Die Skripte laufen im Test (`ops-watch.test.mjs`) mit Ersatzprogrammen für `ssh`, `sendmail` und `editorial/backup.mjs` in Wegwerf-Ordnern, `drop.sh` und `cycle-watch.sh` unter `sh` und `dash`, und `cycle-run.mjs` und `editorial-offsite.mjs` gegen das echte `drop.sh`. Die Sperre ist mit erfundenen Prozessen und einer verstellbaren Uhr getestet (`editorial/process-lock.test.mjs`: zwei Bewerber, verzögertes Anlegen, ein lebender Besitzer über Tage, wiederverwendete Prozess-ID, Freigabe durch einen alten Besitzer, alte Verzeichnisse) und mit echten, gleichzeitig gestarteten Prozessen; der Zyklus selbst wurde dabei nie gestartet. Mit dem echten `editorial/backup.mjs` wurden `--dry-run`, `verify` und `restore` in einem Arbeitsbaum durchgespielt (leere Warteschlange). Die Einrichtung auf dem Server und auf dem Mac steht noch aus; hier wird sie mit Datum eingetragen.

## Restore-Drill (Checkliste)

Mindestens vierteljährlich und nach jeder Änderung am Sicherungsablauf, **ohne den laufenden Dienst anzutasten**:

- [ ] Jüngstes Archiv `minitandem-state-….tgz` auf den Server zurückholen (von dort, wohin es kopiert wurde), nicht aus `~/backups`.
- [ ] Archiv lesen: `tar tzf minitandem-state-….tgz` zeigt `families.json`, `demo-family-key.txt`, `corrections/`, `backup-*.json`.
- [ ] Leeres Test-Volume anlegen: `docker volume create minitandem_state_drill`.
- [ ] Einspielen: `docker run --rm -v minitandem_state_drill:/state -v ~/backups:/backup:ro alpine sh -c 'tar xzf /backup/<DATEI>.tgz -C /state && chown -R 1000:1000 /state'`.
- [ ] Wegwerf-Container mit dem Test-Volume starten: `docker run -d --rm --name minitandem-drill -p 127.0.0.1:18787:8787 -v minitandem_state_drill:/state minitandem-app:$(grep ^MINITANDEM_TAG .env | cut -d= -f2)`.
- [ ] `curl -fsS http://127.0.0.1:18787/healthz` antwortet `ok`.
- [ ] Der Schlüssel der Demo-Familie funktioniert: `curl -fsS -H "Authorization: Bearer $(docker exec minitandem-drill cat /state/demo-family-key.txt)" http://127.0.0.1:18787/api/v1/family` antwortet mit 200.
- [ ] Es gibt keinen Editor-Schlüssel: `docker exec minitandem-drill node -e "console.log(JSON.parse(require('fs').readFileSync('/state/families.json','utf8')).adminHash)"` gibt `null` aus.
- [ ] Aufräumen: `docker stop minitandem-drill && docker volume rm minitandem_state_drill`.
- [ ] Datum, Archivname und Ergebnis notieren. Schlug ein Schritt fehl, ist die Sicherung nicht brauchbar: Ursache beheben und den Drill wiederholen.
- [ ] Die Zertifikats-Sicherung (`minitandem-caddy-….tgz`) wenigstens einmal lesen (`tar tzf …`); ein Wiederherstellen von Zertifikaten wird nur bei Bedarf geübt.

## Stand der Prüfung

Geprüft auf dem Entwicklungsrechner, ohne Docker:

- Die Dateien `compose.yaml` und `compose.local.yaml` wurden mit einem YAML-Parser gelesen; Struktur und Regeln (nur Caddy mit Ports, benannte Volumes, `read_only`, Pflichtvariable `ACME_EMAIL`) prüft `docker-files.test.mjs`.
- `docker/entrypoint.sh` läuft im Test mit einem leeren Zustandsordner: eine Demo-Familie, kein Editor-Schlüssel, `/healthz` antwortet, ein zweiter Start ändert nichts.
- `ops/healthcheck.sh` läuft im Test gegen einen Wegwerf-Server mit einem Ersatz für `sendmail`: eine Mail beim Ausfall, eine bei der Rückkehr, sonst keine.
- `ops/deploy.sh` läuft im Test (`deploy.test.mjs`) mit Ersatzprogrammen für `ssh`, `docker`, `gh` und `curl`; der «Server» ist ein lokaler Git-Klon. Geprüft sind: Abbruch ohne genau einen vollständigen Commit, ohne grüne CI (kein, laufender oder fehlgeschlagener Lauf), bei 20 % weniger Karten (und die Grenze 272/273 von 321), bei geändertem Checkout; die Vorschau ohne Volume auf `127.0.0.1`; der Tag und der Rollback-Befehl am Ende; die Rückkehr zum alten Tag und Checkout, wenn der neue Container nicht `healthy` wird, das öffentliche `/healthz` die Vorschau nicht zeigt oder der Build scheitert.
- Die Regeln aus `.dockerignore` werden im Test nachgebildet; kein privater Pfad der Audit-Liste gelangt in den Build-Kontext.

Auf dem Server, am 14. Oktober 2026:

- Deployment nach «Erstes Deployment»: Das Image wurde gebaut, beide Container laufen, Caddy hat die Zertifikate für `minitandem.ch` und `www.minitandem.ch` von Let's Encrypt bezogen. Von aussen geprüft: `www` und `http` leiten auf `https://minitandem.ch` um, `/healthz` antwortet, die Editor-Pfade antworten mit 404, die Oberfläche läuft in allen drei Sprachen.
- Ein Update nach «Update» lief durch; das vorherige Image blieb für einen Rollback erhalten.
- Sichern und Wiederherstellen wurden geübt (siehe dort).
- Überwachung per E-Mail eingerichtet: Eine Testmail sowie je eine Mail für Ausfall und Rückkehr wurden über `mail.infomaniak.com:587` verschickt, vom Relay angenommen und kamen an; der Timer läuft alle fünf Minuten.

**Nicht geprüft:** `ops/deploy.sh` gegen den echten Server und echtes Docker (der erste Lauf geschieht mit dem Eigentümer), die tmpfs-Optionen der Vorschau (`uid=1000,gid=1000`) auf dem Server, ein Neustart des ganzen Servers (die Container haben `restart: unless-stopped`, Docker startet beim Booten) und das Erneuern eines Zertifikats. Die jetzigen Zertifikate gelten bis zum 12. Januar 2027; Caddy erneuert sie vorher selbst, voraussichtlich ab Mitte Dezember 2026.
