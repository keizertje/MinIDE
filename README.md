# Mini IDE

Een kleine web-IDE in puur HTML/CSS/JavaScript (geen build-stap), in de stijl van
Notepad met een bestandsboom in een smalle kolom links.

## Starten

De File System Access API heeft een beveiligde context nodig (https of localhost):

- Lokaal: draai `python -m http.server 8000` in deze map en open http://localhost:8000
- Of gratis online via GitHub Pages (https)

Gebruik Chrome of Edge (andere browsers ondersteunen `showDirectoryPicker` nog niet).

## Werking

- **Map openen**: knop linksboven. De map-handle wordt in IndexedDB bewaard en bij
  een volgend bezoek automatisch hersteld (als de toestemming nog geldig is).
- **Bestandsboom**: links in de smalle kolom. Mappen zijn inklapbaar; `.git` en
  `node_modules` worden verborgen. De boom ververst elke 5 seconden automatisch.
- **Bestand openen**: klik op een bestand in de boom om het in het hoofdvenster te
  bewerken. Binaire bestanden worden gedetecteerd en niet als tekst bewerkt.
- **Automatisch opslaan**: ca. 0,8 seconde nadat je stopt met typen wordt het
  bestand naar schijf geschreven (of direct met Ctrl+S). De status rechtsboven
  toont "Opslaan…" / "Opgeslagen om …".
- **Automatische sync vanaf schijf**: elke 2 seconden wordt gecontroleerd of het
  geopende bestand op schijf is gewijzigd; zo ja, dan wordt de inhoud herladen
  (alleen als je geen niet-opgeslagen lokale wijzigingen hebt).
- **Bracket matching**: staat de cursor naast een haakje (`()`, `[]`, `{}`, `<>`),
  dan wordt het corresponderende sluitende/openende haakje in dezelfde kleur
  omlijnd.
- **Regex verbergen**: in het invoerveld in de topbalk kun je een regex invoeren.
  Alle matches in het huidige bestand worden dan verborgen in de weergave
  (onzichtbaar, maar de tekst blijft gewoon in het bestand — in de browser én op
  schijf). Wijzigingen worden op de juiste plek in de volledige tekst ingevoegd,
  óók als er tekst verborgen is. Leeg veld = niets verborgen. Ongeldige regex
  wordt gemeld in de status.

## Technische werking

De editor bestaat uit een transparante `<textarea>` (bevat altijd de volledige,
echte tekst — bron van waarheid voor positie, caret en opslag) met daarachter een
overlay-`<div>` die dezelfde tekst rendert met `visibility: hidden` voor
regex-matches en een highlight voor het bracket-paar. Omdat de overlay exact
dezelfde layout heeft als de textarea, blijven caret, scroll en muisklikken
altijd op de juiste plek, ongeacht verborgen tekst.
