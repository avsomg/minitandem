# Betrieb: Server, Sicherung, Überwachung

Dieses Dokument beschreibt, wie Minitandem auf einem kleinen Server laufen würde. **Vorbereitet, nicht ausgeführt:** Es wurde nichts ausgerollt, keine Verbindung zum Server aufgebaut und das Image auf dem Entwicklungsrechner nicht gebaut (siehe «Stand der Prüfung» ganz unten).

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
- `docker/entrypoint.sh`: legt beim ersten Start **genau eine Demo-Familie** an (Schlüssel in `/state/demo-family-key.txt`) und startet den Dienst. Ein **Editor-Schlüssel** (`server.mjs new-admin`) wird auf dem Server **nie** erzeugt; ohne ihn antworten alle Editor-Routen mit 401.
- Die redaktionelle Pipeline (`editorial/cycle.mjs`, die Worker) läuft **nicht** auf dem Server, sondern auf dem Rechner des Eigentümers. Der Server hat weder die privaten Daten noch Modell-Zugänge.

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
curl -fsS https://minitandem.ch/healthz     # {"status":"ok","records":...}
```

Beim ersten Start holt Caddy die Zertifikate; das dauert meist unter einer Minute (`docker compose logs caddy`). Den Schlüssel der Demo-Familie zeigt `docker compose exec app cat /state/demo-family-key.txt`. Er schützt nur Demo-Daten.

Die Seite wird beim Bauen des Images erzeugt, **ohne** die Publikations-Gates (sie brauchen private Belege, die nicht im Repository liegen; die Build-Ausgabe sagt `publicationGates: skipped`). Diese Gates laufen vor dem Commit auf dem Rechner des Eigentümers. Vor dem Deployment also nur Stände aus dem Repository nehmen, die dort geprüft wurden.

## Update

```
cd /opt/minitandem
git fetch --tags && git checkout <Tag oder Commit>
sed -i "s/^MINITANDEM_TAG=.*/MINITANDEM_TAG=$(git rev-parse --short HEAD)/" .env
docker compose up -d --build
curl -fsS https://minitandem.ch/healthz
```

Der alte Image-Tag bleibt erhalten; das ist die Grundlage für den Rollback. Das Volume `state` wird bei einem Update nicht angetastet.

## Rollback

```
cd /opt/minitandem
docker image ls minitandem-app          # welche Tags gibt es?
git checkout <alter Commit>
sed -i "s/^MINITANDEM_TAG=.*/MINITANDEM_TAG=<alter Tag>/" .env
docker compose up -d --no-build         # nimmt das vorhandene Image
curl -fsS https://minitandem.ch/healthz
```

Der Dienst hat keine Datenmigrationen (Format `schema: 1`), ein Rollback der Version lässt den Zustand daher unverändert nutzbar. Fehlt das alte Image, mit `docker compose up -d --build` am alten Commit neu bauen. Alte Images erst löschen (`docker image prune`), wenn die neue Version eine Weile problemlos läuft.

## Sichern und Wiederherstellen des State-Volumes

Im Volume `minitandem_state` liegen die gehashten Familienschlüssel und Profile (`families.json`), eingereichte Korrekturen (`corrections/`), die Datei `demo-family-key.txt` und die 20 letzten automatischen Kopien `backup-*.json`, die der Dienst bei jedem Schreiben anlegt. Der Dienst ersetzt Dateien atomar, ein Archiv im laufenden Betrieb ist deshalb in sich konsistent.

**Sichern.** `ops/backup.sh` legt beide Archive an und behält von jeder Art die 14 neuesten. Auf dem Server ist es als `/usr/local/sbin/minitandem-backup` installiert und läuft jede Nacht um 03:15 UTC per Cron des Benutzers `ubuntu`:

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
- Die Regeln aus `.dockerignore` werden im Test nachgebildet; kein privater Pfad der Audit-Liste gelangt in den Build-Kontext.

**Nicht geprüft:** das Bauen des Images, das Starten der Container, die Syntax des `Caddyfile` und das Ausstellen von Zertifikaten. Auf dem Entwicklungsrechner ist zwar ein Docker-Client installiert, aber kein laufender Docker-Dienst. Vor dem ersten echten Deployment deshalb zuerst `docker compose config -q`, `docker compose build` und
`docker run --rm -e ACME_EMAIL=test@example.org -v "$PWD/docker/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile` ausführen.
