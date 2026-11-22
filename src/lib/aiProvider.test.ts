import { describe, expect, it } from "vitest";
import { activeModel, migrateProvider, providerOptions } from "./aiProvider";
import { DEFAULT_SETTINGS } from "./settingsDefaults";

describe("metin sağlayıcısı", () => {
  it("yeni ayarda Codex varsayılanını seçer ve eski API ayarını korur", () => {
    expect(migrateProvider({})).toBe("codex");
    expect(migrateProvider({ model: "önceki" })).toBe("api");
    expect(migrateProvider({ aiProvider: "codex", model: "önceki" })).toBe("codex");
    expect(activeModel(DEFAULT_SETTINGS)).toBe("Codex");
  });

  it("Codex modeli ile API yedek modelini ayrı tutar", () => {
    const settings = { ...DEFAULT_SETTINGS, codexModel: "yerel-cli", model: "api-model" };
    const options = providerOptions(settings, { model: "seçilen-cli" });
    expect(options.codex?.model).toBe("seçilen-cli");
    expect(options.model).toBe("api-model");
    expect(options.apiFallback).toBe(true);
    expect(providerOptions({ ...settings, aiProvider: "api" }).codex).toBeNull();
  });
});
