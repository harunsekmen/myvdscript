import type { Settings } from "./types";

const LEGACY_SYSTEM_PROMPT_V1 = `Sen deneyimli bir Türkçe metin editörü ve çevirmensin. Sana bir YouTube videosunun otomatik/ham altyazı metni verilecek. Görevin:

1. Yazım hatalarını, ASR (otomatik konuşma tanıma) kaynaklı yanlış kelimeleri, eksik noktalama ve büyük/küçük harf hatalarını düzelt.
2. Metin Türkçe değilse Türkçe'ye çevir; Türkçe ise anlaşılır, akıcı ve doğal bir Türkçe ile yeniden yaz. Konuşmacının anlamını, vurgusunu ve konuşma tarzını koru.
3. ÖZETLEME. Hiçbir bilgiyi, örneği veya cümleyi atlama; sadece dil bilgisi ve anlaşılırlık açısından düzelt.
4. Metni okunabilir paragraflara böl (paragraflar arasında boş satır bırak).
5. Konu veya bölüm değiştiği her yerde, yeni bölümün başına TAM OLARAK şu biçimde bir başlık satırı koy:
### [KONU: kısa başlık]
Başlık en fazla 6-7 kelime olsun. Metnin en başında da bir başlık satırı olsun.

Çıktıda başlık satırları ve metin dışında hiçbir açıklama, giriş cümlesi veya not yazma.`;


const LEGACY_SYSTEM_PROMPT_V2 = `Sen deneyimli bir Türkçe metin editörü ve çevirmensin. Sana bir YouTube videosunun otomatik/ham altyazı metni verilecek. Görevin:

1. Yazım hatalarını, ASR (otomatik konuşma tanıma) kaynaklı yanlış kelimeleri, eksik noktalama ve büyük/küçük harf hatalarını düzelt.
2. Metin Türkçe değilse Türkçe'ye çevir; Türkçe ise anlaşılır, akıcı ve doğal bir Türkçe ile yeniden yaz. Konuşmacının anlamını, vurgusunu ve konuşma tarzını koru.
3. ÖZETLEME. Hiçbir bilgiyi, örneği veya cümleyi atlama; sadece dil bilgisi ve anlaşılırlık açısından düzelt.
4. Metni kısa, okunabilir paragraflara böl (paragraflar arasında boş satır bırak).
5. Metni KONU KONU BÖL. Anlatılan şey değiştiği her yerde yeni bir bölüm başlat; üst konu aynı kalsa bile. Yeni bölüm başlatma nedenleri: yeni bir kişi, olay, tarih, kavram, örnek, hikâye, iddia, adım veya karşılaştırmaya geçiş; girişten asıl konuya geçiş; bir problemden çözümüne geçiş. Örneğin videonun tanıtım cümlelerinden sonra bir kişinin hikâyesine geçildiyse bu ayrı bir bölümdür. Bir bölüm genellikle 1-3 paragraftır; 4 paragraftan uzun bölüm bırakma. Kararsız kalırsan böl.
6. Her bölümün başına TAM OLARAK şu biçimde bir başlık satırı koy:
### [KONU: kısa başlık]
Başlık o bölümün tam olarak neyi anlattığını söylesin ve en fazla 6-7 kelime olsun. Metnin en başında da bir başlık satırı olsun.

Çıktıda başlık satırları ve metin dışında hiçbir açıklama, giriş cümlesi veya not yazma.`;

export const DEFAULT_SYSTEM_PROMPT = `Sen deneyimli bir Türkçe metin editörü ve çevirmensin. Sana bir YouTube videosunun otomatik/ham altyazı metni verilecek. Görevin:

1. Yazım hatalarını, ASR (otomatik konuşma tanıma) kaynaklı yanlış kelimeleri, eksik noktalama ve büyük/küçük harf hatalarını düzelt.
2. Metin Türkçe değilse Türkçe'ye çevir; Türkçe ise anlaşılır, akıcı ve doğal bir Türkçe ile yeniden yaz. Konuşmacının anlamını, vurgusunu ve konuşma tarzını koru.
3. ÖZETLEME. Hiçbir bilgiyi, örneği veya cümleyi atlama; sadece dil bilgisi ve anlaşılırlık açısından düzelt. (Sponsorlu kısımlar bu kuralın dışındadır; 7. maddeye bak.)
4. Metni kısa, okunabilir paragraflara böl (paragraflar arasında boş satır bırak).
5. Metni KONU KONU BÖL. Anlatılan şey değiştiği her yerde yeni bir bölüm başlat; üst konu aynı kalsa bile. Yeni bölüm başlatma nedenleri: yeni bir kişi, olay, tarih, kavram, örnek, hikâye, iddia, adım veya karşılaştırmaya geçiş; girişten asıl konuya geçiş; bir problemden çözümüne geçiş. Örneğin videonun tanıtım cümlelerinden sonra bir kişinin hikâyesine geçildiyse bu ayrı bir bölümdür. Bir bölüm genellikle 1-3 paragraftır; 4 paragraftan uzun bölüm bırakma. Kararsız kalırsan böl.
6. Her bölümün başına TAM OLARAK şu biçimde bir başlık satırı koy:
### [KONU: kısa başlık]
Başlık o bölümün tam olarak neyi anlattığını söylesin ve en fazla 6-7 kelime olsun. Metnin en başında da bir başlık satırı olsun.

7. SPONSORLU KISIMLAR: Sponsor okumalarını ve reklam bölümlerini (ör. "bu video ... tarafından desteklenmektedir", sponsor veya iş birliği tanıtımı, ürün ya da hizmet reklamı, indirim kodu, "açıklama kutusundaki bağlantıya tıkla" gibi reklam çağrıları) metinden çıkar. Bunların yerine tam olarak şu yer tutucuyu yaz: [sponsorlu kısım gizlendi]. Yer tutucu için ayrı bir konu başlığı açma; bulunduğu bölümün içinde kendi paragrafında dursun. Sponsor olmayan anlatım, örnek ve bilgiler aynen korunur.
8. TERİMLER VE İSİMLER: Yazılım, teknoloji ve alan terimleri (ör. framework, deploy, API, startup, cloud, prompt, template), yabancı dilde yaygın kullanılan kelimeler, marka, ürün, uygulama, kişi, yer ve kurum adları ÇEVRİLMEZ; metinde olduğu gibi kalır. Bu kural 2. maddedeki Türkçe'ye çevirme kuralından önceliklidir. Bir terimin çevirisi gerçekten gerekliyse terim korunur ve çevirisi parantez içinde yazılır, ör. "deploy (yayına alma)". Her terimi çevirmek zorunda değilsin; çeviri yalnızca anlaşılırlık için gerekli olduğunda eklenir.

Çıktıda başlık satırları ve metin dışında hiçbir açıklama, giriş cümlesi veya not yazma.`;

export const LEGACY_SYSTEM_PROMPTS = [LEGACY_SYSTEM_PROMPT_V1, LEGACY_SYSTEM_PROMPT_V2];

export const DEFAULT_INSIGHT_PROMPT = `Sen bilgili bir araştırma asistanısın. Kullanıcı bir video metninden seçtiği ifadeyi sana verecek. Bu ifade veya kavramın ne olduğunu, bağlam içinde ne anlama geldiğini Türkçe ve ayrıntılı biçimde açıkla. Gerekirse kısa örnekler ver.

Web araması yapamazsın; sadece kendi bilginle yanıt ver. Kesin olarak bilmediğin bir şey varsa bunu açıkça söyle, tahmin yürütüp kesinmiş gibi sunma.`;

/** Altyazı satırlarındaki [dk:sn] işaretleri (satırın videodaki zamanı) varsa AI'ın cümlelere taşıması gerekir. */
const TIMED_CHUNK = /\[\d{1,4}:\d{2}\]/;

export const TIME_RULE = `ZAMAN İŞARETLERİ (zorunlu): Altyazı satırları [dk:sn] işaretiyle başlar; bu, o satırın videodaki zamanıdır. Çıktıdaki HER cümlenin başına, o cümlenin kaynaklandığı altyazı satırının işaretini aynen yaz (ör. "[01:23] Cümle metni."). Cümle birden çok satıra yayılıyorsa başladığı satırın işaretini kullan. İşaretleri değiştirme, uydurma, atlama veya cümlenin ortasına koyma. Başlık satırlarında ve sponsor yer tutucusunda işaret kullanma.`;

export function buildChunkMessage(chunk: string, prevTitle: string | null, index: number, total: number): string {
  const head =
    total > 1
      ? `Bu, altyazının ${index + 1}/${total}. parçasıdır.` +
        (prevTitle
          ? ` Önceki parça "${prevTitle}" başlıklı bölümle bitti; aynı konu devam ediyorsa yeni başlık koyma, doğrudan metne devam et.`
          : "")
      : "";
  const rule = TIMED_CHUNK.test(chunk) ? `\n\n${TIME_RULE}` : "";
  return `${head}${rule}\n\nAltyazı metni:\n\n${chunk}`.trim();
}

/**
 * "Özel istemle işle": mevcut sistem istemi (ayarlardaki) olduğu gibi kalır; kullanıcının istemi
 * ek talimat olarak sonuna eklenir. Böylece sponsor, terim, konu bölme ve biçim kuralları düşmez.
 */
export function buildCustomRunSystemPrompt(baseSystem: string, userPrompt: string): string {
  const extra = userPrompt.trim();
  if (!extra) return baseSystem;
  return (
    `${baseSystem.trim()}\n\n` +
    `EK ÖZEL İSTEK (kullanıcının bu işleme özel talimatı): Yukarıdaki tüm kurallara ek olarak uygula. ` +
    `Zaman işaretleri ve başlık satırı biçimi (### [KONU: ...]) her zaman korunur; bu istek onlarla çelişirse uygulanmaz.\n` +
    extra
  );
}

/** Varsayılan üslup kılavuzu: senin altyazılarında gözlenen kalıplardan çıkarıldı, hiçbir kaynak metin içermez. */
export const DEFAULT_STYLE_GUIDE = `- Cümleleri kısa tut (ortalama 10 kelime civarı); uzun cümleyi iki parçaya böl.
- Geçişlerde "peki" ve "yani" kullan; her paragraf tek bir fikirle açılsın.
- Hitap zamiri (sen, siz) kullanma; birinci tekil anlatıcı sesiyle yaz ("göstereceğim" gibi).
- Konuya bazen retorik bir soruyla gir, ardından yanıtla.
- Yazılım ve teknoloji terimlerini (runtime, garbage collector, deploy, framework, Stack Overflow gibi) İngilizce bırak, çevirme.
- Sayıları, yüzdeleri ve tarihleri aynen koru.
- Ünlem ve abartılı ifadelerden kaçın.`;

export const MAX_STYLE_EXAMPLES = 5;
const MAX_STYLE_CHARS = 1200; // her örnek alanı için üst sınır (istek başına tekrar gönderildiği için)

const clip = (s: string) => (s.length > MAX_STYLE_CHARS ? s.slice(0, MAX_STYLE_CHARS) + "…" : s);

/** Anlatım tarzı bloğu: kılavuz + örnek çiftleri. İkisi de boşsa boş metin döner. */
export function buildStyleBlock(guide: string, examples: { source: string; target: string }[]): string {
  const g = guide.trim();
  const pairs = examples
    .filter((e) => e.source.trim() && e.target.trim())
    .slice(0, MAX_STYLE_EXAMPLES);
  if (!g && !pairs.length) return "";
  const parts = ["ANLATIM TARZI (zorunlu):", "Çıktıyı aşağıdaki konuşmacının üslubuyla yaz. Bu kural, genel çeviri ve sadeleştirme kurallarında belirtilen üslup tercihlerinin önüne geçer; anlamı değiştirme, yalnızca üslubu uygula."];
  if (g) parts.push(`Üslup kılavuzu:\n${g}`);
  if (pairs.length) {
    parts.push(
      "Örnekler (kaynak → istenen Türkçe çıktı). Bu örneklerin üslubunu, cümle uzunluğunu ve geçiş kelimelerini taklit et; örneklerin içeriğini çıktıya kopyalama:\n" +
        pairs.map((e, i) => `Örnek ${i + 1}\nKaynak: ${clip(e.source.trim())}\nÇıktı: ${clip(e.target.trim())}`).join("\n\n"),
    );
  }
  return parts.join("\n\n");
}

/** Pipeline'a giden sistem prompt'u: temel istem + (varsa) anlatım tarzı bloğu. */
export function buildSystemWithStyle(s: { systemPrompt: string; styleGuide?: string; styleExamples?: { source: string; target: string }[] }): string {
  const block = buildStyleBlock(s.styleGuide ?? "", s.styleExamples ?? []);
  return block ? `${s.systemPrompt.trim()}\n\n${block}` : s.systemPrompt;
}

export const CUSTOM_PROMPT_PLACEHOLDER = "Örn: Bu metni daha kısa ve akıcı bir Türkçe ile yeniden yaz. Teknik terimleri koru.";

export const WORD_CHECK_PROMPT =`Sen bir transkript düzeltme asistanısın. Sana konuşma tanıma (ASR) ile üretilmiş, kelime kelime zamanlı bir metin verilecek. Her satır şu biçimdedir: \`numara [dakika:saniye.salise] kelime\`. Zaman, o kelimenin konuşulduğu andır; bağlamı anlamak için kullan. Metnin dilini kendin algıla.

Görevin: YALNIZCA açıkça yanlış duyulmuş, yazım hatası içeren ya da bağlama hiç uymayan kelimeleri bulmak ve doğru halini önermek.

Kurallar:
- Emin olmadığın kelimeye dokunma. Konuşmacının gerçekten söylediğini tahmin et, süsleme yapma.
- Noktalama, büyük/küçük harf ve üslup düzeltmesi önerme; yalnızca kelime hatalarını düzelt.
- Her öneri tek bir kelime olsun (gerekirse en fazla üç kelimelik kısa bir ifade).
- Kelime ekleme, silme ya da yeniden sıralama önerme.
- Yanıtı YALNIZCA şu JSON biçiminde ver, başka hiçbir şey yazma:
{"fixes":[{"n":12,"to":"doğru kelime"}]}
Hiç düzeltme gerekmiyorsa: {"fixes":[]}`;

export function buildInsightMessage(selected: string, context: string): string {
  return `Seçilen ifade:\n"${selected}"\n\nÇevresindeki metin (bağlam):\n${context}\n\nBu ifadeyi/kavramı açıkla.`;
}

export function defaultsFor(s: Settings): Pick<Settings, "systemPrompt" | "insightPrompt"> {
  return { systemPrompt: s.systemPrompt || DEFAULT_SYSTEM_PROMPT, insightPrompt: s.insightPrompt || DEFAULT_INSIGHT_PROMPT };
}
