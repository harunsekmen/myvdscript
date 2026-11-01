import { api } from "./api";

interface Speech {
  lang: string;
  audio: string;
}

let player: HTMLAudioElement | null = null;
const cache = new Map<string, Speech>();

export function stop() {
  player?.pause();
  player = null;
  window.speechSynthesis?.cancel();
}

function speakSystem(text: string, lang: string): boolean {
  const synth = window.speechSynthesis;
  const voice = synth?.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase().split("-")[0]));
  if (!voice) return false;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = voice.lang;
  u.voice = voice;
  u.rate = 0.9;
  synth.speak(u);
  return true;
}

/**
 * Metni dilini otomatik algılayarak okur: önce ücretsiz bulut sesi, olmazsa sistem sesi.
 * Hiçbiri çalışmazsa false döner.
 */
export async function speak(text: string): Promise<boolean> {
  if (!text.trim()) return false;
  stop();
  let sp = cache.get(text);
  try {
    if (!sp) {
      sp = await api.tts(text);
      cache.set(text, sp);
    }
    player = new Audio(`data:audio/mpeg;base64,${sp.audio}`);
    await player.play();
    return true;
  } catch {
    return speakSystem(text, sp?.lang ?? "en");
  }
}
