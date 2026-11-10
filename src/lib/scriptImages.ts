import { streamChat } from "./api";
import { fmtTime, newId, wordNumbers } from "./timed";
import type { ImageMeta, Settings, TimedDoc, TimedItem } from "./types";

/**
 * Senaryodaki (elle yazılan metin) resimleri, seslendirmeden çıkan zamanlı metne yerleştirir.
 *
 * 1) Senaryo kelimeleri ile konuşmadaki kelimeler hizalanır (yarı-global dizi hizalama; baştaki/sondaki
 *    fazlalıklar ücretsiz, dolgu/tekrar/sapmalar boşluk olarak geçer). Aynı cümle iki kez söylendiyse
 *    son okuma tercih edilir (genelde temiz olan odur).
 * 2) Her resim, senaryoda kendisinden sonra gelen kelimenin konuşmada söylendiği yere konur; o kelime
 *    eşleşmediyse en yakın eşleşen komşuya göre. Çevresi iyi eşleşmeyen resim "yaklaşık" işaretlenir.
 * 3) Yaklaşık resimler için (model seçiliyse) AI'a senaryodaki çevresi ve konuşmanın ilgili bölümü
 *    gönderilip doğru kelime sorulur.
 */

type ImgItem = Extract<TimedItem, { k: "img" }>;

interface PMNode {
  type: string;
  attrs?: Record<string, any>;
  content?: PMNode[];
  text?: string;
}

export interface ScriptImage {
  /** Senaryoda resimden sonra gelen ilk kelimenin sırası (resim bu kelimenin önündedir). */
  pos: number;
  path: string;
  name: string;
  /** Paragrafın sonunda (önünde metin var, arkasında yok): önceki cümleye aittir. */
  tail?: boolean;
}

export interface ScriptTokens {
  words: string[];
  images: ScriptImage[];
}

/** Senaryo (TipTap JSON) içindeki kelimeleri ve resimlerin kelime dizisindeki yerlerini çıkarır. */
export function scriptTokens(doc: any, meta: Record<string, ImageMeta> = {}): ScriptTokens {
  const words: string[] = [];
  const images: ScriptImage[] = [];
  const walk = (n: PMNode | undefined) => {
    if (!n) return;
    if (n.type === "text") {
      for (const w of (n.text ?? "").split(/\s+/)) if (fold(w)) words.push(w);
      return;
    }
    if (n.type === "imageChip") {
      const path: string = n.attrs?.path ?? "";
      if (path) images.push({ pos: words.length, path, name: meta[path]?.name || n.attrs?.name || "resim" });
      return;
    }
    if (n.type === "paragraph" || n.type === "heading") {
      const start = words.length;
      const first = images.length;
      n.content?.forEach(walk);
      for (const img of images.slice(first)) if (img.pos === words.length && img.pos > start) img.tail = true;
      return;
    }
    n.content?.forEach(walk);
  };
  walk(doc as PMNode);
  return { words, images };
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
/** Bu kadar hücreyi aşan hizalama yapılmaz (bellek/süre); resimler orantılı yerleşir, AI düzeltir. */
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
  img: ScriptImage;
  /** Konuşmadaki kelime sırası (wordNumbers dizinine göre) */
  word: number;
  /** "before": resim bu kelimenin önüne; "after": bu kelimenin arkasına */
  side: "before" | "after";
  approx: boolean;
  /** AI'a gönderilecek konuşma aralığı (kelime sırası, dahil) */
  win: [number, number];
}

const NEAR = 2; // eşleşen komşu en fazla bu kadar kelime uzaktaysa konum kesin sayılır
const SUPPORT_SPAN = 6;
const SUPPORT_MIN = 3;

/** Hizalamadan her resmin konuşmadaki yerini çıkarır. */
export function planPlacements(tokens: ScriptTokens, spokenCount: number, match: Int32Array): Placement[] {
  const S = tokens.words.length;
  const T = spokenCount;
  if (!T) return [];
  const clamp = (n: number) => Math.max(0, Math.min(T - 1, n));
  return tokens.images.map((img) => {
    const p = img.pos;
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

    // Paragraf sonundaki resim önceki cümleye bağlanır; diğerleri sonraki cümlenin başına
    if (img.tail && prevOk) return { img, word: tp, side: "after", approx: false, win };
    if (nextOk && (dn === 0 || !prevOk || dn <= dp)) return { img, word: tn, side: "before", approx: false, win };
    if (prevOk) return { img, word: tp, side: "after", approx: false, win };

    // Yaklaşık konum: iki komşu eşleşme arasında senaryodaki orana göre
    let word: number;
    if (tp >= 0 && tn >= 0) word = Math.round(tp + ((p - kp) / (kn - kp)) * (tn - tp));
    else if (tn >= 0) word = tn - dn;
    else if (tp >= 0) word = tp + dp + 1;
    else word = S ? Math.round((p / S) * T) : 0;
    if (word >= T) return { img, word: T - 1, side: "after", approx: true, win };
    return { img, word: clamp(word), side: "before", approx: true, win };
  });
}

/**
 * Senaryodaki resimleri zamanlı metne yerleştirir. Daha önce senaryodan yerleştirilmiş resimler (ya da senaryodaki
 * bir resimle aynı dosya) kaldırılıp yeniden konur; kullanıcının zamanlı metne kendi eklediği resimlere dokunulmaz.
 */
export function placeScriptImages(
  doc: TimedDoc,
  editorDoc: any,
  meta: Record<string, ImageMeta> = {},
): { doc: TimedDoc; placed: number; approx: Placement[]; ids: Map<Placement, string> } {
  const tokens = scriptTokens(editorDoc, meta);
  const paths = new Set(tokens.images.map((i) => i.path));
  const base = doc.items.filter((it) => !(it.k === "img" && (it.from === "script" || paths.has(it.path))));
  const words = wordNumbers(base);
  if (!tokens.images.length || !words.length) return { doc: { ...doc, items: base }, placed: 0, approx: [], ids: new Map() };

  const match = alignWords(tokens.words, words.map((w) => w.w));
  const plans = planPlacements(tokens, words.length, match);
  const before = new Map<string, ImgItem[]>();
  const after = new Map<string, ImgItem[]>();
  const ids = new Map<Placement, string>();
  for (const pl of plans) {
    const item: ImgItem = { k: "img", id: newId(), path: pl.img.path, name: pl.img.name, from: "script", ...(pl.approx ? { approx: true } : {}) };
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
  return { doc: { ...doc, items }, placed: plans.length, approx: plans.filter((p) => p.approx), ids };
}

/** Senaryoda resim var mı? */
export const scriptHasImages = (editorDoc: any) => scriptTokens(editorDoc).images.length > 0;

// ---------------------------------------------------------------------------------------------------------------
// AI ile yaklaşık resimlerin yerini bulma

export const IMAGE_PLACE_PROMPT = `Sen bir video kurgu asistanısın. Yazar bir senaryo yazdı ve içine resimler ekledi; sonra senaryoyu seslendirdi ve konuşma kelime kelime zamanlı yazıya çevrildi. Görevin: her resmin, konuşmada hangi kelimeden itibaren ekranda gösterilmesi gerektiğini bulmak.

Senaryoda ⟦RESİM k⟧ işareti resmin yeridir: resim, işaretten hemen sonraki senaryo metni söylenmeye başladığında gösterilir (işaret paragrafın sonundaysa, önündeki metnin hemen arkası). Konuşmada aynı yeri bul. Yazar senaryodan sapmış, cümleleri farklı söylemiş, tekrar etmiş ya da dolgu sesleri eklemiş olabilir; anlamca eşleştir. Bir cümle birden çok kez söylendiyse son (tamamlanmış) söyleyişi seç. Resim adı ve notu varsa ipucu olarak kullan.

Konuşma kelimeleri \`numara [dakika:saniye.salise] kelime\` biçimindedir. Yalnızca JSON döndür, açıklama yazma:
{"images":[{"k":1,"n":123}]}
n: resmin gösterilmeye başlayacağı kelimenin numarası (verilen numaralardan biri). Konuşmada hiç karşılığı yoksa en yakın anlamlı yeri seç.`;

const SCRIPT_CONTEXT = 60; // resmin iki yanında gönderilecek senaryo kelimesi
const WIN_PAD = 25;
const MAX_WIN = 1500; // tek istekte gönderilecek en fazla konuşma kelimesi

interface Group {
  plans: Placement[];
  from: number;
  to: number;
}

/** Yaklaşık resimleri, konuşma aralıkları örtüşenleri tek istekte toplayarak gruplar. */
export function groupApprox(approx: Placement[], spokenCount: number): Group[] {
  const groups: Group[] = [];
  const sorted = [...approx].sort((a, b) => a.img.pos - b.img.pos);
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

/** Bir grup için AI'a gidecek kullanıcı mesajı. Resimler grupta 1'den numaralanır. */
export function buildPlaceRequest(group: Group, tokens: ScriptTokens, spoken: { n: number; w: string; s: number }[], meta: Record<string, ImageMeta>): string {
  const first = group.plans[0].img.pos;
  const last = group.plans[group.plans.length - 1].img.pos;
  const a = Math.max(0, first - SCRIPT_CONTEXT);
  const b = Math.min(tokens.words.length, last + SCRIPT_CONTEXT);
  const marks = new Map<number, number[]>();
  group.plans.forEach((pl, i) => marks.set(pl.img.pos, [...(marks.get(pl.img.pos) ?? []), i + 1]));
  const parts: string[] = [];
  if (a > 0) parts.push("…");
  for (let k = a; k <= b; k++) {
    for (const n of marks.get(k) ?? []) parts.push(`⟦RESİM ${n}⟧`);
    if (k < b) parts.push(tokens.words[k]);
  }
  if (b < tokens.words.length) parts.push("…");
  const info = group.plans.map((pl, i) => {
    const note = meta[pl.img.path]?.note?.replace(/\s+/g, " ").trim();
    return `RESİM ${i + 1}: ${pl.img.name}${note ? ` — not: ${note}` : ""}`;
  });
  const lines = spoken.slice(group.from, group.to + 1).map((w) => `${w.n} [${fmtTime(w.s, 1)}] ${w.w}`);
  return `Senaryo (ilgili kısım):\n${parts.join(" ")}\n\nResimler:\n${info.join("\n")}\n\nKonuşma kelimeleri:\n${lines.join("\n")}`;
}

/** AI yanıtından resim → kelime numarası eşlemesini ayıklar; aralık dışındakiler atlanır. */
export function parsePlaceReply(text: string, count: number, minN: number, maxN: number): Map<number, number> {
  const out = new Map<number, number>();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return out;
  let list: unknown;
  try {
    list = (JSON.parse(text.slice(start, end + 1)) as { images?: unknown }).images;
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
 * Yaklaşık yerleşen resimleri AI'a sorar. Dönen eşleme: resim öğesi kimliği → önüne konacağı kelime kimliği.
 * Bir grup başarısız olursa o gruptaki resimler yaklaşık konumda kalır.
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
        baseUrl: s.baseUrl,
        model: s.model,
        system: IMAGE_PLACE_PROMPT,
        user: buildPlaceRequest(group, tokens, spoken, meta),
        temperature: 0,
      }).done;
      const got = parsePlaceReply(text, group.plans.length, spoken[group.from].n, spoken[group.to].n);
      group.plans.forEach((pl, i) => {
        const n = got.get(i + 1);
        const imgId = ids.get(pl);
        if (n === undefined || !imgId) return void failed++;
        moves.set(imgId, spoken[n - 1].id);
      });
    } catch {
      failed += group.plans.length;
    }
    onProgress?.(g + 1, groups.length);
  }
  return { moves, failed };
}

/** Resimleri verilen kelimelerin önüne taşır ve "yaklaşık" işaretini kaldırır. Silinmiş resim/kelime atlanır. */
export function applyMoves(items: TimedItem[], moves: Map<string, string>): TimedItem[] {
  const words = new Set(items.filter((i) => i.k === "w").map((i) => (i as { id: string }).id));
  const moving = new Map<string, ImgItem[]>();
  const taken = new Set<string>();
  for (const it of items) {
    if (it.k !== "img") continue;
    const target = moves.get(it.id);
    if (!target || !words.has(target)) continue;
    const { approx: _, ...rest } = it;
    moving.set(target, [...(moving.get(target) ?? []), rest]);
    taken.add(it.id);
  }
  if (!taken.size) return items;
  const out: TimedItem[] = [];
  for (const it of items) {
    if (it.k === "img" && taken.has(it.id)) continue;
    if (it.k === "w") out.push(...(moving.get(it.id) ?? []));
    out.push(it);
  }
  return out;
}
