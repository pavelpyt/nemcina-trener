# Německý trenér

Trenér němčiny z `Nemecky_trener.jsx`, rozšířený o seed data vygenerovaná ze **všech**
souborů ve složce `~/Desktop/Nemcina`.

```bash
npm install      # jednorázově
npm run dev      # http://localhost:3009
```

Zdrojová složka se nikdy nemění — čte se jen pro čtení a originály se kopírují do
`public/materialy/`.

## Co je v aplikaci

| Záložka | Obsah |
|---|---|
| Kartičky | 1 057 karet (slovíčka DE→CZ, silná slovesa, gramatické otázky) |
| Výběr | 864 cvičení s výběrem ze 4 možností (překlady, předložky, členy) |
| Psaní | 1 265 psacích cvičení (CZ→DE, tvary sloves, předložky) |
| Konverzace | 202 frází DE/CZ |
| Materiály | 113 zdrojových listů — vytažený text, obrázky skenů, tabulky, originál k otevření |
| Poznámky | volný text |

Postup se počítá Leitnerovými boxy (intervaly 0/1/2/4/7/14/30 dní). V `localStorage`
je jen pokrok, poznámky a téma — obsah je statický, takže úložiště zůstává malé.

## Odkud data pocházejí

`npm run seed` (= `python3 tools/extract.py`) projde 122 souborů (102 PDF + 4 DOCX +
2 ZIP archivy s dalšími 6 PDF, 9 tabulkami a 1 MP3) a vygeneruje `src/data/seed.json`.

Parsery podle typu listu:

* **dvousloupcové slovníčky** (SSD I. 1.–8. lekce, Wortschatz) — sloupce = DE/CZ pár;
  orientace se určuje hlasováním za celý soubor, ne po řádcích
* **oboustranné kartičky POLYGLOT** (`Wortschatz (deutsch-tschechisch)`) — německá
  strana a zrcadlená česká strana se párují podle souřadnic na stránce
  (`x_cz → šířka − x`), řádky podle svislé pozice
* **stresované písmo POLYGLOT** — `best2hen` → `bestehen` (číslice nahrazují
  přízvučné samohlásky: 0=y, 1=a, 2=e, 3=i, 4=o, 5=u, 6=ä, 7=ö, 8=ü)
* **silná slovesa** — 4sloupcová tabulka → karta + 3 psací cvičení na každé sloveso
* **trénink předložek** (`.xls`/`.ods`) — samokontrolní testy; cvičení se zakotví na
  české předložce, člen se dopočítá z rodu podstatného jména zjištěného ze 4. pádu
* **prozaické listy** — jen věty, kde je německá věta a její český překlad na jednom
  řádku; gramatické komentáře se odfiltrují
* **skeny bez textové vrstvy** (`Uhrzeiten`, `stolovani_v_restauraci_B1`,
  `Wortschatz-4.Lektion`) — vykreslené jako obrázky stránek a **ručně přepsané** do
  `tools/manual_seed.json` (na tomto stroji není OCR)

Vlastní osobní sada z původního `.jsx` zůstala nedotčená v `src/data/personal.js`.

## Co se záměrně negeneruje

* **pexeso a domino** (`Memory-Spiel`, `Domino`) — kartičky jsou na listu zamíchané,
  takže páry nelze z rozvržení spolehlivě určit. Zůstávají jako materiál.
* **grafický jídelní lístek** (`Wortschatz (Speisekarte)`) — text je word-art, ze
  kterého vychází nečitelné úlomky.
* **pracovní listy s mezerami** (`Procvicovani*`, `Haus-1`, `Steigerung`) — zadání bez
  klíče; jsou spárované se svým `-KLIC` souborem a čitelné v Materiálech.

`build/conflicts.json` po každém běhu vypíše karty, které si odporují s ověřeným
slovníčkem — slouží jako kontrola parserů (aktuálně 3 záznamy, všechny legitimní
dvojznačnosti typu `laut` = hlasitý / podle).
