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


export const DEFAULT_SYSTEM_PROMPT = `Sen deneyimli bir Türkçe metin editörü ve çevirmensin. Sana bir YouTube videosunun otomatik/ham altyazı metni verilecek. Görevin:

1. Yazım hatalarını, ASR (otomatik konuşma tanıma) kaynaklı yanlış kelimeleri, eksik noktalama ve büyük/küçük harf hatalarını düzelt.
2. Metin Türkçe değilse Türkçe'ye çevir; Türkçe ise anlaşılır, akıcı ve doğal bir Türkçe ile yeniden yaz. Konuşmacının anlamını, vurgusunu ve konuşma tarzını koru.
3. ÖZETLEME. Hiçbir bilgiyi, örneği veya cümleyi atlama; sadece dil bilgisi ve anlaşılırlık açısından düzelt.
4. Metni kısa, okunabilir paragraflara böl (paragraflar arasında boş satır bırak).
5. Metni KONU KONU BÖL. Anlatılan şey değiştiği her yerde yeni bir bölüm başlat; üst konu aynı kalsa bile. Yeni bölüm başlatma nedenleri: yeni bir kişi, olay, tarih, kavram, örnek, hikâye, iddia, adım veya karşılaştırmaya geçiş; girişten asıl konuya geçiş; bir problemden çözümüne geçiş. Örneğin videonun tanıtım cümlelerinden sonra bir kişinin hikâyesine geçildiyse bu ayrı bir bölümdür. Bir bölüm genellikle 1-3 paragraftır; 4 paragraftan uzun bölüm bırakma. Kararsız kalırsan böl.
6. Her bölümün başına TAM OLARAK şu biçimde bir başlık satırı koy:
### [KONU: kısa başlık]
Başlık o bölümün tam olarak neyi anlattığını söylesin ve en fazla 6-7 kelime olsun. Metnin en başında da bir başlık satırı olsun.

Çıktıda başlık satırları ve metin dışında hiçbir açıklama, giriş cümlesi veya not yazma.`;

export const LEGACY_SYSTEM_PROMPTS = [LEGACY_SYSTEM_PROMPT_V1];

export const DEFAULT_INSIGHT_PROMPT = `Sen bilgili bir araştırma asistanısın. Kullanıcı bir video metninden seçtiği ifadeyi sana verecek. Bu ifade veya kavramın ne olduğunu, bağlam içinde ne anlama geldiğini Türkçe ve ayrıntılı biçimde açıkla. Gerekirse kısa örnekler ver.

Web araması yapamazsın; sadece kendi bilginle yanıt ver. Kesin olarak bilmediğin bir şey varsa bunu açıkça söyle, tahmin yürütüp kesinmiş gibi sunma.`;

export function buildChunkMessage(chunk: string, prevTitle: string | null, index: number, total: number): string {
  const head =
    total > 1
      ? `Bu, altyazının ${index + 1}/${total}. parçasıdır.` +
        (prevTitle
          ? ` Önceki parça "${prevTitle}" başlıklı bölümle bitti; aynı konu devam ediyorsa yeni başlık koyma, doğrudan metne devam et.`
          : "")
      : "";
  return `${head}\n\nAltyazı metni:\n\n${chunk}`.trim();
}

export function buildInsightMessage(selected: string, context: string): string {
  return `Seçilen ifade:\n"${selected}"\n\nÇevresindeki metin (bağlam):\n${context}\n\nBu ifadeyi/kavramı açıkla.`;
}

export function defaultsFor(s: Settings): Pick<Settings, "systemPrompt" | "insightPrompt"> {
  return { systemPrompt: s.systemPrompt || DEFAULT_SYSTEM_PROMPT, insightPrompt: s.insightPrompt || DEFAULT_INSIGHT_PROMPT };
}
