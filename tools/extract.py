#!/usr/bin/env python3
"""
Build seed data for the German trainer out of every file in ~/Desktop/Nemcina.

Nothing is dropped: each source file becomes a "material" (full extracted text,
page by page, page images for scans, plus a link to the original), and wherever
the layout is machine-readable it also becomes study items (cards / fill-ins /
typing / conversation phrases).

Run:  python3 tools/extract.py
Out:  src/data/seed.json  +  public/materialy/** (originals + page images)
"""
import hashlib
import json
import random
import re
import shutil
import subprocess
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

SRC = Path("/Users/pavel.pytlik/Desktop/Nemcina")
ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "build"
PUB = ROOT / "public" / "materialy"
OUT = ROOT / "src" / "data" / "seed.json"
MANUAL = ROOT / "tools" / "manual_seed.json"
XHTML = "{http://www.w3.org/1999/xhtml}"
RNG = random.Random(20260729)

# Czech-only letters: German never uses these, which makes them a reliable
# language discriminator for deciding which side of a line is which.
CZ_ONLY = set("ěščřžýáíéůúťďňóĚŠČŘŽÝÁÍÉŮÚŤĎŇÓ")
DE_ONLY = set("äöüßÄÖÜ")
CZ_WORDS = {
    "a", "se", "si", "na", "je", "do", "od", "za", "ke", "ze", "být", "mít", "že",
    "jak", "kde", "když", "protože", "ale", "nebo", "ano", "ne", "můj", "moje",
    "jsem", "jsi", "jsme", "jste", "jsou", "byl", "byla", "bych", "aby", "také",
    "velmi", "hodně", "vždy", "nikdy", "často", "něco", "tam", "ten", "ta", "to",
    "mě", "mi", "vám", "vás", "nás", "jeho", "její", "pro", "bez", "proti", "člen",
}
DE_WORDS = {
    "der", "die", "das", "ein", "eine", "einen", "einem", "einer", "und", "oder",
    "ist", "sind", "war", "waren", "nicht", "kein", "keine", "ich", "du", "er",
    "sie", "es", "wir", "ihr", "mit", "von", "zu", "auf", "in", "im", "am", "an",
    "für", "aus", "bei", "nach", "haben", "hat", "habe", "sein", "wird", "werden",
    "dass", "weil", "aber", "auch", "sehr", "man", "hier", "dort", "wie", "was",
    "möchte", "kann", "muss", "soll", "darf", "mag", "wenn", "als", "schon", "noch",
}

# POLYGLOT worksheets mark the stressed vowel with a digit glyph.
STRESS_DIGITS = {"0": "y", "1": "a", "2": "e", "3": "i", "4": "o", "5": "u",
                 "6": "ä", "7": "ö", "8": "ü", "9": "y"}
ART_PREFIX = {"r": "der", "e": "die", "s": "das"}

BOILERPLATE = re.compile(
    r"^(©|Lektion \d+\s*:|Studenti |Die Schüler |a\)\s|b\)\s|c\)\s|Autor|Autorem|"
    r"Metodick|Kartičky|Klíč|Zdroj|Obrázk|www\.|Strana \d|Seite \d|počet bodů|"
    r"Ergänzen Sie|Arbeitsblatt|Jméno|Třída|Test \d|odstřihni|Doplň)", re.I)

# Decorative / word-art worksheets whose text layer is unusable as vocabulary.
VOCAB_DENY = (r"wortschatz \(speisekarte\)",)


# ---------------------------------------------------------------- helpers
def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def slugify(name: str) -> str:
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-")
    return re.sub(r"-{2,}", "-", s)


def fix_stress_digits(text: str) -> str:
    """best2hen -> bestehen, (-s, -4ren) -> (-s, -oren)"""
    return re.sub(r"(?<=[A-Za-zÄÖÜäöüß\-])([1-9])(?=[A-Za-zÄÖÜäöüß])",
                  lambda m: STRESS_DIGITS[m.group(1)], text)


def strip_phonetics(text: str) -> str:
    """Drop [gwrna;lJst] transcriptions (broken IPA font) but keep (-[e]s, -e)."""
    return re.sub(r"\[[^\]]{2,}\]", "", text)


def words_of(s: str):
    return re.findall(r"[^\W\d_]+", s.lower(), re.UNICODE)


def has_cz_only(s: str) -> bool:
    return any(c in CZ_ONLY for c in s)


def cz_score(s: str) -> int:
    return sum(1 for c in s if c in CZ_ONLY) * 2 + sum(1 for w in words_of(s) if w in CZ_WORDS)


def de_score(s: str) -> int:
    return sum(1 for c in s if c in DE_ONLY) * 2 + sum(1 for w in words_of(s) if w in DE_WORDS)


def clean_cell(s: str) -> str:
    s = s.replace("­", "").replace("ﬁ", "fi").replace("ﬂ", "fl").replace(" ", " ")
    s = re.sub(r"[-]", " ", s)      # symbol-font bullets (Wingdings)
    s = re.sub(r"\s+", " ", s).strip()
    return s.strip(" ;·•\t*")


def is_germanish(s: str) -> bool:
    """German side must not contain Czech-only diacritics."""
    return not has_cz_only(s)


def is_czechish(s: str) -> bool:
    return has_cz_only(s) or any(w in CZ_WORDS for w in words_of(s))


def plausible_word(s: str) -> bool:
    """Filter word-art / OCR-style debris."""
    if len(s) < 2:
        return False
    letters = re.findall(r"[^\W\d_]", s, re.UNICODE)
    if len(letters) < 2:
        return False
    if not re.search(r"[aeiouäöüyáéíóúůy]", s, re.I):
        return False
    return True


def looks_like_pair(de: str, cz: str) -> bool:
    if not de or not cz:
        return False
    if not (2 <= len(de) <= 120) or not (2 <= len(cz) <= 120):
        return False
    if BOILERPLATE.match(de) or BOILERPLATE.match(cz):
        return False
    if de.lower() == cz.lower():
        return False
    if not plausible_word(de) or not plausible_word(cz):
        return False
    if re.search(r"\b(lekce|Lektion)\b", de, re.I) and re.search(r"\d", de):
        return False
    if re.search(r"\b(lekce|Lektion)\b", cz, re.I) and re.search(r"\d", cz):
        return False
    for side in (de, cz):
        if re.search(r"[…_]{2,}|…|_{2,}|\.{3,}", side):   # gap-fill exercise line
            return False
        if re.match(r"^\d{1,2}\s*[.)]\s", side):          # exercise numbering
            return False
    return True


def split_gaps(line: str, min_gap: int = 3):
    return [clean_cell(p) for p in re.split(r" {%d,}" % min_gap, line.rstrip()) if p.strip()]


def split_biggest_gap(line: str, min_gap: int = 3):
    gaps = [(m.end() - m.start(), m.start(), m.end()) for m in re.finditer(r" {%d,}" % min_gap, line)]
    if not gaps:
        return None
    _, a, b = max(gaps)
    left, right = clean_cell(line[:a]), clean_cell(line[b:])
    return (left, right) if left and right else None


def dash_split(seg: str):
    parts = re.split(r"\s+[-–—]\s+", seg, maxsplit=1)
    if len(parts) != 2:
        parts = re.split(r"(?<=[a-zäöüß])\s*[–—]\s*(?=[A-Za-zÁ-Žá-ž])", seg, maxsplit=1)
    if len(parts) == 2 and parts[0].strip() and parts[1].strip():
        return clean_cell(parts[0]), clean_cell(parts[1])
    return None


def finalize_pairs(cands):
    """Decide German/Czech orientation once for the whole file, then filter.

    Deciding per row lets a single ambiguous line flip sides; a file-level vote is
    both more accurate and less lossy for rows without diacritics ('das Auto'/'auto').
    """
    votes = 0
    for a, b in cands:
        if is_germanish(a) and has_cz_only(b):
            votes += 1
        elif is_germanish(b) and has_cz_only(a):
            votes -= 1
        else:
            d = (de_score(a) + cz_score(b)) - (de_score(b) + cz_score(a))
            votes += (d > 0) - (d < 0)
    flip = votes < 0
    out = []
    for a, b in cands:
        de, cz = (b, a) if flip else (a, b)
        if has_cz_only(de):            # a Czech "German" side means the row is noise
            continue
        if looks_like_pair(de, cz):
            out.append((de, cz))
    return dedupe_pairs(out)


def order_pair(a: str, b: str):
    """Return (german, czech) or None when neither side is convincingly German."""
    if is_germanish(a) and is_czechish(b) and not is_germanish(b):
        return a, b
    if is_germanish(b) and is_czechish(a) and not is_germanish(a):
        return b, a
    # both sides diacritic-free: fall back to function-word evidence
    fwd, rev = de_score(a) + cz_score(b), de_score(b) + cz_score(a)
    if fwd > rev and fwd > 0:
        return a, b
    if rev > fwd and rev > 0:
        return b, a
    return None


def dedupe_pairs(pairs):
    seen, out = set(), []
    for a, b in pairs:
        k = (a.lower(), b.lower())
        if k in seen:
            continue
        seen.add(k)
        out.append((a, b))
    return out


def normalize_headword(de: str):
    """'s Andenken (-s, -)' -> ('das Andenken', '(-s, -)')
       'Badezimmer das, -s, -' -> ('das Badezimmer', '-s, -')"""
    de = clean_cell(de)
    m = re.match(r"^([res])\s+([A-ZÄÖÜ][\wÄÖÜäöüß/|-]*)\s*(.*)$", de)
    if m:
        return f"{ART_PREFIX[m.group(1)]} {m.group(2)}", clean_cell(m.group(3))
    m = re.match(r"^([A-ZÄÖÜ][\wÄÖÜäöüß/|-]*)\s+(das|der|die)\s*,\s*(.*)$", de)
    if m:
        return f"{m.group(2)} {m.group(1)}", clean_cell(m.group(3))
    m = re.match(r"^(.*?)\s*(\((?:-|=|der|die|das|er |es |sich)[^)]*\))$", de)
    if m and len(m.group(1)) > 2:
        return clean_cell(m.group(1)), clean_cell(m.group(2))
    return de, ""


def typing_answer(de: str) -> str:
    return de.replace("|", "").strip()


def is_sentence(s: str) -> bool:
    """A whole phrase to rehearse, as opposed to a dictionary entry."""
    s = s.strip()
    if len(s.split()) < 3 or not re.search(r"[.!?]$", s):
        return False
    if not re.match(r"^[A-ZÄÖÜ]", s):
        return False
    if re.search(r"\||\betw\.|\bj-n\b|\bjmdn\b|\bj-m\b|\(\d\.\s*p\.\)", s):
        return False
    return True


# ---------------------------------------------------------------- source gathering
def gather_sources():
    out = []
    unz = WORK / "unzipped"
    if unz.exists():
        shutil.rmtree(unz)
    for p in sorted(SRC.iterdir()):
        if p.name.startswith("."):
            continue
        if p.suffix.lower() == ".zip":
            dest = unz / slugify(p.stem)
            dest.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(p) as z:
                for info in z.infolist():
                    if info.is_dir():
                        continue
                    try:
                        nm = info.filename.encode("cp437").decode("utf-8")
                    except Exception:
                        nm = info.filename
                    target = dest / Path(nm).name
                    with z.open(info) as fh, open(target, "wb") as fo:
                        shutil.copyfileobj(fh, fo)
                    out.append((Path(nm).name, target, p.name))
        else:
            out.append((p.name, p, None))
    return out


# ---------------------------------------------------------------- text extraction
def pdf_pages(path: Path):
    try:
        txt = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"],
                             capture_output=True, text=True, timeout=180).stdout
    except Exception:
        return []
    pages = txt.split("\f")
    while pages and not pages[-1].strip():      # pdftotext ends with a form feed
        pages.pop()
    return pages


def pdf_bbox(path: Path):
    try:
        return subprocess.run(["pdftotext", "-bbox-layout", "-enc", "UTF-8", str(path), "-"],
                              capture_output=True, text=True, timeout=180).stdout
    except Exception:
        return ""


def docx_text(path: Path):
    try:
        return subprocess.run(["textutil", "-convert", "txt", "-stdout", str(path)],
                              capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return ""


def sheet_rows(path: Path):
    ext = path.suffix.lower()
    sheets = []
    if ext == ".xls":
        import xlrd
        wb = xlrd.open_workbook(str(path))
        for sh in wb.sheets():
            rows = []
            for r in range(sh.nrows):
                row = []
                for c in range(sh.ncols):
                    v = sh.cell_value(r, c)
                    if isinstance(v, float) and v == int(v):
                        v = int(v)
                    row.append(clean_cell(str(v)))
                rows.append(row)
            sheets.append((sh.name, rows))
    elif ext == ".ods":
        from odf.opendocument import load
        from odf.table import Table, TableRow, TableCell
        from odf.text import P
        from odf import teletype
        doc = load(str(path))
        for t in doc.spreadsheet.getElementsByType(Table):
            rows = []
            for r in t.getElementsByType(TableRow):
                row = []
                for c in r.getElementsByType(TableCell):
                    rep = int(c.getAttribute("numbercolumnsrepeated") or 1)
                    txt = clean_cell(" ".join(teletype.extractText(p) for p in c.getElementsByType(P)))
                    row.extend([txt] * min(rep, 8))
                rows.append(row)
            sheets.append((t.getAttribute("name") or "List", rows))
    return sheets


# ---------------------------------------------------------------- classification
LESSON_RE = re.compile(r"(?:lekce|lektion|lekci)[\s_.]*?(\d{1,2})|(\d{1,2})[\s_.]*?(?:lekce|lektion|\.\s*lekce)", re.I)

TOPIC_MAP = [
    (r"silna_slovesa|silná slovesa", "Silná slovesa"),
    (r"predponova", "Předponová slovesa"),
    (r"predlozk|präpositionen|prapositionen", "Předložky"),
    (r"slovesa|verben|konjugation", "Slovesa"),
    (r"adjektiv|deklination|steigerung|eigenschaften", "Přídavná jména"),
    (r"restaurant|speisekarte|stolovani|bratwurst|fast food|mengenangaben", "Restaurace a jídlo"),
    (r"haus|wohnen|wohnung|umfrage", "Bydlení"),
    (r"schul|ausbildung|beruf|arbeitssuche|motivacni", "Škola a práce"),
    (r"familie|geburtstag|namenstag", "Rodina a oslavy"),
    (r"freizeit|hobby|hobbys", "Volný čas"),
    (r"reisen|urlaub|prag|stadtrundgang|sehenswurdigkeiten|osterreich|oesterreich|stadt|lande", "Cestování a města"),
    (r"tagesablauf|uhrzeit|alltag", "Denní režim a čas"),
    (r"konjunktiv|umschreibeform|wurde", "Konjunktiv"),
    (r"passiv|pasiv", "Pasivum"),
    (r"zajmen|pronomen|man und es", "Zájmena"),
    (r"minulych_casu|perfekt|prateritum|präteritum", "Minulé časy"),
    (r"richtungsadverbien|adverb", "Příslovce"),
    (r"wortschatz|slovni_zasoba|slovní zásoba|slovni zasoba|memory|domino|meinung", "Slovní zásoba"),
    (r"gramatika", "Gramatika"),
    (r"procvicovani|opakovani|wiederholung|test", "Procvičování"),
]

B1_HINTS = r"konjunktiv|passiv|pasiv|plusquamperfekt|genitiv|substantivierte|abitur|b1|umschreibeform|reinfall|schulsystem"
A2_HINTS = r"perfekt|prateritum|präteritum|modalverb|steigerung|deklination|silna_slovesa|prapositionen ii|predlozk"


def guess_lesson(name: str):
    m = LESSON_RE.search(name)
    if m:
        try:
            n = int(m.group(1) or m.group(2))
            if 1 <= n <= 20:
                return n
        except (TypeError, ValueError):
            pass
    return None


def guess_level(name: str, lesson):
    n = nfc(name).lower()
    if re.search(B1_HINTS, n):
        return "B1"
    if re.search(A2_HINTS, n):
        return "A2"
    if lesson:
        return "A1" if lesson <= 4 else ("A2" if lesson <= 8 else "B1")
    return "A2"


def guess_topic(name: str):
    n = nfc(name).lower()
    for pat, topic in TOPIC_MAP:
        if re.search(pat, n):
            return topic
    return "Ostatní materiály"


def nice_title(name: str) -> str:
    t = re.sub(r"\.(pdf|docx|xls|ods|mp3)$", "", nfc(name), flags=re.I)
    t = t.replace("_", " ")
    t = re.sub(r"^\d{4}\s(\d+\s)?", "", t)
    t = re.sub(r"\s*\(\d\)$", "", t)
    return re.sub(r"\s{2,}", " ", t).strip()


DOC_HEADING = re.compile(r"^(Lektion\s+\d+\s*:\s*.{3,70}|SSD\s+[IV]+\.?\s*[–-]\s*\d+\.\s*lekce.*)$")


def doc_title(pages, fallback: str) -> str:
    """Prefer the sheet's own heading — it carries the lesson number."""
    for page in pages[:1]:
        for line in page.split("\n")[:4]:
            s = clean_cell(line)
            if DOC_HEADING.match(s):
                return s
    return fallback


def two_col_ratio(pages):
    """Share of content lines that split cleanly into two columns."""
    lines = [l for p in pages for l in p.split("\n") if len(l.strip()) > 3]
    if len(lines) < 8:
        return 0.0
    hits = sum(1 for l in lines if len(split_gaps(l)) == 2)
    return hits / len(lines)


# ---------------------------------------------------------------- grid parsers
def grid_pages(xml: str):
    """[{w, rows: [[cell,...]]}] for POLYGLOT card sheets."""
    if not xml.strip():
        return []
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    body = root.find(f"{XHTML}body")
    doc = body.find(f"{XHTML}doc") if body is not None else None
    if doc is None:
        return []
    out = []
    for pg in doc.findall(f"{XHTML}page"):
        w, h = float(pg.get("width")), float(pg.get("height"))
        cells = []
        for b in pg.iter(f"{XHTML}block"):
            lines = [" ".join((wd.text or "") for wd in ln.iter(f"{XHTML}word"))
                     for ln in b.iter(f"{XHTML}line")]
            txt = clean_cell(" ".join(lines))
            if not txt or BOILERPLATE.match(txt):
                continue
            y0, y1, x0, x1 = (float(b.get("yMin")), float(b.get("yMax")),
                              float(b.get("xMin")), float(b.get("xMax")))
            if y0 < 0.10 * h or y1 > 0.95 * h:      # page furniture only
                continue
            txt = re.sub(r"-\s+(?=[a-zäöüß])", "", txt)   # Dreizimmer- wohnung
            cells.append({"x": (x0 + x1) / 2, "y": (y0 + y1) / 2, "t": txt})
        rows, cur = [], []
        for c in sorted(cells, key=lambda c: c["y"]):
            if cur and c["y"] - cur[-1]["y"] > 45:
                rows.append(cur)
                cur = []
            cur.append(c)
        if cur:
            rows.append(cur)
        merged = []
        for row in rows:
            cols = []
            for c in sorted(row, key=lambda c: (c["x"], c["y"])):
                if cols and abs(c["x"] - cols[-1]["x"]) < 45:
                    prev = cols[-1]
                    parts = sorted([prev, c], key=lambda d: d["y"])       # word above inflection
                    prev["t"] = clean_cell(" ".join(p["t"] for p in parts))
                    prev["x"] = (prev["x"] + c["x"]) / 2
                else:
                    cols.append(dict(c))
            # a row of nothing but orphaned inflection fragments is not a card row
            if cols and all(re.match(r"^\(", c["t"]) for c in cols):
                continue
            merged.append(cols)
        out.append({"w": w, "rows": merged})
    return out


def row_y(row):
    return sum(c["y"] for c in row) / len(row)


def parse_grid_cards(xml: str):
    """German page N pairs with mirrored Czech page N+1."""
    pages = grid_pages(xml)
    pairs = []
    for i in range(0, len(pages) - 1, 2):
        de_rows, cz_rows, W = pages[i]["rows"], pages[i + 1]["rows"], pages[i + 1]["w"]
        if not de_rows or not cz_rows:
            continue
        for cz_row in cz_rows:
            # match rows by grid position, not by ordinal: a dropped or extra row on
            # one side would otherwise shift every remaining pair
            de_row = min(de_rows, key=lambda r: abs(row_y(r) - row_y(cz_row)))
            if abs(row_y(de_row) - row_y(cz_row)) > 45:
                continue
            for cz in cz_row:
                mx = W - cz["x"]
                if not de_row:
                    continue
                best = min(de_row, key=lambda d: abs(d["x"] - mx))
                if abs(best["x"] - mx) > 60:
                    continue
                de = clean_cell(strip_phonetics(fix_stress_digits(best["t"])))
                pairs.append((de, clean_cell(cz["t"])))
    return pairs


def parse_domino(xml: str):
    """Domino tiles: a German cell is followed in reading order by its Czech match."""
    pages = grid_pages(xml)
    flat = []
    for pg in pages:
        for row in pg["rows"]:
            for c in sorted(row, key=lambda c: c["x"]):
                t = clean_cell(strip_phonetics(fix_stress_digits(c["t"])))
                if t and len(t) > 1:
                    flat.append(t)
    pairs = []
    for a, b in zip(flat, flat[1:]):
        if is_germanish(a) and not is_germanish(b) and is_czechish(b):
            if looks_like_pair(a, b):
                pairs.append((a, b))
    return pairs


SPACED_CAPS = re.compile(r"^[A-ZÄÖÜ][A-ZÄÖÜ\s]{3,}$")
NUM_ONLY = re.compile(r"^(\d{1,2})\.$")
NUM_TEXT = re.compile(r"^(\d{1,2})\.\s+(.+)$")


def parse_crossword(pages):
    """Křížovka: numbered Czech clues on one side, spaced-out German answers on the other.
    Answers and their numbers land in separate layout columns, so walk the segments."""
    answers, clues, unsolved = {}, {}, []
    for page in pages:
        for line in page.split("\n"):
            segs = split_gaps(line)
            pending = None
            for seg in segs:
                m = NUM_ONLY.match(seg)
                if m:
                    pending = int(m.group(1))
                    continue
                m = NUM_TEXT.match(seg)
                if m:
                    num, rest = int(m.group(1)), clean_cell(m.group(2))
                    if SPACED_CAPS.match(rest):
                        answers[num] = re.sub(r"\s+", "", rest).capitalize()
                    elif re.match(r"^[a-zá-ž]", rest):     # clue column is Czech by design
                        clues[num] = rest
                    pending = None
                    continue
                if pending is not None:
                    if SPACED_CAPS.match(seg):
                        answers[pending] = re.sub(r"\s+", "", seg).capitalize()
                    elif re.match(r"^[a-zá-ž]", seg):
                        clues[pending] = clean_cell(seg)
                    pending = None
    pairs = [(answers[k], clues[k]) for k in sorted(answers) if k in clues]
    unsolved = [answers[k] for k in sorted(answers) if k not in clues]
    return pairs, unsolved


# ---------------------------------------------------------------- text parsers
def parse_two_col(pages):
    cands = []
    for page in pages:
        for line in page.split("\n"):
            if not line.strip() or BOILERPLATE.match(line.strip()) or DOC_HEADING.match(clean_cell(line)):
                continue
            got = split_biggest_gap(line)
            if got:
                cands.append(got)
    return cands


def parse_multi_col_dash(pages):
    cands = []
    for page in pages:
        for line in page.split("\n"):
            if not line.strip() or BOILERPLATE.match(line.strip()):
                continue
            for seg in split_gaps(line):
                got = dash_split(seg)
                if got:
                    cands.append(got)
    return cands


def parse_dash_lines(pages):
    cands = []
    for page in pages:
        for line in page.split("\n"):
            s = clean_cell(line)
            if not s or BOILERPLATE.match(s) or len(s) > 200:
                continue
            got = dash_split(s)
            if got:
                cands.append(got)
    return cands


def parse_alternating(text):
    """DOCX vocab: German line, Czech line, ... — but a stray heading shifts every
    pair, so try both offsets and keep the better-aligned one."""
    lines = [clean_cell(l) for l in text.split("\n")]
    lines = [l for l in lines if l and not BOILERPLATE.match(l) and not DOC_HEADING.match(l)]

    def aligned(offset):
        cands = list(zip(lines[offset::2], lines[offset + 1::2]))
        score = sum(1 for a, b in cands
                    if is_germanish(a) and has_cz_only(b)) - sum(
                        1 for a, b in cands if has_cz_only(a) and is_germanish(b))
        return score, cands

    best = max((aligned(0), aligned(1)), key=lambda t: abs(t[0]))
    return best[1]


SENT_SPLIT = re.compile(r"^(.{6,140}?[.!?])\s+([^\s].{4,140})$")
# grammar commentary is never a phrase worth memorising
META_TALK = re.compile(
    r"(pád|koncovk|slovosled|tvoří|tvar[ye]?\b|skloň|časuj|stupeň|stupně|přízvuk|"
    r"podstatn|přídavn|zájmen|sloves[oay]|vět[ěayu]\b|předmět|přísudek|podmět|"
    r"množn|jednotn|infinitiv|příčestí|označuje|vyjadřuje|používá|užívá|pozor|"
    r"následuj|viz |např)", re.I)


def _good_sentence_pair(de: str, cz: str) -> bool:
    if not looks_like_pair(de, cz):
        return False
    if not (is_germanish(de) and de_score(de) >= 2):
        return False
    if not (is_czechish(cz) and has_cz_only(cz)):
        return False
    if de_score(cz) >= 3:                       # right side is German too -> not a translation
        return False
    if META_TALK.search(cz) or META_TALK.search(de):
        return False
    if re.match(r"^[-–—•*]|^\d", de) or re.match(r"^[-–—•*]|^\d", cz):
        return False
    dw, cw = len(de.split()), len(cz.split())
    if dw < 3 or cw < 2:
        return False
    if not 0.5 <= dw / cw <= 2.0:                # translations keep similar length
        return False
    if not 0.45 <= len(de) / max(len(cz), 1) <= 2.2:
        return False
    return True


def parse_inline_sentences(pages):
    """'Dort steht eine junge Frau. Tam stojí nějaká mladá žena.' — one line, or
    the same thing split across two layout columns."""
    out = []
    for page in pages:
        for line in page.split("\n"):
            s = clean_cell(line)
            if not s or BOILERPLATE.match(s):
                continue
            cands = []
            cols = split_gaps(line)
            if len(cols) == 2:
                cands.append((cols[0], cols[1]))
                cands.append((cols[1], cols[0]))
            elif len(cols) <= 1:
                m = SENT_SPLIT.match(s)
                if m:
                    cands.append((clean_cell(m.group(1)), clean_cell(m.group(2))))
            for de, cz in cands:
                if _good_sentence_pair(de, cz):
                    out.append((de, cz))
                    break
    return out


def parse_strong_verbs(pages):
    rows, group = [], None
    for page in pages:
        for line in page.split("\n"):
            if not line.strip():
                continue
            bare = clean_cell(line)
            if re.fullmatch(r"[a-zäöü]+\s*[–\-]\s*[a-zäöü]+\s*[–\-]\s*[a-zäöü]+", bare, re.I):
                group = bare.replace("-", "–")
                continue
            cols = split_gaps(line)
            if len(cols) != 4:
                continue
            head, du, prat, perf = cols
            if re.search(r"Infinitiv|os\.|préteritum|perfektum|přít", " ".join(cols), re.I):
                continue
            if not re.match(r"^[a-zäöüß]", head):
                continue
            m = re.match(r"^((?:sich\s+)?[a-zäöüß|]+)\s+(.+)$", head)
            if not m:
                continue
            verb, mean = clean_cell(m.group(1)), clean_cell(m.group(2))
            if verb and mean and not re.match(r"^(du|er|es|sie|ich)\b", mean):
                rows.append({"verb": verb, "mean": mean, "du": du, "prat": prat,
                             "perf": perf, "group": group})
    return rows


def parse_word_list(pages):
    """'1. wohnen' style German-only lists -> bare head words."""
    out = []
    for page in pages:
        for line in page.split("\n"):
            for seg in split_gaps(line):
                m = re.match(r"^\d{1,2}\.?\s+([a-zäöüß][a-zäöüß|]{2,})$", seg)
                if m:
                    out.append(m.group(1))
    return out


# ---------------------------------------------------------------- preposition sheets
CZ_PREP = {
    "z": "aus", "ze": "aus", "u": "bei", "při": "bei", "s": "mit", "se": "mit",
    "do": "nach", "od": "von", "k": "zu", "ke": "zu", "ku": "zu",
    "skrz": "durch", "pro": "für", "proti": "gegen", "bez": "ohne", "v": "um",
    "ve": "um", "za": "um", "lesem": "durch", "domem": "durch", "ulicí": "durch",
}
INSTRUMENTAL = {"lesem", "domem", "ulicí", "jdu"}   # 7. pád, no Czech preposition
DAT_OPTS = ["aus", "bei", "mit", "nach", "von", "zu"]
AKK_OPTS = ["durch", "für", "gegen", "ohne", "um"]
DAT_ART = ["dem", "der", "den", "das"]
AKK_ART = ["den", "die", "das", "dem"]
CHECK_CELL = re.compile(r"^(NE|SPRÁVNĚ|SPRAVNE|CHYBA|ANO|\?)$", re.I)


def cue_prep(cue: str):
    for w in words_of(cue):
        if w in CZ_PREP:
            return CZ_PREP[w]
    return None


NUM_CELL = re.compile(r"^\d{1,2}\.?$")
GERMAN_NOUN = re.compile(r"^[A-ZÄÖÜ][a-zäöüß]{2,}$")
TIME_PHRASE = re.compile(r"^(zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s+Uhr$")
GENDER_FROM_AKK = {"den": "m", "die": "f", "das": "n"}
DAT_BY_GENDER = {"m": "dem", "f": "der", "n": "dem"}


def parse_preposition_sheets(all_sheets):
    """Self-checking preposition drills -> (cue, preposition, article, noun).

    The sheets interleave two tests per row and carry leftovers from data-validation
    lists, so a drill is anchored on the Czech preposition rather than on position.
    """
    gender, drills = {}, []

    for _, is_dativ, sheets in all_sheets:
        arts = set(DAT_ART if is_dativ else AKK_ART)
        preps = set(DAT_OPTS if is_dativ else AKK_OPTS)
        for _, rows in sheets:
            for row in rows:
                # numbering and check cells delimit the individual drills
                chunks, cur = [], []
                for c in [x for x in row if x]:
                    if CHECK_CELL.match(c) or NUM_CELL.match(c):
                        if cur:
                            chunks.append(cur)
                        cur = []
                    else:
                        cur.append(c)
                if cur:
                    chunks.append(cur)

                for ch in chunks:
                    if not 2 <= len(ch) <= 6:
                        continue
                    noun_idx = None
                    for i, c in enumerate(ch):
                        if GERMAN_NOUN.match(c) or TIME_PHRASE.match(c):
                            noun_idx = i
                    if noun_idx is None:
                        continue
                    noun, left = ch[noun_idx], ch[:noun_idx]

                    cue, prep = None, None
                    for i, c in enumerate(left):
                        w = words_of(c)
                        if not w or w[0] not in CZ_PREP:
                            continue
                        if len(w) > 1 or w[0] in INSTRUMENTAL:
                            cue = c          # 'jdu lesem', 'za rohem', 'lesem'
                        elif i + 1 < len(left) and words_of(left[i + 1])[:1] and \
                                words_of(left[i + 1])[0] not in CZ_PREP:
                            cue = clean_cell(f"{c} {left[i + 1]}")   # 'ze' + 'skříně'
                        else:
                            cue = c
                        prep = CZ_PREP[w[0]]
                        break
                    if not cue or len(cue.split()) > 4:
                        continue
                    for c in left:
                        if c.lower() in preps:
                            prep = c.lower()
                    art = next((c.lower() for c in left if c.lower() in arts), None)

                    if art and not is_dativ and art in GENDER_FROM_AKK:
                        gender.setdefault(noun, GENDER_FROM_AKK[art])
                    elif art == "der" and is_dativ:
                        gender.setdefault(noun, "f")
                    drills.append({"cue": cue, "prep": prep, "art": art, "noun": noun,
                                   "dativ": is_dativ})

    # a Dativ sheet leaves the article blank; derive it from the gender we learned
    for d in drills:
        if not d["art"]:
            g = gender.get(d["noun"])
            if g and d["dativ"]:
                d["art"] = DAT_BY_GENDER[g]
            elif g:
                d["art"] = {"m": "den", "f": "die", "n": "das"}[g]

    seen, out = set(), []
    for d in drills:
        k = (d["cue"].lower(), d["prep"], d["art"], d["noun"], d["dativ"])
        if k in seen:
            continue
        seen.add(k)
        out.append(d)
    return out


# ---------------------------------------------------------------- item builders
def vocab_items(pairs, meta):
    """(de, cz) pairs -> cards + typing + fill-ins; full sentences -> conversations."""
    cards, typings, fillins, convs = [], [], [], []
    words = [(de, cz) for de, cz in pairs if not is_sentence(de)]
    sents = [(de, cz) for de, cz in pairs if is_sentence(de)]
    pool = [normalize_headword(de)[0] for de, _ in words]

    for de, cz in words:
        head, note = normalize_headword(de)
        base = {"level": meta["level"], "tag": meta["topic"], "source": meta["title"],
                "sourceId": meta["id"]}
        cards.append({**base, "front": head, "back": cz, **({"note": note} if note else {})})
        ans = typing_answer(head)
        if len(ans) <= 60:
            typings.append({**base, "prompt": f"Přelož do němčiny: „{cz}“", "answer": ans})
        if len(pool) >= 4:
            others = [w for w in pool if w != head]
            RNG.shuffle(others)
            opts = [head] + others[:3]
            if len(opts) == 4:
                RNG.shuffle(opts)
                fillins.append({**base, "sentence": f"„{cz}“ = ___", "answer": head, "options": opts})

    for de, cz in sents:
        convs.append({"level": meta["level"], "tag": meta["topic"], "de": de, "cz": cz,
                      "source": meta["title"], "sourceId": meta["id"]})
    return cards, typings, fillins, convs


def strong_verb_items(rows, meta):
    cards, typings = [], []
    for r in rows:
        tag = f"Silná slovesa {r['group']}" if r["group"] else "Silná slovesa"
        base = {"level": meta["level"], "tag": tag, "source": meta["title"], "sourceId": meta["id"]}
        cards.append({**base, "front": f"{r['verb']} — {r['mean']}",
                      "back": f"{r['du']} · {r['prat']} · {r['perf']}"})
        typings.append({**base, "prompt": f"Perfektum: {r['verb']} ({r['mean']})", "answer": r["perf"]})
        typings.append({**base, "prompt": f"Préteritum, 3. os. j. č.: {r['verb']} ({r['mean']})",
                        "answer": r["prat"]})
        typings.append({**base, "prompt": f"2. os. j. č. přít. času: {r['verb']} ({r['mean']})",
                        "answer": r["du"]})
    return cards, typings


def preposition_items(drills, meta_by_case):
    cards, fillins, typings = [], [], []
    for d in drills:
        is_dativ = d["dativ"]
        meta = meta_by_case[is_dativ]
        case = "3. pád (Dativ)" if is_dativ else "4. pád (Akkusativ)"
        opts_all = DAT_OPTS if is_dativ else AKK_OPTS
        arts_all = DAT_ART if is_dativ else AKK_ART
        base = {"level": meta["level"], "tag": f"Předložky — {case}", "source": meta["title"],
                "sourceId": meta["id"]}
        target = " ".join(x for x in [d["art"], d["noun"]] if x)
        opts = [d["prep"]] + [o for o in opts_all if o != d["prep"]][:3]
        RNG.shuffle(opts)
        fillins.append({**base, "sentence": f"{d['cue']} — ___ {target}", "answer": d["prep"],
                        "options": opts})
        typings.append({**base, "prompt": f"Doplň předložku: {d['cue']} — ___ {target}",
                        "answer": d["prep"]})
        if d["art"]:
            aopts = [d["art"]] + [a for a in arts_all if a != d["art"]][:3]
            RNG.shuffle(aopts)
            fillins.append({**base, "tag": f"Členy — {case}",
                            "sentence": f"{d['cue']} — {d['prep']} ___ {d['noun']}",
                            "answer": d["art"], "options": aopts})
        cards.append({**base, "front": f"{d['cue']} (německy)", "back": f"{d['prep']} {target}".strip()})
    return cards, fillins, typings


# ---------------------------------------------------------------- main
def main():
    WORK.mkdir(exist_ok=True)
    if PUB.exists():
        shutil.rmtree(PUB)
    (PUB / "img").mkdir(parents=True)

    sources = gather_sources()
    materials, cards, fillins, typings, conversations = [], [], [], [], []
    by_hash, prep_sheets, word_lists, trusted = {}, [], [], {}
    stats = {"vocabPairs": 0, "sentences": 0, "strongVerbs": 0, "prepDrills": 0, "crossword": 0}
    glossary = {}

    for name, path, origin in sources:
        ext = path.suffix.lower()
        n = nfc(name).lower()
        raw_pages, text, sheets, images = [], "", [], []

        if ext == ".pdf":
            raw_pages = pdf_pages(path)
            text = "\n".join(raw_pages)
        elif ext == ".docx":
            text = docx_text(path)
            raw_pages = [text]
        elif ext in (".xls", ".ods"):
            sheets = sheet_rows(path)
            text = "\n".join(" | ".join(c for c in row if c)
                             for _, rows in sheets for row in rows if any(row))
            raw_pages = [text]

        digest = hashlib.sha1((text or path.name).encode("utf-8")).hexdigest()[:12]
        if digest in by_hash and ext != ".mp3":
            by_hash[digest]["aliases"].append(name)
            shutil.copy2(path, PUB / slugify(name))
            continue

        mid = f"m{len(materials):03d}"
        lesson = guess_lesson(name)
        level = guess_level(name, lesson)
        topic = guess_topic(name)
        title = doc_title(raw_pages, nice_title(name)) if raw_pages else nice_title(name)
        if any(m["title"] == title for m in materials):
            title = f"{title} — {nice_title(name)}"
        pub_name = slugify(name)
        shutil.copy2(path, PUB / pub_name)
        meta = {"id": mid, "title": title, "level": level, "topic": topic}
        has_text = len(re.sub(r"\s", "", text)) > 40
        note = ""

        if ext == ".pdf" and not has_text:
            stem = slugify(Path(name).stem)
            subprocess.run(["pdftoppm", "-r", "150", "-png", str(path), str(PUB / "img" / stem)],
                           capture_output=True, timeout=300)
            images = sorted(f"materialy/img/{p.name}" for p in (PUB / "img").glob(f"{stem}-*.png"))
            note = "Skenovaný list bez textové vrstvy — zobrazen jako obrázky stránek."

        before = (len(cards), len(fillins), len(typings), len(conversations))
        vocab_pairs, handled_table = [], False

        if has_text and ext in (".xls", ".ods"):
            is_dativ = bool(re.search(r"3\._?\s?pad", n))
            prep_sheets.append((title, is_dativ, sheets, meta))
            handled_table = True

        elif has_text and "silna_slovesa" in n:
            rows = parse_strong_verbs(raw_pages)
            stats["strongVerbs"] += len(rows)
            c, t = strong_verb_items(rows, meta)
            cards += c
            typings += t
            handled_table = True

        elif has_text and re.search(r"wortschatz \(deutsch-tschechisch\)|_520_|_519_", n):
            # duplex flashcard sheet: German page, mirrored Czech page
            vocab_pairs = parse_grid_cards(pdf_bbox(path))
            handled_table = True

        elif has_text and re.search(r"memory-spiel|domino", n):
            # game sheets: the tiles are deliberately shuffled, so which German cell
            # belongs to which Czech cell cannot be recovered from the layout
            note = ("Hra (pexeso/domino) — kartičky jsou na listu zamíchané, takže páry "
                    "nelze automaticky spárovat. Slovíčka najdeš v materiálu i v originálu.")
            handled_table = True

        elif has_text and re.search(r"wortschatz 12\. lektion \(substantive\)", n):
            pairs, unsolved = parse_crossword(raw_pages)
            stats["crossword"] += len(pairs)
            vocab_pairs = pairs
            if unsolved:
                word_lists.append(([u.lower() for u in unsolved], meta))
            handled_table = True

        elif has_text and ext == ".docx":
            vocab_pairs = parse_alternating(text)
            handled_table = True

        elif has_text and not any(re.search(p, n) for p in VOCAB_DENY):
            ratio = two_col_ratio(raw_pages)
            exercise_sheet = bool(re.search(
                r"procvicovani|opakovani|haus-1|wiederholung|klic|klíč|reseni|řešení|"
                r"arbeitsblatt|umfrage|domino|memory", n))
            if re.search(r"predponova", n):
                vocab_pairs = parse_multi_col_dash(raw_pages)
                handled_table = True
            elif exercise_sheet:
                pass                                 # worksheet, not a bilingual list
            elif ratio >= 0.45:                      # a real two-column vocabulary list
                vocab_pairs = parse_two_col(raw_pages)
                handled_table = True
            elif re.search(r"slovni.zasoba|slovní zásoba|wortschatz", n):
                vocab_pairs = parse_dash_lines(raw_pages)
                handled_table = True

        vocab_pairs = finalize_pairs(vocab_pairs)
        if vocab_pairs:
            junk = sum(1 for de, cz in vocab_pairs
                       if len(de) <= 3 or len(cz) <= 3 or not plausible_word(de))
            if junk / len(vocab_pairs) > 0.3:        # word-art / broken text layer
                note = (note + " Text tohoto listu nelze spolehlivě rozparsovat — "
                        "je dostupný jako materiál a originál.").strip()
                vocab_pairs = []

        if vocab_pairs:
            stats["vocabPairs"] += len(vocab_pairs)
            c, t, f, v = vocab_items(vocab_pairs, meta)
            cards += c
            typings += t
            fillins += f
            conversations += v
            trusted_src = bool(re.search(r"slovní zásoba|slovni.zasoba|predponova", n)) or ext == ".docx"
            for de, cz in vocab_pairs:
                head = normalize_headword(de)[0]
                glossary.setdefault(typing_answer(head).lower(), (head, cz, title))
                if trusted_src:
                    trusted.setdefault(typing_answer(head).lower(), (cz, title))

        # prose materials also give up their inline translation pairs
        if has_text and not handled_table:
            sents = dedupe_pairs(parse_inline_sentences(raw_pages))
            stats["sentences"] += len(sents)
            for de, cz in sents:
                conversations.append({"level": level, "tag": topic, "de": de, "cz": cz,
                                      "source": title, "sourceId": mid})

        # German-only verb/word lists: resolve against the corpus glossary later
        if has_text:
            wl = parse_word_list(raw_pages)
            if len(wl) >= 5 and not vocab_pairs:
                word_lists.append((wl, meta))

        after = (len(cards), len(fillins), len(typings), len(conversations))
        mat = {
            "id": mid, "file": name, "title": title, "kind": ext.lstrip("."),
            "topic": topic, "level": level, "lesson": lesson, "origin": origin,
            "src": f"materialy/{pub_name}", "aliases": [], "note": note,
            "pages": [p.rstrip() for p in raw_pages] if raw_pages else [],
            "images": images, "scanned": bool(images),
            "sheets": [{"name": sn, "rows": [r for r in rows if any(r)]} for sn, rows in sheets],
            "derived": {"cards": after[0] - before[0], "fillIns": after[1] - before[1],
                        "typing": after[2] - before[2], "conversations": after[3] - before[3]},
        }
        materials.append(mat)
        by_hash[digest] = mat

    # ---- preposition drills (all workbooks together, so answers can be shared) ----
    if prep_sheets:
        drills = parse_preposition_sheets([(t, d, s) for t, d, s, _ in prep_sheets])
        stats["prepDrills"] = len(drills)
        meta_by_case = {}
        for title, is_dativ, _, meta in prep_sheets:
            meta_by_case.setdefault(is_dativ, meta)
        c, f, t = preposition_items(drills, meta_by_case)
        cards += c
        fillins += f
        typings += t
        for m in materials:
            if m["kind"] in ("xls", "ods"):
                m["derived"]["cards"] = m["derived"]["fillIns"] = m["derived"]["typing"] = "—"
                m["note"] = ("Cvičení z tohoto souboru jsou spojena se zbytkem sady "
                             "„trénink předložek“.")

    # ---- German-only word lists resolved through the corpus glossary ----
    resolved = 0
    for wl, meta in word_lists:
        for w in wl:
            hit = glossary.get(w.lower())
            if not hit:
                continue
            head, cz, src = hit
            cards.append({"level": meta["level"], "tag": meta["topic"], "front": head, "back": cz,
                          "source": meta["title"], "sourceId": meta["id"],
                          "note": f"význam doplněn z: {src}"})
            resolved += 1
    stats["wordListResolved"] = resolved

    # ---- hand transcription of the scanned sheets (no text layer, no OCR here) ----
    if MANUAL.exists():
        man = json.loads(MANUAL.read_text(encoding="utf-8"))
        by_file = {m["file"]: m for m in materials}

        def attach(items):
            out = []
            for it in items:
                it = dict(it)
                mat = by_file.get(it.pop("sourceFile", None) or "")
                it.setdefault("source", mat["title"] if mat else "Ručně přepsané listy")
                it.setdefault("sourceId", mat["id"] if mat else None)
                if mat:
                    mat["derived"]["cards"] = mat["derived"].get("cards", 0)
                out.append(it)
            return out

        m_cards, m_fill = attach(man.get("cards", [])), attach(man.get("fillIns", []))
        m_typ, m_conv = attach(man.get("typing", [])), attach(man.get("conversations", []))
        cards += m_cards
        fillins += m_fill
        typings += m_typ
        conversations += m_conv
        stats["manual"] = len(m_cards) + len(m_fill) + len(m_typ) + len(m_conv)
        for it in m_cards:                      # scanned vocab also drills as typing
            if it.get("sourceId") and len(it["front"]) <= 45 and "?" not in it["front"]:
                typings.append({**{k: v for k, v in it.items() if k != "front"},
                                "prompt": f"Přelož do němčiny: „{it['back']}“",
                                "answer": it["front"]})
        for m in materials:
            if m.get("scanned"):
                n_items = sum(1 for it in m_cards + m_fill + m_typ + m_conv
                              if it.get("sourceId") == m["id"])
                m["derived"] = {"cards": n_items, "fillIns": 0, "typing": 0, "conversations": 0}
                m["note"] = (m.get("note", "") + " Obsah byl přepsán ručně, cvičení z něj "
                             "najdeš v ostatních kartách.").strip()

    def finish(items, prefix, keyf):
        seen, out = set(), []
        for it in items:
            k = keyf(it)
            if k in seen:
                continue
            seen.add(k)
            out.append({"id": f"{prefix}{len(out)}", **it, "box": 0, "due": None, "reps": 0})
        return out

    cards = finish(cards, "c", lambda i: (i["front"].lower(), i["back"].lower()))
    fillins = finish(fillins, "f", lambda i: (i["sentence"].lower(), i["answer"].lower()))
    typings = finish(typings, "t", lambda i: (i["prompt"].lower(), i["answer"].lower()))
    conversations = finish(conversations, "v", lambda i: (i["de"].lower(), i["cz"].lower()))

    # ---- sanity net: flag cards that contradict a trusted vocabulary list ----
    conflicts = []
    for c in cards:
        t = trusted.get(typing_answer(c["front"]).lower())
        if not t:
            continue
        mine = set(words_of(c["back"]))
        theirs = set(words_of(t[0]))
        if mine and theirs and not (mine & theirs):
            conflicts.append({"front": c["front"], "got": c["back"], "trusted": t[0],
                              "source": c["source"], "trustedSource": t[1]})
    stats["conflicts"] = len(conflicts)
    (ROOT / "build" / "conflicts.json").write_text(
        json.dumps(conflicts, ensure_ascii=False, indent=1), encoding="utf-8")

    # ---- link worksheets with their answer keys ----
    def key_base(t):
        return re.sub(r"\s*[-–]?\s*(klic|klíč|reseni|řešení|resenicelek|celek)\s*$", "",
                      t.lower().replace("-", " ")).strip()
    by_base = {}
    for m in materials:
        by_base.setdefault(key_base(m["title"]), []).append(m)
    for group in by_base.values():
        keys = [m for m in group if re.search(r"klic|klíč|reseni|řešení", m["title"], re.I)]
        tasks = [m for m in group if m not in keys]
        for t in tasks:
            for k in keys:
                t["answerKey"] = k["id"]
                k["answerFor"] = t["id"]

    seed = {
        "generatedFrom": str(SRC),
        "stats": {**stats, "materials": len(materials), "cards": len(cards),
                  "fillIns": len(fillins), "typing": len(typings),
                  "conversations": len(conversations)},
        "materials": materials, "cards": cards, "fillIns": fillins,
        "typing": typings, "conversations": conversations,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(seed, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(seed["stats"], ensure_ascii=False, indent=1))
    print("wrote", OUT, f"{OUT.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
