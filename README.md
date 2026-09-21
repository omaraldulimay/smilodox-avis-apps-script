# Avis-Packlisten-Automatisierung

Google Apps Script Projekt, das Packlisten-Anhänge aus Gmail (Lieferant J, Lieferant I) automatisch gegen den Lagerbestand abgleicht, als Avis-CSV aufbereitet und darüber echte Bestellungen im Smilodox Portal (portal.example.com) anlegt.

## Dateien

- `AvisCSV.js` – Kernlogik: Packliste einlesen, gegen Lagerbestand abgleichen, CSV erzeugen
- `AvisPortalUpload.js` – Anbindung ans Portal (Anmeldung, Bestellung anlegen, CSV hochladen, Bestellungen zusammenführen)
- `AvisDatenbank.js` – ältere, nachrangige Anbindung an eine Test-Datenbank
- `AvisDiagnose.js` – Diagnose- und Testfunktionen, u. a. `avisSystemcheck()`
- `MailTest.js`, `ShipmentMailTest.js`, `LieferantMailPrüfung.js` – weitere Testhilfen

## Skripteigenschaften (in Apps Script hinterlegen, nicht im Code)

- `PORTAL_COGNITO_CLIENT_ID`, `PORTAL_AUTOMATION_USER`, `PORTAL_AUTOMATION_PASS`
- Lieferantennummern und weitere Kernwerte (siehe `avisSystemcheck()` für die vollständige Liste)

## Ablauf

1. `pruefeNeuePacklisten` prüft alle 15 Minuten auf neue Anhänge
2. Positionen werden gegen den Lagerbestand abgeglichen, nicht zuordenbare Positionen werden trotzdem mit einer Platzhalter-EAN und einer Ursache-Beschreibung übernommen
3. Es entsteht eine Bestellung im Portal (Status "Offen"), auch wenn nicht alle Positionen zugeordnet werden konnten

## Bekannte Einschränkung: Bestellungen zusammenführen

Das Portal unterstützt kein natives Zusammenführen zweier Bestellungen (z. B. von zwei Lieferanten). `avisPortalZusammenfuehren_` in `AvisPortalUpload.js` ist ein Behelfsweg: liest Positionen aus beiden Quellen, legt eine neue Bestellung an, löscht die beiden alten. Eine echte Lösung (Checkbox-Auswahl + Button direkt im Portal) müsste im Portal-Backend/-Frontend selbst gebaut werden.
