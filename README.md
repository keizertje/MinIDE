# Mini IDE

Een kleine web-IDE in puur HTML/CSS/JavaScript (geen build-stap), in de stijl van
Notepad met een bestandsboom links en een sectiepaneel rechts.

## Starten

De File System Access API heeft een beveiligde context nodig (https of localhost):

- Lokaal: draai `python -m http.server 8000` in deze map en open http://localhost:8000
- Of gratis online via GitHub Pages (https)

Gebruik Chrome of Edge (andere browsers ondersteunen `showDirectoryPicker` nog niet).

## Werking

- **Map openen**: knop linksboven. De map-handle wordt in IndexedDB bewaard en bij
  een volgend bezoek automatisch hersteld (als de toestemming nog geldig is).
- **Bestandsboom**: links in het paneel. Mappen zijn inklapbaar; `.git` en
  `node_modules` worden verborgen. De boom ververst elke 5 seconden automatisch.
- **Beide panelen resizebaar**: sleep de rand tussen paneel en editor (links en
  rechts). Breedtes worden onthouden (localStorage).
- **Bestand openen**: klik op een bestand in de boom om het in het hoofdvenster te
  bewerken. Binaire bestanden worden gedetecteerd en niet als tekst bewerkt.
- **Automatisch opslaan**: ca. 0,8 seconde nadat je stopt met typen wordt het
  bestand naar schijf geschreven (of direct met Ctrl+S). De status rechtsboven
  toont "Opslaan…" / "Opgeslagen om …".
- **Automatische sync vanaf schijf**: elke 2 seconden wordt gecontroleerd of het
  geopende bestand op schijf is gewijzigd; zo ja, dan wordt de inhoud herladen
  (alleen als je geen niet-opgeslagen lokale wijzigingen hebt).
- **Regelnummers**: in de kolom links van de editor; ze lopen op bij elke `\n`
  in het bestand (niet bij een wrap).
- **Hard wrap**: regels worden aan de rechterrand van het scherm afgebroken;
  horizontaal scrollen is niet nodig.
- **Bracket matching**: staat de cursor naast een haakje (`()`, `[]`, `{}`, `<>`),
  dan wordt het corresponderende sluitende/openende haakje omlijnd.

## Sectiepaneel (rechts)

Vervangt de losse regex-velden: hier maak je **secties** aan (＋). Een sectie heeft:

- een **naam** (direct te bewerken),
- een **actief/niet-actief** checkbox (alleen actieve secties werken),
- **open-/dichtklappen** via de pijl (zoals in VSCode),
- een **achtergrondkleur** en **voorgrondkleur** voor de matches — wit als
  voorgrondkleur is hetzelfde als verbergen,
- **meerdere regexen** per sectie (＋ regex), elk met een eigen verwijderknop.

Matches van alle regexen in een actieve sectie krijgen de kleuren van die sectie.
Bij overlap wint de eerste (bovenste) sectie. Secties worden in localStorage
bewaard.

- **Instellingen (⚙)**: oa. het **max. aantal matches per regex** (standaard 5000),
  ook bewaard in localStorage.
- **Recursieve regex**: de engine is Regex+ 6.1.0 met de officiële
  `regex-recursion`-plugin 6.0.2, geladen vanaf jsdelivr (CDN), dus `(?R)`,
  `(?R=N)` en `\g<naam&R=N>` werken (diepte 2–100; plain `(?R)` wordt
  automatisch `(?R=100)`). Let op: `(?R)` recursed het hele patroon, net als in
  PCRE — gebruik `\g<naam&R=N>` om alleen een benoemde group te herhalen.
  Zonder internet (CDN onbereikbaar) valt de engine terug op de ingebouwde
  `RegExp` — dan werken gewone regexes nog wel, maar `(?R)` niet.

## Technische werking

De editor bestaat uit een transparante `<textarea>` (bevat altijd de volledige,
echte tekst — bron van waarheid voor positie, caret, wrap en opslag) met
daarachter een overlay-`<div>` met identieke layout. De overlay rendert per
sectie gekleurde spans (inline `color`/`background`) en een outline voor het
bracket-paar. Regelnummers worden in de gutter gepositioneerd via de echte
layout-positie (Range-rect) van elke regelstart, dus ze blijven synchroon bij
wraps. Omdat de overlay qua layout 1-op-1 gelijk is aan de textarea (inclusief
scrollbar-compensatie), blijven caret, scroll en muisklikken altijd op de juiste
plek, óók met gekleurde/verborgen tekst.
