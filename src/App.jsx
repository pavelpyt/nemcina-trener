import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  DATA, KINDS, LEVEL_ORDER, checkAnswer, emptyProgress, fold, isDue, isMastered,
  itemText, loadState, nextDue, saveState, uniqueSorted,
} from "./store.js";

const UI_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO_FONT = "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, monospace";
const PAGE = 40;

function makeTheme(theme) {
  const dark = theme === "dark";
  return {
    dark,
    bg: dark ? "#0d0d0d" : "#ffffff",
    panel: dark ? "#171717" : "#fbfbfb",
    mono: dark ? "#1a1a1a" : "#f5f5f5",
    border: dark ? "#333333" : "#d9d9d9",
    text: dark ? "#e8e8e8" : "#1a1a1a",
    muted: dark ? "#8f8f8f" : "#6b6b6b",
    good: dark ? "#4ade80" : "#15803d",
    bad: dark ? "#f87171" : "#b91c1c",
    fill: dark ? "#e8e8e8" : "#1a1a1a",
    fillText: dark ? "#0d0d0d" : "#ffffff",
    accent: dark ? "#8ba4ff" : "#3b51c9",
    shadow: dark ? "0 8px 24px rgba(0,0,0,.5)" : "0 8px 24px rgba(20,24,60,.12)",
  };
}

export default function App() {
  const [state, setState] = useState(() => loadState());
  const [tab, setTab] = useState("cards");
  const T = makeTheme(state.theme);

  useEffect(() => { saveState(state); }, [state]);
  useEffect(() => { document.body.style.background = T.bg; }, [T.bg]);

  const setProgress = useCallback((id, patch) => {
    setState((s) => ({
      ...s,
      progress: { ...s.progress, [id]: { ...emptyProgress, ...s.progress[id], ...patch } },
    }));
  }, []);
  const resetKind = useCallback((ids) => {
    setState((s) => {
      const progress = { ...s.progress };
      ids.forEach((id) => delete progress[id]);
      return { ...s, progress };
    });
  }, []);
  const toggleTheme = () => setState((s) => ({ ...s, theme: s.theme === "dark" ? "light" : "dark" }));

  const kind = KINDS.find((k) => k.key === tab);

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: UI_FONT, fontSize: 14 }}>
      <div style={{
        borderBottom: `1px solid ${T.border}`, padding: "10px 20px", display: "flex",
        justifyContent: "space-between", alignItems: "center", gap: 10, position: "sticky",
        top: 0, background: T.bg, zIndex: 20, flexWrap: "wrap",
      }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {[...KINDS.map((k) => [k.key, k.label]), ["materials", "Materiály"], ["notes", "Poznámky"]]
            .map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} style={{
                border: "none", background: tab === k ? T.fill : "transparent",
                color: tab === k ? T.fillText : T.muted, borderRadius: 5, padding: "6px 11px",
                fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: UI_FONT,
              }}>{l}</button>
            ))}
        </div>
        <button onClick={toggleTheme} style={{
          border: `1px solid ${T.border}`, background: "transparent", color: T.muted,
          borderRadius: 5, padding: "5px 10px", fontSize: 11, fontWeight: 600,
          cursor: "pointer", fontFamily: UI_FONT,
        }}>{T.dark ? "☀ Light" : "☾ Dark"}</button>
      </div>

      {kind && (
        <Worklist key={tab} T={T} kind={kind} progress={state.progress}
                  setProgress={setProgress} resetKind={resetKind} />
      )}
      {tab === "materials" && <Materials T={T} />}
      {tab === "notes" && (
        <Notes T={T} notes={state.notes}
               save={(notes) => setState((s) => ({ ...s, notes }))} />
      )}
    </div>
  );
}

/* ------------------------------------------------ shared bits ------------------ */
function Label({ T, children }) {
  return <div style={{ fontSize: 10.5, fontWeight: 700, color: T.muted, letterSpacing: 0.4, marginBottom: 6 }}>{children}</div>;
}
function MonoPanel({ T, children, style }) {
  return <div style={{
    background: T.mono, border: `1px solid ${T.border}`, borderRadius: 5, padding: 12,
    fontFamily: MONO_FONT, fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap",
    wordBreak: "break-word", ...style,
  }}>{children}</div>;
}
function Btn({ T, children, onClick, tone, style, disabled, title }) {
  const c = tone === "good" ? T.good : tone === "bad" ? T.bad : T.border;
  return (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      border: `1px solid ${c}`, background: tone === "solid" ? T.fill : "transparent",
      color: tone === "solid" ? T.fillText : tone === "good" ? T.good : tone === "bad" ? T.bad : T.text,
      borderRadius: 4, padding: "5px 10px", fontSize: 11.5, fontWeight: 600,
      cursor: disabled ? "default" : "pointer", fontFamily: UI_FONT, opacity: disabled ? 0.5 : 1, ...style,
    }}>{children}</button>
  );
}
function Select({ T, value, onChange, options, allLabel }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{
      background: T.panel, color: T.text, border: `1px solid ${T.border}`, borderRadius: 4,
      padding: "4px 6px", fontSize: 11.5, fontFamily: UI_FONT, maxWidth: 240,
    }}>
      <option value="">{allLabel}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

/* ------------------------------------------------ worklist --------------------- */
/** Kinds that have a plain front/back and can therefore run in the flip-card deck. */
const FACES = {
  cards: { front: (i) => i.front, back: (i) => i.back, frontLabel: "NĚMECKY", backLabel: "ČESKY" },
  conversations: { front: (i) => i.de, back: (i) => i.cz, frontLabel: "NĚMECKY", backLabel: "PŘEKLAD" },
};

/** Move items the user got wrong to the end of the batch, in the order they failed. */
function sinkDeferred(items, deferred) {
  if (deferred.length === 0) return items;
  const rank = (i) => deferred.indexOf(i.id);
  const head = items.filter((i) => rank(i) === -1);
  const tail = items.filter((i) => rank(i) !== -1).sort((a, b) => rank(a) - rank(b));
  return tail.length === 0 ? items : [...head, ...tail];
}

function Worklist({ T, kind, progress, setProgress, resetKind }) {
  const all = DATA[kind.key];
  const faces = FACES[kind.key];
  const [view, setView] = useState(faces ? "study" : "list");
  const [level, setLevel] = useState("");
  const [topic, setTopic] = useState("");
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");
  // Psaní jede jako fronta: správně zodpovězené cvičení zmizí, chybné jde na konec.
  const [hideDone, setHideDone] = useState(kind.key === "typing");
  const [onlyDue, setOnlyDue] = useState(false);
  const [limits, setLimits] = useState({});
  const [deferred, setDeferred] = useState([]);
  // Ve studijním režimu má být vidět hlavně karta, ne formulář s filtry.
  const [filtersOpen, setFiltersOpen] = useState(false);

  const defer = useCallback((id) => setDeferred((d) => [...d.filter((x) => x !== id), id]), []);

  // Kurzor sám skočí do dalšího nevyplněného políčka — zodpovězená mají readonly input.
  // Musí to proběhnout až po překreslení (jinak scrollujeme na starou pozici), proto efekt.
  const listRef = useRef(null);
  const focusScroll = useRef(false);
  const [focusTick, setFocusTick] = useState(0);
  const focusNext = useCallback((scroll = true) => {
    focusScroll.current = scroll;
    setFocusTick((n) => n + 1);
  }, []);
  useEffect(() => {
    const el = listRef.current?.querySelector("input[data-answer]:not([readonly])");
    if (!el) return;
    el.focus({ preventScroll: true });
    // Scrollujeme celé cvičení, ne jen input — jinak zadání zůstane nad okrajem.
    if (focusScroll.current) (el.closest("[data-ticket]") || el).scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusTick]);

  const topics = useMemo(() => uniqueSorted(all.map((i) => i.tag)), [all]);
  const sources = useMemo(() => uniqueSorted(all.map((i) => i.source)), [all]);

  const filtered = useMemo(() => {
    const q = fold(query.trim());
    return all.filter((i) => {
      if (level && i.level !== level) return false;
      if (topic && i.tag !== topic) return false;
      if (source && i.source !== source) return false;
      const p = progress[i.id];
      if (hideDone && isMastered(p)) return false;
      if (onlyDue && !isDue(p)) return false;
      if (q && !itemText(i).includes(q)) return false;
      return true;
    });
  }, [all, level, topic, source, query, hideDone, onlyDue, progress]);

  const groups = useMemo(() => LEVEL_ORDER
    .map((lvl) => ({ level: lvl, items: filtered.filter((i) => i.level === lvl) }))
    .filter((g) => g.items.length > 0), [filtered]);

  const doneCount = all.filter((i) => isMastered(progress[i.id])).length;
  const dueCount = filtered.filter((i) => isDue(progress[i.id]) && !isMastered(progress[i.id])).length;
  const activeFilters = [level, topic, source, query.trim(), hideDone, onlyDue].filter(Boolean).length;
  const Ticket = { cards: CardTicket, fillIns: FillInTicket, typing: TypingTicket, conversations: ConversationTicket }[kind.key];

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 20px 80px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 4px" }}>{kind.title}</h1>
        {faces && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Btn T={T} tone={filtersOpen || activeFilters ? "solid" : undefined}
                 onClick={() => setFiltersOpen((o) => !o)}>
              Filtry{activeFilters ? ` (${activeFilters})` : ""}
            </Btn>
            <div style={{ display: "flex", gap: 2, border: `1px solid ${T.border}`, borderRadius: 6, padding: 2 }}>
              {[["study", "Učení"], ["list", "Seznam"]].map(([v, l]) => (
                <button key={v} onClick={() => setView(v)} style={{
                  border: "none", background: view === v ? T.fill : "transparent",
                  color: view === v ? T.fillText : T.muted, borderRadius: 4, padding: "4px 12px",
                  fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: UI_FONT,
                }}>{l}</button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div style={{ color: T.muted, fontSize: 12, marginBottom: 14 }}>
        {all.length} {kind.itemLabel} celkem · {doneCount} zvládnuto · zobrazeno {filtered.length}
        {dueCount > 0 && ` · ${dueCount} k opakování`}
      </div>

      <div style={{
        border: `1px solid ${T.border}`, borderRadius: 6, padding: 12, marginBottom: 16, gap: 10,
        display: !faces || view === "list" || filtersOpen ? "grid" : "none",
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: T.muted }}>ÚROVEŇ</span>
          {["", ...LEVEL_ORDER].map((l) => (
            <button key={l || "all"} onClick={() => setLevel(l)} style={{
              border: `1px solid ${level === l ? T.text : T.border}`,
              background: level === l ? T.fill : "transparent",
              color: level === l ? T.fillText : T.text, borderRadius: 4, padding: "3px 9px",
              fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: UI_FONT,
            }}>{l || "vše"}</button>
          ))}
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="hledat…"
                 style={{
                   flex: 1, minWidth: 130, padding: "5px 8px", borderRadius: 4,
                   border: `1px solid ${T.border}`, background: T.mono, color: T.text,
                   fontFamily: UI_FONT, fontSize: 12,
                 }} />
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Select T={T} value={topic} onChange={setTopic} options={topics} allLabel="všechna témata" />
          <Select T={T} value={source} onChange={setSource} options={sources} allLabel="všechny zdroje" />
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
            skrýt zvládnuté
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={onlyDue} onChange={(e) => setOnlyDue(e.target.checked)} />
            jen k opakování
          </label>
          <Btn T={T} onClick={() => { setLevel(""); setTopic(""); setSource(""); setQuery(""); setHideDone(false); setOnlyDue(false); }}>
            Zrušit filtry
          </Btn>
          <Btn T={T} onClick={() => { if (confirm(`Vynulovat pokrok v „${kind.label}“?`)) resetKind(all.map((i) => i.id)); }}>
            Reset pokroku
          </Btn>
        </div>
      </div>

      {faces && view === "study" && (
        <StudyDeck T={T} faces={faces} items={filtered} progress={progress} setProgress={setProgress}
                   deckKey={`${level}|${topic}|${source}|${query}|${hideDone}|${onlyDue}`} />
      )}

      {(!faces || view === "list") && groups.length === 0 && (
        <div style={{ color: T.muted, fontSize: 13, fontStyle: "italic" }}>
          Nic neodpovídá filtru.
        </div>
      )}

      <div ref={listRef}>
      {(!faces || view === "list") && groups.map((g) => {
        const limit = limits[g.level] || PAGE;
        // Chybně zodpovězená cvičení klesají na konec právě zobrazené dávky.
        const visible = sinkDeferred(g.items.slice(0, limit), deferred);
        return (
          <div key={g.level} style={{ marginBottom: 26 }}>
            <div style={{
              fontSize: 15, fontWeight: 700, borderBottom: `1px solid ${T.border}`,
              paddingBottom: 6, marginBottom: 12, position: "sticky", top: 47,
              background: T.bg, zIndex: 5,
            }}>
              {g.level} <span style={{ fontWeight: 400, color: T.muted }}>({g.items.length})</span>
            </div>
            {visible.map((item, i) => (
              <Ticket key={item.id} T={T} item={item} index={i + 1} onDefer={defer} onAdvance={focusNext}
                      p={progress[item.id] || emptyProgress} setProgress={setProgress} />
            ))}
            {g.items.length > limit && (
              <Btn T={T} tone="solid" style={{ width: "100%", padding: "8px 0" }}
                   onClick={() => setLimits((l) => ({ ...l, [g.level]: limit + PAGE }))}>
                Zobrazit dalších {Math.min(PAGE, g.items.length - limit)} z {g.items.length - limit}
              </Btn>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}

/* ------------------------------------------------ study deck ------------------- */
const shuffleList = (list) => {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Read the German side out loud — the browser's own voice, no network. */
function speak(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "de-DE";
  u.rate = 0.9;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

function CardFace({ T, label, text, hint, onSpeak, style }) {
  return (
    <div style={{
      position: "absolute", inset: 0, backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden",
      display: "flex", flexDirection: "column", padding: "14px 16px 16px",
      borderRadius: 14, border: `1px solid ${T.border}`, background: T.panel,
      boxShadow: T.shadow, overflow: "hidden", ...style,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: T.muted, letterSpacing: 0.4 }}>{label}</span>
        {onSpeak && (
          <button onClick={(e) => { e.stopPropagation(); onSpeak(); }} title="Přehrát výslovnost"
                  style={{
                    border: `1px solid ${T.border}`, background: "transparent", color: T.muted,
                    borderRadius: 20, width: 28, height: 28, fontSize: 13, cursor: "pointer",
                    lineHeight: 1, fontFamily: UI_FONT,
                  }}>♪</button>
        )}
      </div>
      <div style={{
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
        overflow: "auto", padding: "6px 4px",
      }}>
        <div style={{
          fontSize: text.length > 90 ? "clamp(15px, 2.4vw, 19px)" : "clamp(20px, 3.4vw, 30px)",
          fontWeight: 600, textAlign: "center", lineHeight: 1.4, wordBreak: "break-word",
        }}>{text}</div>
      </div>
      <div style={{ fontSize: 10.5, color: T.muted, textAlign: "center", flexShrink: 0 }}>{hint}</div>
    </div>
  );
}

function StudyDeck({ T, faces, items, deckKey, progress, setProgress }) {
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const [shuffle, setShuffle] = useState(false);
  const [round, setRound] = useState(0);
  const [deck, setDeck] = useState(() => items.slice());
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState([]);
  const [missed, setMissed] = useState([]);

  const start = useCallback((list) => {
    setDeck(shuffle ? shuffleList(list) : list.slice());
    setIdx(0); setFlipped(false); setKnown([]); setMissed([]);
  }, [shuffle]);

  // Rebuild only when the filters / shuffle / restart change — never on a progress
  // update, so a card that just became "zvládnuto" doesn't shift the deck under you.
  useEffect(() => { start(itemsRef.current); }, [deckKey, shuffle, round]); // eslint-disable-line react-hooks/exhaustive-deps

  const item = deck[idx];
  const p = (item && progress[item.id]) || emptyProgress;
  const done = isMastered(p);
  const finished = deck.length > 0 && idx >= deck.length;

  const go = (delta) => {
    setFlipped(false);
    setIdx((i) => Math.max(0, Math.min(i + delta, deck.length)));
  };

  const grade = (knew) => {
    if (!item) return;
    const box = knew ? Math.min((p.box || 0) + 1, 6) : Math.max((p.box || 0) - 1, 0);
    setProgress(item.id, { box, due: nextDue(box), reps: (p.reps || 0) + 1 });
    (knew ? setKnown : setMissed)((l) => [...l, item]);
    go(1);
  };

  // Re-registered every render on purpose: the handler must see the current card.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); setFlipped((f) => !f); }
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "1") grade(false);
      else if (e.key === "2") grade(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (deck.length === 0) {
    return <div style={{ color: T.muted, fontSize: 13, fontStyle: "italic" }}>Nic neodpovídá filtru.</div>;
  }

  const pct = Math.round((Math.min(idx, deck.length) / deck.length) * 100);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {Math.min(idx + 1, deck.length)} / {deck.length}
        </span>
        <div style={{ flex: 1, height: 5, borderRadius: 3, background: T.mono, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: T.accent, transition: "width .25s" }} />
        </div>
        <span style={{ fontSize: 11.5, color: T.good, fontWeight: 600 }}>✓ {known.length}</span>
        <span style={{ fontSize: 11.5, color: T.bad, fontWeight: 600 }}>✗ {missed.length}</span>
        <Btn T={T} tone={shuffle ? "solid" : undefined} onClick={() => setShuffle((s) => !s)} title="Zamíchat pořadí">⇄</Btn>
        <Btn T={T} onClick={() => setRound((r) => r + 1)} title="Začít znovu">↺</Btn>
      </div>

      {finished ? (
        <div style={{
          border: `1px solid ${T.border}`, borderRadius: 14, background: T.panel, boxShadow: T.shadow,
          padding: "40px 24px", textAlign: "center",
        }}>
          <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 6 }}>Hotovo!</div>
          <div style={{ color: T.muted, fontSize: 13, marginBottom: 18 }}>
            Umíš {known.length} z {deck.length} · neznámých {missed.length}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            {missed.length > 0 && (
              <Btn T={T} tone="solid" style={{ padding: "8px 16px" }} onClick={() => start(missed)}>
                Opakovat neznámé ({missed.length})
              </Btn>
            )}
            <Btn T={T} style={{ padding: "8px 16px" }} onClick={() => setRound((r) => r + 1)}>
              Celou sadu znovu
            </Btn>
          </div>
        </div>
      ) : (
        <>
          <div onClick={() => setFlipped((f) => !f)} style={{ perspective: 1600, cursor: "pointer" }}>
            <div style={{
              position: "relative", height: "clamp(240px, 42vh, 360px)", transformStyle: "preserve-3d",
              transition: "transform .5s cubic-bezier(.2,.75,.3,1)",
              transform: flipped ? "rotateX(180deg)" : "rotateX(0deg)",
            }}>
              <CardFace T={T} label={faces.frontLabel} text={faces.front(item)}
                        hint="klikni nebo mezerník pro otočení"
                        onSpeak={() => speak(faces.front(item))} />
              <CardFace T={T} label={faces.backLabel} text={faces.back(item)}
                        hint={`opakováno ${p.reps || 0}× · krabička ${p.box || 0}/6`}
                        style={{ transform: "rotateX(180deg)" }} />
            </div>
          </div>

          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", margin: "10px 0 14px" }}>
            <span style={{ background: T.fill, color: T.fillText, borderRadius: 3, padding: "2px 7px", fontSize: 10.5, fontWeight: 700 }}>
              {item.level}
            </span>
            <span style={{ border: `1px solid ${T.border}`, borderRadius: 3, padding: "1px 7px", fontSize: 10.5, color: T.muted }}>
              {item.tag}
            </span>
            {item.source && (
              <span style={{ border: `1px solid ${T.border}`, borderRadius: 3, padding: "1px 7px", fontSize: 10.5, color: T.muted }}
                    title="zdrojový list">{item.source}</span>
            )}
            <span style={{ flex: 1 }} />
            <Btn T={T} tone={done ? "good" : undefined}
                 onClick={() => setProgress(item.id, done ? { box: 0, due: null } : { box: 4, due: nextDue(4) })}>
              {done ? "★ Zvládnuto" : "☆ Označit jako zvládnuté"}
            </Btn>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr auto", gap: 8 }}>
            <Btn T={T} style={{ padding: "10px 14px" }} disabled={idx === 0} onClick={() => go(-1)}>◀</Btn>
            <Btn T={T} tone="bad" style={{ padding: "10px 0" }} onClick={() => grade(false)}>Neznal jsem</Btn>
            <Btn T={T} tone="good" style={{ padding: "10px 0", background: T.good, color: T.fillText }}
                 onClick={() => grade(true)}>Znal jsem</Btn>
            <Btn T={T} style={{ padding: "10px 14px" }} onClick={() => go(1)}>▶</Btn>
          </div>
          <div style={{ color: T.muted, fontSize: 11, textAlign: "center", marginTop: 8 }}>
            mezerník = otočit · ← → = předchozí/další · 1 = neznal · 2 = znal
          </div>
        </>
      )}
    </div>
  );
}

function TicketShell({ T, item, index, done, onToggleDone, meta, title, children }) {
  return (
    <div data-ticket style={{ border: `1px solid ${T.border}`, borderRadius: 6, background: T.panel, padding: 14, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
        <input type="checkbox" checked={done} onChange={onToggleDone} style={{ marginTop: 3 }}
               title="označit jako zvládnuté" />
        <div style={{ flex: 1 }}>
          <span style={{ fontWeight: 700, fontSize: 12.5, marginRight: 8 }}>#{String(index).padStart(3, "0")}</span>
          <span style={{
            fontSize: 14, fontWeight: 600, textDecoration: done ? "line-through" : "none",
            color: done ? T.muted : T.text,
          }}>{title}</span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ background: T.fill, color: T.fillText, borderRadius: 3, padding: "2px 7px", fontSize: 10.5, fontWeight: 700 }}>
          {item.level}
        </span>
        <span style={{ border: `1px solid ${T.border}`, borderRadius: 3, padding: "1px 7px", fontSize: 10.5, color: T.muted }}>
          {item.tag}
        </span>
        {item.source && (
          <span style={{ border: `1px solid ${T.border}`, borderRadius: 3, padding: "1px 7px", fontSize: 10.5, color: T.muted }}
                title="zdrojový list">{item.source}</span>
        )}
        {meta && <span style={{ color: T.muted, fontSize: 11.5, marginLeft: 4 }}>{meta}</span>}
      </div>
      {children}
      {item.note && (
        <div style={{ color: T.muted, fontSize: 11, marginTop: 8, fontStyle: "italic" }}>{item.note}</div>
      )}
    </div>
  );
}

function useGrading(item, p, setProgress) {
  return useCallback((knew) => {
    const box = knew ? Math.min((p.box || 0) + 1, 6) : Math.max((p.box || 0) - 1, 0);
    setProgress(item.id, { box, due: nextDue(box), reps: (p.reps || 0) + 1 });
  }, [item.id, p.box, p.reps, setProgress]);
}
const toggleDone = (item, p, setProgress) => () =>
  setProgress(item.id, isMastered(p) ? { box: 0, due: null } : { box: 4, due: nextDue(4) });

function CardTicket({ T, item, index, p, setProgress }) {
  const [revealed, setRevealed] = useState(false);
  const done = isMastered(p);
  const grade = useGrading(item, p, setProgress);

  return (
    <TicketShell T={T} item={item} index={index} done={done}
                 onToggleDone={toggleDone(item, p, setProgress)}
                 meta={`opakováno ${p.reps || 0}×`} title={item.front}>
      <Label T={T}>ZADÁNÍ</Label>
      <MonoPanel T={T} style={{ marginBottom: 8 }}>{item.front}</MonoPanel>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: revealed ? 8 : 0 }}>
        <Label T={T}>ODPOVĚĎ</Label>
        <Btn T={T} onClick={() => setRevealed(!revealed)}>{revealed ? "Skrýt" : "Zobrazit"}</Btn>
      </div>
      {revealed && (
        <>
          <MonoPanel T={T} style={{ marginBottom: 10, color: T.good }}>{item.back}</MonoPanel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Btn T={T} tone="bad" style={{ padding: "8px 0" }} onClick={() => { grade(false); setRevealed(false); }}>
              Neznal jsem
            </Btn>
            <Btn T={T} tone="good" style={{ padding: "8px 0", background: T.good, color: T.fillText }}
                 onClick={() => { grade(true); setRevealed(false); }}>
              Znal jsem
            </Btn>
          </div>
        </>
      )}
    </TicketShell>
  );
}

function FillInTicket({ T, item, index, p, setProgress }) {
  const [selected, setSelected] = useState(null);
  const done = isMastered(p);
  const parts = item.sentence.split("___");
  const timeout = useRef(null);
  useEffect(() => () => clearTimeout(timeout.current), []);

  function choose(opt) {
    if (selected) return;
    setSelected(opt);
    const correct = opt === item.answer;
    // Správná odpověď rovnou označí cvičení za zvládnuté (box 4 = isMastered),
    // takže se checkbox zaškrtne sám a není potřeba na něj klikat.
    const box = correct ? Math.max(p.box || 0, 4) : Math.max((p.box || 0) - 1, 0);
    timeout.current = setTimeout(() => {
      setProgress(item.id, { box, due: nextDue(box), reps: (p.reps || 0) + 1 });
      setSelected(null);
    }, 900);
  }

  return (
    <TicketShell T={T} item={item} index={index} done={done}
                 onToggleDone={toggleDone(item, p, setProgress)}
                 meta={`opakováno ${p.reps || 0}×`} title={item.sentence.replace("___", "_____")}>
      <Label T={T}>VĚTA</Label>
      <MonoPanel T={T} style={{ marginBottom: 10 }}>
        {parts[0]}
        <span style={{
          fontWeight: 700,
          color: selected ? (selected === item.answer ? T.good : T.bad) : T.text,
          borderBottom: "2px solid currentColor",
        }}>{selected || "___"}</span>
        {parts.slice(1).join("___")}
      </MonoPanel>
      <Label T={T}>MOŽNOSTI</Label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {item.options.map((opt, i) => {
          let border = T.border, color = T.text;
          if (selected) {
            if (opt === item.answer) { border = T.good; color = T.good; }
            else if (opt === selected) { border = T.bad; color = T.bad; }
            else color = T.muted;
          }
          return (
            <button key={`${opt}-${i}`} disabled={!!selected} onClick={() => choose(opt)} style={{
              border: `1px solid ${border}`, color, background: "transparent", borderRadius: 4,
              padding: "8px 4px", fontWeight: 600, fontSize: 12.5, fontFamily: UI_FONT,
              cursor: selected ? "default" : "pointer",
            }}>{opt}</button>
          );
        })}
      </div>
      {selected && (
        selected === item.answer
          ? <div style={{ color: T.good, fontSize: 12, marginTop: 8, fontWeight: 600 }}>Správně — označeno jako zvládnuté ✓</div>
          : <div style={{ color: T.bad, fontSize: 12, marginTop: 8 }}>Správně je <b>{item.answer}</b></div>
      )}
    </TicketShell>
  );
}

function TypingTicket({ T, item, index, p, setProgress, onDefer, onAdvance }) {
  const [val, setVal] = useState("");
  const [checked, setChecked] = useState(null);
  const done = isMastered(p);

  const [hint, setHint] = useState(null);
  const timeout = useRef(null);
  useEffect(() => () => clearTimeout(timeout.current), []);

  function check() {
    if (checked !== null) return;
    const { ok, hint: h } = checkAnswer(val, item.answer);
    setChecked(ok);
    setHint(h || null);
    if (ok) {
      // Správně → rovnou zvládnuto; se zapnutým „skrýt zvládnuté" cvičení samo zmizí.
      // Se zpožděním, ať je vidět zelené potvrzení, než odejde ze seznamu.
      const box = Math.max(p.box || 0, 4);
      timeout.current = setTimeout(() => {
        setProgress(item.id, { box, due: nextDue(box), reps: (p.reps || 0) + 1 });
        onAdvance?.();
      }, 1000);
    } else {
      const box = Math.max((p.box || 0) - 1, 0);
      setProgress(item.id, { box, due: nextDue(box), reps: (p.reps || 0) + 1 });
    }
  }
  // Chybné cvičení se po odklepnutí přesune na konec dávky, ať na něj dojde znovu.
  const reset = () => {
    if (checked === false) onDefer?.(item.id);
    setVal(""); setChecked(null); setHint(null);
    onAdvance?.();
  };

  return (
    <TicketShell T={T} item={item} index={index} done={done}
                 onToggleDone={toggleDone(item, p, setProgress)}
                 meta={`opakováno ${p.reps || 0}×`} title={item.prompt}>
      <Label T={T}>ÚKOL</Label>
      <MonoPanel T={T} style={{ marginBottom: 10 }}>{item.prompt}</MonoPanel>
      <Label T={T}>ODPOVĚĎ</Label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          data-answer
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (checked === null ? check() : reset())}
          readOnly={checked !== null}
          placeholder="napiš odpověď…"
          style={{
            flex: 1, padding: "8px 10px", borderRadius: 4,
            border: `1px solid ${checked === null ? T.border : checked ? T.good : T.bad}`,
            background: T.mono, color: T.text, fontFamily: MONO_FONT, fontSize: 13,
          }}
        />
        <Btn T={T} tone="solid" style={{ padding: "0 14px" }} onClick={checked === null ? check : reset}
             title={checked === false ? "Vyčistit a přesunout na konec" : undefined}>
          {checked === null ? "OK" : "↺"}
        </Btn>
      </div>
      {checked === false && (
        <div style={{ color: T.bad, fontSize: 12, marginTop: 6 }}>
          {hint === "article" ? "Skoro — pozor na člen. " : ""}Správně: <b>{item.answer}</b>
          <span style={{ color: T.muted, marginLeft: 6 }}>· Enter nebo ↺ přesune cvičení na konec</span>
        </div>
      )}
      {checked === true && (
        <div style={{ color: T.good, fontSize: 12, marginTop: 6, fontWeight: 600 }}>
          Správně — zvládnuto ✓
        </div>
      )}
    </TicketShell>
  );
}

function ConversationTicket({ T, item, index, p, setProgress }) {
  const [revealed, setRevealed] = useState(false);
  const done = isMastered(p);
  const grade = useGrading(item, p, setProgress);
  return (
    <TicketShell T={T} item={item} index={index} done={done}
                 onToggleDone={toggleDone(item, p, setProgress)}
                 meta={`opakováno ${p.reps || 0}×`} title={item.de}>
      <Label T={T}>NĚMECKY</Label>
      <MonoPanel T={T} style={{ marginBottom: 8 }}>{item.de}</MonoPanel>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: revealed ? 6 : 0 }}>
        <Label T={T}>PŘEKLAD</Label>
        <Btn T={T} onClick={() => setRevealed(!revealed)}>{revealed ? "Skrýt" : "Zobrazit"}</Btn>
      </div>
      {revealed && (
        <>
          <MonoPanel T={T} style={{ color: T.muted, marginBottom: 10 }}>{item.cz}</MonoPanel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Btn T={T} tone="bad" style={{ padding: "8px 0" }} onClick={() => { grade(false); setRevealed(false); }}>
              Ještě neumím
            </Btn>
            <Btn T={T} tone="good" style={{ padding: "8px 0", background: T.good, color: T.fillText }}
                 onClick={() => { grade(true); setRevealed(false); }}>
              Umím
            </Btn>
          </div>
        </>
      )}
    </TicketShell>
  );
}

/* ------------------------------------------------ materials -------------------- */
const KIND_LABEL = { pdf: "PDF", docx: "Word", xls: "Excel", ods: "Calc", mp3: "Audio" };

function Materials({ T }) {
  const all = DATA.materials;
  const [topic, setTopic] = useState("");
  const [level, setLevel] = useState("");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState(null);
  const [limit, setLimit] = useState(PAGE);

  const topics = useMemo(() => uniqueSorted(all.map((m) => m.topic)), [all]);
  const filtered = useMemo(() => {
    const q = fold(query.trim());
    return all.filter((m) => {
      if (topic && m.topic !== topic) return false;
      if (level && m.level !== level) return false;
      if (!q) return true;
      return fold([m.title, m.file, m.topic, m.note, ...(m.aliases || []), ...m.pages].join(" ")).includes(q);
    });
  }, [all, topic, level, query]);

  const totals = DATA.stats;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 20px 80px" }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 4px" }}>Materiály</h1>
      <div style={{ color: T.muted, fontSize: 12, marginBottom: 14 }}>
        {all.length} souborů z <code>{DATA.generatedFrom}</code> · z nich vytvořeno{" "}
        {totals.cards} karet, {totals.fillIns} cvičení s výběrem, {totals.typing} psacích cvičení a{" "}
        {totals.conversations} frází. Text je vytažený z originálů, které lze otevřít.
      </div>

      <div style={{ border: `1px solid ${T.border}`, borderRadius: 6, padding: 12, marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {["", ...LEVEL_ORDER].map((l) => (
          <button key={l || "all"} onClick={() => setLevel(l)} style={{
            border: `1px solid ${level === l ? T.text : T.border}`,
            background: level === l ? T.fill : "transparent",
            color: level === l ? T.fillText : T.text, borderRadius: 4, padding: "3px 9px",
            fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: UI_FONT,
          }}>{l || "vše"}</button>
        ))}
        <Select T={T} value={topic} onChange={setTopic} options={topics} allLabel="všechna témata" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="hledat v textu materiálů…"
               style={{
                 flex: 1, minWidth: 160, padding: "5px 8px", borderRadius: 4,
                 border: `1px solid ${T.border}`, background: T.mono, color: T.text,
                 fontFamily: UI_FONT, fontSize: 12,
               }} />
        <span style={{ fontSize: 11.5, color: T.muted }}>{filtered.length} nalezeno</span>
      </div>

      {filtered.slice(0, limit).map((m) => (
        <MaterialCard key={m.id} T={T} m={m} open={openId === m.id}
                      onToggle={() => setOpenId(openId === m.id ? null : m.id)}
                      onOpenOther={(id) => setOpenId(id)} />
      ))}
      {filtered.length > limit && (
        <Btn T={T} tone="solid" style={{ width: "100%", padding: "8px 0" }}
             onClick={() => setLimit(limit + PAGE)}>
          Zobrazit další ({filtered.length - limit})
        </Btn>
      )}
    </div>
  );
}

function MaterialCard({ T, m, open, onToggle, onOpenOther }) {
  const [preview, setPreview] = useState(false);
  const derived = m.derived || {};
  const derivedTotal = ["cards", "fillIns", "typing", "conversations"]
    .map((k) => derived[k]).filter((n) => typeof n === "number").reduce((a, b) => a + b, 0);
  const keyMat = m.answerKey && DATA.materials.find((x) => x.id === m.answerKey);
  const taskMat = m.answerFor && DATA.materials.find((x) => x.id === m.answerFor);

  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 6, background: T.panel, padding: 14, marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 14, fontWeight: 600, cursor: "pointer" }} onClick={onToggle}>
            {open ? "▾ " : "▸ "}{m.title}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
            <span style={{ background: T.fill, color: T.fillText, borderRadius: 3, padding: "2px 7px", fontSize: 10.5, fontWeight: 700 }}>{m.level}</span>
            <span style={{ border: `1px solid ${T.border}`, borderRadius: 3, padding: "1px 7px", fontSize: 10.5, color: T.muted }}>{m.topic}</span>
            <span style={{ border: `1px solid ${T.border}`, borderRadius: 3, padding: "1px 7px", fontSize: 10.5, color: T.muted }}>{KIND_LABEL[m.kind] || m.kind}</span>
            {m.lesson && <span style={{ fontSize: 10.5, color: T.muted }}>{m.lesson}. lekce</span>}
            {m.pages?.length > 1 && <span style={{ fontSize: 10.5, color: T.muted }}>{m.pages.length} str.</span>}
            <span style={{ fontSize: 10.5, color: T.muted }}>
              {derivedTotal > 0 ? `${derivedTotal} cvičení` : "jen ke čtení"}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <a href={`/${m.src}`} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <Btn T={T}>Otevřít originál</Btn>
          </a>
          {m.kind === "pdf" && <Btn T={T} onClick={() => { setPreview(!preview); if (!open) onToggle(); }}>Náhled</Btn>}
        </div>
      </div>

      {m.origin && (
        <div style={{ fontSize: 11, color: T.muted, marginTop: 6 }}>z archivu {m.origin}</div>
      )}
      {m.aliases?.length > 0 && (
        <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>
          stejný obsah jako: {m.aliases.join(", ")}
        </div>
      )}
      {m.note && (
        <div style={{ fontSize: 11.5, color: T.muted, marginTop: 6, fontStyle: "italic" }}>{m.note}</div>
      )}
      {(keyMat || taskMat) && (
        <div style={{ fontSize: 11.5, marginTop: 6 }}>
          {keyMat && <span>Klíč / řešení: <a style={{ color: T.text, cursor: "pointer", textDecoration: "underline" }}
                                             onClick={() => onOpenOther(keyMat.id)}>{keyMat.title}</a></span>}
          {taskMat && <span>Zadání: <a style={{ color: T.text, cursor: "pointer", textDecoration: "underline" }}
                                      onClick={() => onOpenOther(taskMat.id)}>{taskMat.title}</a></span>}
        </div>
      )}

      {m.kind === "mp3" && (
        <audio controls src={`/${m.src}`} style={{ width: "100%", marginTop: 10 }} />
      )}

      {open && (
        <div style={{ marginTop: 12 }}>
          {preview && m.kind === "pdf" && (
            <iframe title={m.title} src={`/${m.src}`} style={{
              width: "100%", height: 620, border: `1px solid ${T.border}`, borderRadius: 5, marginBottom: 12,
            }} />
          )}
          {m.images?.map((src) => (
            <img key={src} src={`/${src}`} alt={m.title} style={{
              width: "100%", border: `1px solid ${T.border}`, borderRadius: 5, marginBottom: 10,
            }} />
          ))}
          {m.sheets?.map((sh) => (
            <div key={sh.name} style={{ marginBottom: 12 }}>
              <Label T={T}>LIST {sh.name.toUpperCase()}</Label>
              <div style={{ overflowX: "auto", border: `1px solid ${T.border}`, borderRadius: 5 }}>
                <table style={{ borderCollapse: "collapse", fontFamily: MONO_FONT, fontSize: 11.5 }}>
                  <tbody>
                    {sh.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.filter((c) => c !== "").map((c, ci) => (
                          <td key={ci} style={{ border: `1px solid ${T.border}`, padding: "3px 6px", whiteSpace: "nowrap" }}>{c}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {m.pages?.filter((p) => p.trim()).map((page, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              {m.pages.length > 1 && <Label T={T}>STRANA {i + 1}</Label>}
              <MonoPanel T={T} style={{ fontSize: 12, lineHeight: 1.55, maxHeight: 460, overflow: "auto" }}>
                {page}
              </MonoPanel>
            </div>
          ))}
          {!m.pages?.some((p) => p.trim()) && !m.images?.length && m.kind !== "mp3" && (
            <div style={{ color: T.muted, fontSize: 12, fontStyle: "italic" }}>
              Textová vrstva chybí — otevři originál.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------ notes ------------------------ */
function Notes({ T, notes, save }) {
  const [text, setText] = useState(notes || "");
  const [saved, setSaved] = useState(true);
  useEffect(() => setText(notes || ""), [notes]);

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 20px 80px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Poznámky</h1>
        <Btn T={T} tone={saved ? undefined : "solid"} onClick={() => { save(text); setSaved(true); }}>
          {saved ? "Uloženo" : "Uložit"}
        </Btn>
      </div>
      <div style={{ color: T.muted, fontSize: 12, marginBottom: 14 }}>
        Vlastní shrnutí, pravidla, cvičné odpovědi na zkušební otázky…
      </div>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setSaved(false); }}
        style={{
          width: "100%", minHeight: 420, resize: "vertical", border: `1px solid ${T.border}`,
          borderRadius: 6, background: T.panel, color: T.text, padding: 14,
          fontFamily: MONO_FONT, fontSize: 13, lineHeight: 1.6,
        }}
        placeholder="Sem piš…"
      />
    </div>
  );
}
