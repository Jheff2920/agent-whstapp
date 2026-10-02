import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertKnowledgeReady, KnowledgeStore, loadKnowledge, searchCatalog } from "../src/knowledge/loader.js";
import { FIXTURE_KNOWLEDGE } from "./helpers.js";

describe("conocimiento", () => {
  it("las plantillas del repo están pendientes (nada inventado)", () => {
    const k = loadKnowledge(new URL("../knowledge", import.meta.url).pathname);
    expect(k.pending.sort()).toEqual(["catalog.json", "empresa.md", "resenas.md"]);
    expect(() => assertKnowledgeReady(k, "production")).toThrow("Falta completar");
    expect(() => assertKnowledgeReady(k, "development")).not.toThrow();
  });
  it("los fixtures cargan completos", () => {
    const k = loadKnowledge(FIXTURE_KNOWLEDGE);
    expect(k.pending).toEqual([]);
    expect(k.catalog).toHaveLength(2);
  });
  it("busca sin importar tildes ni mayúsculas", () => {
    const { catalog } = loadKnowledge(FIXTURE_KNOWLEDGE);
    expect(searchCatalog(catalog, "INSTALACIÓN").map((i) => i.id)).toEqual(["B"]);
    expect(searchCatalog(catalog, "zzz")).toEqual([]);
    expect(searchCatalog(catalog, "a")).toEqual([]);
  });
  it("un catálogo inválido falla con mensaje claro", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kn-"));
    fs.writeFileSync(path.join(dir, "catalog.json"), "{ no es json");
    expect(() => loadKnowledge(dir)).toThrow("catalog.json inválido");
    fs.writeFileSync(path.join(dir, "catalog.json"), '{"a":1}');
    expect(() => loadKnowledge(dir)).toThrow("debe ser una lista");
  });
  it("recarga al cambiar los archivos", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kn-"));
    fs.writeFileSync(path.join(dir, "empresa.md"), "Hola");
    const store = new KnowledgeStore(dir);
    expect(store.get().empresa).toBe("Hola");
    fs.writeFileSync(path.join(dir, "empresa.md"), "Chao");
    fs.utimesSync(path.join(dir, "empresa.md"), new Date(), new Date(Date.now() + 5000));
    expect(store.get().empresa).toBe("Chao");
  });
});
