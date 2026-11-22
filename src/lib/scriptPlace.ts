import { providerOptions } from "./aiProvider";
import { streamChat } from "./api";
import { fmtTime, newId, wordNumbers } from "./timed";
import type { ImageMeta, Settings, TimedDoc, TimedItem } from "./types";

/**
 * Senaryodaki (elle yazılan metin) resimleri ve AI notlarını, seslendirmeden çıkan zamanlı metne yerleştirir.
 * AI notu: senaryoda seçilip nota çevrilen metin (scriptNote işareti); seslendirilmez, AI'a bilgi olarak gider.
 *
 * 1) Senaryo kelimeleri ile konuşmadaki kelimeler hizalanır (yarı-global dizi hizalama; baştaki/sondaki
 *    fazlalıklar ücretsiz, dolgu/tekrar/sapmalar boşluk olarak geçer). Aynı cümle iki kez söylendiyse
 *    son okuma tercih edilir (genelde temiz olan odur).
 * 2) Her ek, senaryoda kendisinden sonra gelen kelimenin konuşmada söylendiği yere konur (paragraf sonundaysa
 *    önceki kelimenin arkasına). Çevresi iyi eşleşmeyen ek "yaklaşık" işaretlenir.
 * 3) Yaklaşık ekler için (model seçiliyse) AI'a senaryodaki çevresi ve konuşmanın ilgili bölümü
 *    gönderilip doğru kelime sorulur.
 */

type AttItem = Extract<TimedItem, { k: "img" } | { k: "note" }>;

/** Senaryoda AI notu olarak işaretlenen metnin TipTap işaret adı. */
export const NOTE_MARK = "scriptNote";

interface PMNode {
  type: string;
  attrs?: Record<string, any>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string }[];
}

/** Senaryodaki bir ek: resim ya da AI notu. */
export interface ScriptAtt {
  kind: "img" | "note";
  /** Senaryoda ekten sonra gelen ilk kelimenin sırası (ek bu kelimenin önündedir). */
  pos: number;
  /** Resim için */
  path?: string;
  name?: string;
  /** Not için */
  text?: string;
  /** Paragrafın sonunda (önünde metin var, arkasında yok): önceki cümleye aittir. */
  tail?: boolean;
}

export interface ScriptTokens {
  words: string[];
  atts: ScriptAtt[];
}

const isNoteText = (n: PMNode) => n.type === "text" && !!n.marks?.some((m) => m.type === NOTE_MARK);

/**
 * Senaryo (TipTap JSON) içindeki seslendirilecek kelimeleri ve eklerin (resim, AI notu) kelime dizisindeki yerlerini
 * çıkarır. Not olarak işaretli metin kelimelere katılmaz; art arda gelen not parçaları tek nota birleşir.
 */
export function scriptTokens(doc: any, meta: Record<string, ImageMeta> = {}): ScriptTokens {
  const words: string[] = [];
  const atts: ScriptAtt[] = [];
  let note: string | null = null;
  const flushNote = () => {
    const text = note?.replace(/\s+/g, " ").trim();
    if (text) atts.push({ kind: "note", pos: words.length, text });
    note = null;
  };
  const walk = (n: PMNode | undefined) => {
    if (!n) return;
    if (isNoteText(n)) {
      note = (note ?? "") + (n.text ?? "");
      return;
    }
    if (n.type === "hardBreak" && note !== null) {
      note += " ";
      return;
    }
    flushNote();
    if (n.type === "text") {
      for (const w of (n.text ?? "").split(/\s+/)) if (fold(w)) words.push(w);
      return;
    }
    if (n.type === "imageChip") {
      const path: string = n.attrs?.path ?? "";
      if (path) atts.push({ kind: "img", pos: words.length, path, name: meta[path]?.name || n.attrs?.name || "resim" });
      return;
    }
    if (n.type === "paragraph" || n.type === "heading") {
      const start = words.length;
      const first = atts.length;
      n.content?.forEach(walk);
      flushNote();
      for (const a of atts.slice(first)) if (a.pos === words.length && a.pos > start) a.tail = true;
      return;
    }
    n.content?.forEach(walk);
  };
  walk(doc as PMNode);
  flushNote();
  return { words, atts };
}

/** Senaryoda zamanlı metne yerleştirilecek ek (resim ya da AI notu) var mı? Hızlı tarama. */
export function hasScriptAtts(doc: any): boolean {
  const walk = (n: PMNode | undefined): boolean =>
    !!n && (n.type === "imageChip" || (isNoteText(n) && !!n.text?.trim()) || !!n.content?.some(walk));
  return walk(doc as PMNode);
}

/** Karşılaştırma için kelime: Türkçe küçük harf, aksansız, yalnızca harf/rakam. */
export function fold(w: string): string {
  return w
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

const EXACT = 3;
const STEM = 2; // Türkçe ekler: ilk 5 harf aynıysa yakın kelime sayılır ("videoda" ~ "videodaki")
const GAP = 1;
/** Bu kadar hücreyi aşan hizalama yapılmaz (bellek/süre); ekler orantılı yerleşir, AI düzeltir. */
const MAX_CELLS = 40_000_000;

/**
 * Senaryo kelimelerini konuşma kelimeleriyle hizalar. Dönen dizi: senaryo kelimesi → konuşmadaki kelime sırası (yoksa -1).
 * Baştaki ve sondaki eşleşmeyen kısımlar cezasızdır (senaryonun bir kısmı okunmuş ya da kayıtta fazladan konuşma olabilir).
 */
export function alignWords(script: string[], spoken: string[]): Int32Array {
  const S = script.length;
  const T = spoken.length;
  const match = new Int32Array(S).fill(-1);
  if (!S || !T || (S + 1) * (T + 1) > MAX_CELLS) return match;

  const vocab = new Map<string, number>();
  const id = (s: string) => {
    let v = vocab.get(s);
    if (v === undefined) vocab.set(s, (v = vocab.size));
    return v;
  };
  const enc = (list: string[]) => {
    const full = new Int32Array(list.length);
    const stem = new Int32Array(list.length);
    list.forEach((w, i) => {
      const f = fold(w);
      full[i] = id(f);
      stem[i] = f.length >= 5 ? id("~" + f.slice(0, 5)) : -1 - i; // kısa kelimelerde yalnızca tam eşleşme
    });
    return { full, stem };
  };
  const a = enc(script);
  const b = enc(spoken);
  // b'nin kısa kelime işaretleri a'nınkiyle çakışmasın
  for (let j = 0; j < T; j++) if (b.stem[j] < 0) b.stem[j] = -1_000_000_000 - j;

  const W = T + 1;
  const dir = new Uint8Array((S + 1) * W); // 1: çapraz (eşleşme), 2: yukarı (senaryo kelimesi atlandı), 3: sol (konuşma kelimesi atlandı)
  let prev = new Int32Array(W); // satır 0: baştaki konuşma ücretsiz
  let cur = new Int32Array(W);
  let best = 0;
  let bi = 0;
  let bj = 0;
  for (let i = 1; i <= S; i++) {
    cur[0] = 0; // baştaki senaryo ücretsiz
    const af = a.full[i - 1];
    const as = a.stem[i - 1];
    const row = i * W;
    for (let j = 1; j <= T; j++) {
      const sc = af === b.full[j - 1] ? EXACT : as === b.stem[j - 1] ? STEM : 0;
      let v = -Infinity;
      let d = 0;
      if (sc) {
        v = prev[j - 1] + sc;
        d = 1;
      }
      const up = prev[j] - GAP;
      if (up > v) {
        v = up;
        d = 2;
      }
      const left = cur[j - 1] - GAP;
      if (left > v) {
        v = left;
        d = 3;
      }
      cur[j] = v;
      dir[row + j] = d;
    }
    // sondaki fazlalıklar ücretsiz: son sütun ve son satır aday bitiş noktaları
    if (cur[T] > best) {
      best = cur[T];
      bi = i;
      bj = T;
    }
    [prev, cur] = [cur, prev];
  }
  for (let j = 1; j <= T; j++) {
    if (prev[j] > best) {
      best = prev[j];
      bi = S;
      bj = j;
    }
  }
  let i = bi;
  let j = bj;
  while (i > 0 && j > 0) {
    const d = dir[i * W + j];
    if (d === 1) {
      match[i - 1] = j - 1;
      i--;
      j--;
    } else if (d === 2) i--;
    else if (d === 3) j--;
    else break;
  }
  return match;
}

export interface Placement {
  att: ScriptAtt;
  /** Konuşmadaki kelime sırası (wordNumbers dizinine göre) */
  word: number;
  /** "before": ek bu kelimenin önüne; "after": bu kelimenin arkasına */
  side: "before" | "after";
  approx: boolean;
  /** AI'a gönderilecek konuşma aralığı (kelime sırası, dahil) */
  win: [number, number];
}

const NEAR = 2; // eşleşen komşu en fazla bu kadar kelime uzaktaysa konum kesin sayılır
const SUPPORT_SPAN = 6;
const SUPPORT_MIN = 3;

/** Hizalamadan her ekin konuşmadaki yerini çıkarır. */
export function planPlacements(tokens: ScriptTokens, spokenCount: number, match: Int32Array): Placement[] {
  const S = tokens.words.length;
  const T = spokenCount;
  if (!T) return [];
  const clamp = (n: number) => Math.max(0, Math.min(T - 1, n));
  return tokens.atts.map((att) => {
    const p = att.pos;
    let kn = -1;
    for (let k = p; k < S; k++) if (match[k] >= 0) { kn = k; break; }
    let kp = -1;
    for (let k = p - 1; k >= 0; k--) if (match[k] >= 0) { kp = k; break; }
    const support = (from: number, to: number) => {
      let c = 0;
      for (let k = Math.max(0, from); k < Math.min(S, to); k++) if (match[k] >= 0) c++;
      return c;
    };
    const dn = kn >= 0 ? kn - p : Infinity;
    const dp = kp >= 0 ? p - 1 - kp : Infinity;
    const nextOk = dn <= NEAR && support(p, p + SUPPORT_SPAN) >= SUPPORT_MIN;
    const prevOk = dp <= NEAR && support(p - SUPPORT_SPAN, p) >= SUPPORT_MIN;
    const tn = kn >= 0 ? match[kn] : -1;
    const tp = kp >= 0 ? match[kp] : -1;
    const win: [number, number] = [tp >= 0 ? tp : 0, tn >= 0 ? tn : T - 1];

    // Paragraf sonundaki ek önceki cümleye bağlanır; diğerleri sonraki cümlenin başına
    if (att.tail && prevOk) return { att, word: tp, side: "after", approx: false, win };
    if (nextOk && (dn === 0 || !prevOk || dn <= dp)) return { att, word: tn, side: "before", approx: false, win };
    if (prevOk) return { att, word: tp, side: "after", approx: false, win };

    // Yaklaşık konum: iki komşu eşleşme arasında senaryodaki orana göre
    let word: number;
    if (tp >= 0 && tn >= 0) word = Math.round(tp + ((p - kp) / (kn - kp)) * (tn - tp));
    else if (tn >= 0) word = tn - dn;
    else if (tp >= 0) word = tp + dp + 1;
    else word = S ? Math.round((p / S) * T) : 0;
    if (word >= T) return { att, word: T - 1, side: "after", approx: true, win };
    return { att, word: clamp(word), side: "before", approx: true, win };
  });
}

export interface PlaceResult {
  doc: TimedDoc;
  images: number;
  notes: number;
  approx: Placement[];
  ids: Map<Placement, string>;
}

/**
 * Senaryodaki resimleri ve AI notlarını zamanlı metne yerleştirir. Daha önce senaryodan yerleştirilmiş ekler (ya da
 * senaryodaki bir resimle aynı dosya) kaldırılıp yeniden konur; kullanıcının zamanlı metne kendi eklediklerine dokunulmaz.
 */
export function placeScriptItems(doc: TimedDoc, editorDoc: any, meta: Record<string, ImageMeta> = {}): PlaceResult {
  const tokens = scriptTokens(editorDoc, meta);
  const paths = new Set(tokens.atts.map((a) => a.path).filter(Boolean));
  const base = doc.items.filter(
    (it) => !((it.k === "img" && (it.from === "script" || paths.has(it.path))) || (it.k === "note" && it.from === "script")),
  );
  const words = wordNumbers(base);
  if (!tokens.atts.length || !words.length) return { doc: { ...doc, items: base }, images: 0, notes: 0, approx: [], ids: new Map() };

  const match = alignWords(tokens.words, words.map((w) => w.w));
  const plans = planPlacements(tokens, words.length, match);
  const before = new Map<string, AttItem[]>();
  const after = new Map<string, AttItem[]>();
  const ids = new Map<Placement, string>();
  for (const pl of plans) {
    const flags = { from: "script" as const, ...(pl.approx ? { approx: true } : {}) };
    const a = pl.att;
    const item: AttItem =
      a.kind === "img"
        ? { k: "img", id: newId(), path: a.path ?? "", name: a.name ?? "resim", ...flags }
        : { k: "note", id: newId(), text: a.text ?? "", ...flags };
    ids.set(pl, item.id);
    const key = words[pl.word].id;
    const m = pl.side === "before" ? before : after;
    m.set(key, [...(m.get(key) ?? []), item]);
  }
  const items: TimedItem[] = [];
  for (const it of base) {
    if (it.k === "w") items.push(...(before.get(it.id) ?? []), it, ...(after.get(it.id) ?? []));
    else items.push(it);
  }
  const images = plans.filter((p) => p.att.kind === "img").length;
  return { doc: { ...doc, items }, images, notes: plans.length - images, approx: plans.filter((p) => p.approx), ids };
}

// ---------------------------------------------------------------------------------------------------------------
// AI ile yaklaşık eklerin yerini bulma

export const PLACE_PROMPT = `Sen bir video kurgu asistanısın. Yazar bir senaryo yazdı; içine resimler ve kendisi için notlar ekledi (notlar seslendirilmez). Sonra senaryoyu seslendirdi ve konuşma kelime kelime zamanlı yazıya çevrildi. Görevin: her ekin konuşmada hangi kelimenin önüne düştüğünü bulmak.

Senaryoda ⟦RESİM k⟧ ve ⟦NOT k⟧ işaretleri eklerin yeridir: ek, işaretten hemen sonraki senaryo metninin söylenmeye başladığı yere aittir (işaret paragrafın sonundaysa, önündeki metnin hemen arkası). Resim o anda ekranda gösterilir; not o kısımla ilgili yazar açıklamasıdır. Konuşmada aynı yeri bul. Yazar senaryodan sapmış, cümleleri farklı söylemiş, tekrar etmiş ya da dolgu sesleri eklemiş olabilir; anlamca eşleştir. Bir cümle birden çok kez söylendiyse son (tamamlanmış) söyleyişi seç. Resim adı/notu ve not metni ipucu olarak kullanılabilir.

Konuşma kelimeleri \`numara [dakika:saniye.salise] kelime\` biçimindedir. Yalnızca JSON döndür, açıklama yazma:
{"items":[{"k":1,"n":123}]}
k: ekin numarası, n: ekin önüne düştüğü kelimenin numarası (verilen numaralardan biri). Konuşmada hiç karşılığı yoksa en yakın anlamlı yeri seç.`;

const SCRIPT_CONTEXT = 60; // ekin iki yanında gönderilecek senaryo kelimesi
const WIN_PAD = 25;
const MAX_WIN = 1500; // tek istekte gönderilecek en fazla konuşma kelimesi

interface Group {
  plans: Placement[];
  from: number;
  to: number;
}

/** Yaklaşık ekleri, konuşma aralıkları örtüşenleri tek istekte toplayarak gruplar. */
export function groupApprox(approx: Placement[], spokenCount: number): Group[] {
  const groups: Group[] = [];
  const sorted = [...approx].sort((a, b) => a.att.pos - b.att.pos);
  for (const pl of sorted) {
    let from = Math.max(0, pl.win[0] - WIN_PAD);
    let to = Math.min(spokenCount - 1, pl.win[1] + WIN_PAD);
    if (to - from + 1 > MAX_WIN) {
      from = Math.max(0, Math.min(pl.word - MAX_WIN / 2, spokenCount - MAX_WIN));
      to = Math.min(spokenCount - 1, from + MAX_WIN - 1);
    }
    const last = groups[groups.length - 1];
    if (last && from <= last.to && Math.max(to, last.to) - Math.min(from, last.from) + 1 <= MAX_WIN) {
      last.plans.push(pl);
      last.from = Math.min(from, last.from);
      last.to = Math.max(to, last.to);
    } else groups.push({ plans: [pl], from, to });
  }
  return groups;
}

/** Bir grup için AI'a gidecek kullanıcı mesajı. Ekler grupta 1'den numaralanır. */
export function buildPlaceRequest(group: Group, tokens: ScriptTokens, spoken: { n: number; w: string; s: number }[], meta: Record<string, ImageMeta>): string {
  const first = group.plans[0].att.pos;
  const last = group.plans[group.plans.length - 1].att.pos;
  const a = Math.max(0, first - SCRIPT_CONTEXT);
  const b = Math.min(tokens.words.length, last + SCRIPT_CONTEXT);
  const label = (pl: Placement) => (pl.att.kind === "img" ? "RESİM" : "NOT");
  const marks = new Map<number, string[]>();
  group.plans.forEach((pl, i) => marks.set(pl.att.pos, [...(marks.get(pl.att.pos) ?? []), `⟦${label(pl)} ${i + 1}⟧`]));
  const parts: string[] = [];
  if (a > 0) parts.push("…");
  for (let k = a; k <= b; k++) {
    parts.push(...(marks.get(k) ?? []));
    if (k < b) parts.push(tokens.words[k]);
  }
  if (b < tokens.words.length) parts.push("…");
  const info = group.plans.map((pl, i) => {
    if (pl.att.kind === "note") return `NOT ${i + 1}: ${pl.att.text}`;
    const note = meta[pl.att.path ?? ""]?.note?.replace(/\s+/g, " ").trim();
    return `RESİM ${i + 1}: ${pl.att.name}${note ? ` — resim notu: ${note}` : ""}`;
  });
  const lines = spoken.slice(group.from, group.to + 1).map((w) => `${w.n} [${fmtTime(w.s, 1)}] ${w.w}`);
  return `Senaryo (ilgili kısım):\n${parts.join(" ")}\n\nEkler:\n${info.join("\n")}\n\nKonuşma kelimeleri:\n${lines.join("\n")}`;
}

/** AI yanıtından ek → kelime numarası eşlemesini ayıklar; aralık dışındakiler atlanır. */
export function parsePlaceReply(text: string, count: number, minN: number, maxN: number): Map<number, number> {
  const out = new Map<number, number>();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return out;
  let list: unknown;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as { items?: unknown; images?: unknown };
    list = obj.items ?? obj.images;
  } catch {
    return out;
  }
  if (!Array.isArray(list)) return out;
  for (const r of list as { k?: unknown; n?: unknown }[]) {
    const k = Number(r?.k);
    const n = Number(r?.n);
    if (!Number.isInteger(k) || k < 1 || k > count || !Number.isInteger(n) || n < minN || n > maxN) continue;
    out.set(k, n);
  }
  return out;
}

/**
 * Yaklaşık yerleşen ekleri AI'a sorar. Dönen eşleme: ek öğesi kimliği → önüne konacağı kelime kimliği.
 * Bir grup başarısız olursa o gruptaki ekler yaklaşık konumda kalır.
 */
export async function refineWithAI(
  doc: TimedDoc,
  editorDoc: any,
  meta: Record<string, ImageMeta>,
  approx: Placement[],
  ids: Map<Placement, string>,
  s: Settings,
  onProgress?: (done: number, total: number) => void,
): Promise<{ moves: Map<string, string>; failed: number }> {
  const tokens = scriptTokens(editorDoc, meta);
  const spoken = wordNumbers(doc.items);
  const groups = groupApprox(approx, spoken.length);
  const moves = new Map<string, string>();
  let failed = 0;
  onProgress?.(0, groups.length);
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    try {
      const text = await streamChat({
        ...providerOptions(s, { temperature: 0 }),
        system: PLACE_PROMPT,
        user: buildPlaceRequest(group, tokens, spoken, meta),
      }).done;
      const got = parsePlaceReply(text, group.plans.length, spoken[group.from].n, spoken[group.to].n);
      group.plans.forEach((pl, i) => {
        const n = got.get(i + 1);
        const itemId = ids.get(pl);
        if (n === undefined || !itemId) return void failed++;
        moves.set(itemId, spoken[n - 1].id);
      });
    } catch {
      failed += group.plans.length;
    }
    onProgress?.(g + 1, groups.length);
  }
  return { moves, failed };
}

/** Ekleri (resim/not) verilen kelimelerin önüne taşır ve "yaklaşık" işaretini kaldırır. Silinmiş ek/kelime atlanır. */
export function applyMoves(items: TimedItem[], moves: Map<string, string>): TimedItem[] {
  const words = new Set(items.filter((i) => i.k === "w").map((i) => (i as { id: string }).id));
  const moving = new Map<string, AttItem[]>();
  const taken = new Set<string>();
  for (const it of items) {
    if (it.k !== "img" && it.k !== "note") continue;
    const target = moves.get(it.id);
    if (!target || !words.has(target)) continue;
    const { approx: _, ...rest } = it;
    moving.set(target, [...(moving.get(target) ?? []), rest as AttItem]);
    taken.add(it.id);
  }
  if (!taken.size) return items;
  const out: TimedItem[] = [];
  for (const it of items) {
    if ((it.k === "img" || it.k === "note") && taken.has(it.id)) continue;
    if (it.k === "w") out.push(...(moving.get(it.id) ?? []));
    out.push(it);
  }
  return out;
}
