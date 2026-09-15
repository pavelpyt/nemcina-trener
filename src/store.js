import seed from "./data/seed.json";
import { PERSONAL } from "./data/personal.js";

// Content is static (generated from ~/Desktop/Nemcina); only progress is persisted,
// so localStorage holds a few kB instead of a 1.5 MB copy of the corpus.
export const DATA = {
  cards: [...PERSONAL.cards, ...seed.cards],
  fillIns: [...PERSONAL.fillIns, ...seed.fillIns],
  typing: [...PERSONAL.typing, ...seed.typing],
  conversations: [...PERSONAL.conversations, ...seed.conversations],
  materials: seed.materials,
  stats: seed.stats,
  generatedFrom: seed.generatedFrom,
};

export const KINDS = [
  { key: "cards", label: "Kartičky", title: "Kartičky", itemLabel: "karet" },
  { key: "fillIns", label: "Výběr", title: "Výběr z možností", itemLabel: "cvičení" },
  { key: "typing", label: "Psaní", title: "Psací cvičení", itemLabel: "cvičení" },
  { key: "conversations", label: "Konverzace", title: "Konverzace — fráze k tématům", itemLabel: "frází" },
];

export const LEVEL_ORDER = ["B1", "A2", "A1"];
export const BOX_INTERVALS = [0, 1, 2, 4, 7, 14, 30];
const KEY = "de-trainer-v4";

export function nextDue(box) {
  const d = new Date();
  d.setDate(d.getDate() + BOX_INTERVALS[Math.min(box, BOX_INTERVALS.length - 1)]);
  return d.toISOString();
}

export const emptyProgress = { box: 0, due: null, reps: 0 };
export const isMastered = (p) => (p?.box ?? 0) >= 4;
export const isDue = (p) => !p?.due || new Date(p.due) <= new Date();

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { progress: {}, notes: "", theme: "light", ...JSON.parse(raw) };
  } catch (e) {
    console.warn("Nepodařilo se načíst uložený pokrok:", e);
  }
  return { progress: {}, notes: "", theme: "light" };
}

let timer = null;
export function saveState(state) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.error("Ukládání selhalo:", e);
    }
  }, 250);
}

export const fold = (s) =>
  (s || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

const CZ_ONLY = /[ěščřžýáíéůúťďňó]/i;
const tidy = (s) => (s || "").toLowerCase().trim().replace(/\s+/g, " ")
  .replace(/[.!?,;:]+$/g, "").replace(/[„“"']/g, "");

/** German umlauts may be typed as ae/oe/ue and ß as ss, but must not be dropped. */
const canonDe = (s) => tidy(s).replace(/ß/g, "ss").replace(/ä/g, "ae")
  .replace(/ö/g, "oe").replace(/ü/g, "ue");
const canonCz = (s) => fold(tidy(s));
const dropArticle = (s) => s.replace(/^(der|die|das|den|dem|des)\s+/, "");

/**
 * Compare a typed answer with the expected one.
 * Returns { ok, hint } — `hint: "article"` marks a near miss where only the
 * article differs, which is worth pointing out rather than silently accepting.
 */
export function checkAnswer(input, expected) {
  if (!tidy(input)) return { ok: false };
  const canon = CZ_ONLY.test(expected) ? canonCz : canonDe;
  const variants = expected.split(/\s*[/;]\s*|\s+nebo\s+/).map(canon).filter(Boolean);
  const mine = canon(input);
  if (variants.includes(mine) || canon(expected) === mine) return { ok: true };
  if (variants.some((v) => dropArticle(v) === dropArticle(mine))) return { ok: false, hint: "article" };
  return { ok: false };
}

/** Searchable text of an item, for the filter box. */
export function itemText(it) {
  return fold([it.front, it.back, it.prompt, it.answer, it.sentence, it.de, it.cz, it.tag,
    it.source, it.note, ...(it.options || [])].filter(Boolean).join(" "));
}

export function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "cs"));
}
