import { describe, expect, it } from "vitest";
import { PipelineError, processTranscript, RETRY_DELAYS, type PipelineDeps } from "./pipeline";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts";
import { chunkText } from "./segmentParser";
import type { Settings } from "./types";

const settings = { baseUrl: "u", model: "m", temperature: 0, systemPrompt: DEFAULT_SYSTEM_PROMPT, chunkChars: 20 } as Settings;
// Her satır ayrı bir parça olur (cümle sonu noktalı, parça sınırı 20 karakter).
const transcript = Array.from({ length: 4 }, (_, i) => `[00:0${i}] Cumle ${i} bitti.`).join("\n");

type Handle = { done: Promise<string>; cancel: () => void };
const ok = (text: string): Handle => ({ done: Promise.resolve(text), cancel: () => {} });
const fail = (msg: string): Handle => {
  const done = Promise.reject(new Error(msg));
  done.catch(() => {});
  return { done, cancel: () => {} };
};

/** Sırayla verilen yanıtları döndüren sahte sohbet; çağrılan kullanıcı mesajlarını ve beklemeleri kaydeder. */
function fake(script: Array<() => Handle>) {
  const sleeps: number[] = [];
  const calls: string[] = [];
  let n = 0;
  const deps: Partial<PipelineDeps> = {
    chat: ((o: { user: string }) => {
      calls.push(o.user);
      return script[Math.min(n++, script.length - 1)]();
    }) as PipelineDeps["chat"],
    sleep: async (ms) => void sleeps.push(ms),
  };
  return { deps, sleeps, calls };
}

const body = (i: number) => `### [KONU: K${i}]\n[00:0${i}] Metin ${i}.`;
const noop = () => {};

describe("işleme hattı: yeniden deneme", () => {
  it("parçalama beklendiği gibi", () => {
    expect(chunkText(transcript, 20)).toHaveLength(4);
  });

  it("geçici hatada 2 sn ve 5 sn bekleyip aynı parçayı tekrar dener", async () => {
    const f = fake([() => fail("ağ"), () => fail("ağ"), () => ok(body(0))]);
    const segs = await processTranscript("[00:00] Tek parca.", settings, noop, noop, { deps: f.deps }).promise;
    expect(f.sleeps).toEqual(RETRY_DELAYS);
    expect(f.calls).toHaveLength(3);
    expect(segs[0].title).toBe("K0");
  });

  it("iki yeniden denemeden sonra da başarısızsa PipelineError ile devam durumu döner", async () => {
    const f = fake([() => ok(body(0)), () => fail("sunucu")]);
    const err = (await processTranscript(transcript, settings, noop, noop, { deps: f.deps }).promise.catch((e) => e)) as PipelineError;
    expect(err).toBeInstanceOf(PipelineError);
    expect(err.message).toBe("sunucu");
    expect(err.cancelled).toBe(false);
    expect(err.resume.next).toBe(1);
    expect(err.resume.acc).toContain("K0");
    expect(err.partial[0].title).toBe("K0");
    expect(f.calls).toHaveLength(1 + 3); // 1 başarılı + ilk deneme + 2 yeniden deneme
  });
});

describe("işleme hattı: devam etme", () => {
  it("kaldığı parçadan devam eder; önceki çıktıyı korur, kayıtlı ayarları kullanır", async () => {
    const first = fake([() => ok(body(0)), () => ok(body(1)), () => fail("x")]);
    const err = (await processTranscript(transcript, settings, noop, noop, { deps: first.deps }).promise.catch((e) => e)) as PipelineError;
    expect(err.resume.next).toBe(2);

    const progress: number[] = [];
    const second = fake([() => ok(body(2)), () => ok(body(3))]);
    const segs = await processTranscript("(yoksayılır)", { ...settings, model: "başka" }, noop, (p) => progress.push(p.done), {
      resume: err.resume,
      deps: second.deps,
    }).promise;
    expect(second.calls).toHaveLength(2); // yalnız kalan 2 parça
    expect(second.calls[0]).toContain("Cumle 2");
    expect(segs.map((s) => s.title)).toEqual(["K0", "K1", "K2", "K3"]);
    expect(progress).toEqual([2, 3, 4]);
  });

  it("iptal edilince tekrar denemez; beklerken iptal anında sonuçlanır ve devam durumu verir", async () => {
    let wokenBySleep = false;
    const sleepy: Partial<PipelineDeps> = {
      chat: (() => fail("ağ")) as PipelineDeps["chat"],
      sleep: () => new Promise<void>(() => void (wokenBySleep = true)), // hiç bitmez
    };
    const run = processTranscript("[00:00] Tek parca.", settings, noop, noop, { deps: sleepy });
    await new Promise((r) => setTimeout(r, 5));
    expect(wokenBySleep).toBe(true);
    run.cancel();
    const err = (await run.promise.catch((e) => e)) as PipelineError;
    expect(err.cancelled).toBe(true);
    expect(err.message).toBe("İptal edildi");
    expect(err.resume.next).toBe(0);
  });
});
