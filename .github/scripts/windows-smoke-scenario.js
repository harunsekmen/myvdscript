// The Windows smoke job loads this script only in its disposable frontend build.
const invoke = (command, args = {}) => window.__TAURI_INTERNALS__.invoke(command, args);
const report = (message) => invoke("save_text_file", { path: resultPath, contents: JSON.stringify(message) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shown = (label) => document.body.innerText.includes(label);

async function wait(label, find) {
  const until = Date.now() + 20_000;
  for (; Date.now() < until; await sleep(120)) {
    const result = await find();
    if (result) return result;
  }
  throw new Error(`Beklenen adım: ${label}`);
}

async function press(label) {
  await wait(label, () => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (item) => !item.disabled && item.innerText.trim().replace(/\s+/g, " ").startsWith(label),
    );
    if (!button) return false;
    button.click();
    return true;
  });
}

const require = (condition, result) => {
  if (!condition) throw new Error(result);
};

async function scenario() {
  await wait("ana sayfa", () => shown("Linkten başlat"));
  const title = "Windows QA 0.2";
  let id = sessionStorage.getItem("smoke-project");
  if (!id) {
    await report({ step: "home" });
    await invoke("save_settings", {
      settings: { aiProvider: "api", baseUrl: "http://127.0.0.1:13947/v1", model: "smoke", sttEngine: "local" },
    });
    const initial = await invoke("create_project", { title, url: "" });
    await invoke("save_project", { project: {
      ...initial,
      sources: [
        { id: "one", url: "", title: "Bir", transcriptRaw: "[00:05] Bir kaynak iddiası.\n[00:25] İkinci cümle.", segments: [], insights: [], createdAt: 1 },
        { id: "two", url: "", title: "İki", transcriptRaw: "[00:25] İkinci kaynak.", segments: [], insights: [], createdAt: 1 },
      ],
      activeSourceId: "one",
      editorDoc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Windows veri testi." }] }] },
    } });
    sessionStorage.setItem("smoke-project", initial.id);
    location.reload();
    return;
  }

  await wait("proje kartı", () => {
    const card = Array.from(document.querySelectorAll(".kcard")).find((node) => node.textContent.includes(title));
    if (!card) return false;
    card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  });
  await press("Yeniden işle");
  await press("Yeniden işle Varsayılan");
  await wait("Türkçe kaynak metin", () => shown("İkinci zamanlı cümle."));
  await report({ step: "transcript" });

  await wait("iddia seçimi", () => {
    if (shown("İddiayı doğrula")) return true;
    const paragraph = document.querySelector("p[data-para]");
    if (!paragraph) return false;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return false;
  });
  await press("İddiayı doğrula");
  await wait("kanıtsız iddia etiketi", () => shown("Doğrulanamadı"));
  await report({ step: "factcheck" });

  await press("Sentez");
  await press("Sentezle");
  await wait("sentez çıktısı", () => shown("Kaynak sentezi doğrulaması"));
  await press("Editöre aktar");
  await wait("editör aktarımı", () => document.querySelector(".tiptap")?.innerText.includes("Senaryo metni."));
  await press("Yayın");
  await press("Yayın bilgilerini üret");

  const saved = await wait("yayın kaydı", async () => {
    const data = await invoke("load_project", { id });
    return data.publish?.tags?.length === 10 ? data : null;
  });
  require(saved.publish.titles.length === 5, "Beş başlık bekleniyordu");
  require(saved.syntheses[0].citations.length === 2, "İki altyazı atfı bekleniyordu");
  require(saved.sources[0].insights[0].results[0].verdict === "unverified", "İddia sonucu kaydedilmedi");
  require(JSON.stringify(saved.editorDoc).includes("Kaynak sentezi doğrulaması"), "Aktarılan metin kaydedilmedi");
  const backups = await invoke("list_backups", { projectId: id });
  require(backups.length === 1, "Bir günlük yedek bekleniyordu");
  await report({ step: "done", passed: ["transcript", "factcheck", "synthesis", "editor", "publish", "backup"] });
}

setTimeout(() => scenario().catch(async (error) => {
  await report({ step: "error", reason: String(error), page: document.body?.innerText.slice(0, 800) });
}), 0);
