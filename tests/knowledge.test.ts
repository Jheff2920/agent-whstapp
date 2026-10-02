import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertKnowledgeReady, catalogIndex, KnowledgeStore, loadKnowledge, priceText, searchCatalog } from "../src/knowledge/loader.js";
import { FIXTURE_KNOWLEDGE } from "./helpers.js";

const REAL_KNOWLEDGE = new URL("../knowledge", import.meta.url).pathname;

describe("conocimiento", () => {
  it("el conocimiento real tiene pendientes lo que aún no se entregó (nada inventado)", () => {
    const k = loadKnowledge(REAL_KNOWLEDGE);
    expect(k.pending.sort()).toEqual(["empresa.md", "resenas.md"]);
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

describe("catálogo real de Red Soluciones", () => {
  const { catalog } = loadKnowledge(REAL_KNOWLEDGE);
  const str = (v: unknown) => String(v);

  it("tiene los 82 productos del catálogo 2026 con campos completos e ids únicos", () => {
    expect(catalog).toHaveLength(82);
    expect(new Set(catalog.map((i) => i.id)).size).toBe(82);
    for (const item of catalog) {
      expect(item.categoria, str(item.id)).toBeTruthy();
      expect(item.marca, str(item.id)).toBeTruthy();
      expect(item.modelo, str(item.id)).toBeTruthy();
      expect((item.caracteristicas as string[]).length, str(item.id)).toBeGreaterThan(0);
      expect(priceText(item), str(item.id)).toMatch(/S\/\d/);
    }
    expect(new Set(catalog.map((i) => i.categoria)).size).toBe(16);
  });

  it("precios y datos clave coinciden con el catálogo", () => {
    const by = (id: string) => catalog.find((i) => i.id === id)!;
    expect(by("RED-E803B").precio).toBe("S/330");
    expect(by("TM-M30").precio).toBe("S/1250");
    expect(by("RED-HQ400").precio).toBe("S/450");
    expect(by("80X40MM").precios).toEqual({ unidad: "S/3.50", caja: "S/240" });
    expect(by("RED-950A").precio).toBe("S/3800");
    expect(by("SWIFT-2-2-GB-RAM-16-GB-ROM").precio).toBe("S/990");
    expect(by("SWIFT-2-4-GB-RAM-32-GB-ROM").precio).toBe("S/1190");
  });

  it("encuentra por modelo, por palabras y sin importar plurales ni espacios en las unidades", () => {
    const ids = (q: string) => searchCatalog(catalog, q).map((i) => i.id);
    expect(ids("red-e803b")[0]).toBe("RED-E803B");
    expect(ids("E803B")[0]).toBe("RED-E803B");
    expect(ids("swift 2").slice(0, 2).sort()).toEqual(["SWIFT-2-2-GB-RAM-16-GB-ROM", "SWIFT-2-4-GB-RAM-32-GB-ROM"]);
    expect(ids("lectores inalámbricos 2D").every((id) => catalog.find((i) => i.id === id)!.categoria === "Lector de código de barras inalámbrico")).toBe(true);
    expect(ids("gaveta")).toEqual(expect.arrayContaining(["RED-335X", "RED-410G"]));
    expect(ids("impresora 80 mm bluetooth").length).toBeGreaterThan(0);
    expect(ids("mantenimiento billetes")).toContain("RED-950A");
    expect(ids("xyzzy")).toEqual([]);
  });

  it("el índice del prompt agrupa por categoría, incluye precio y no incluye especificaciones", () => {
    const index = catalogIndex(catalog);
    expect(index).toContain("## Gaveta de dinero");
    expect(index).toContain("- RedPOS RED-335X: S/160");
    expect(index).toContain("unidad S/3.50, caja S/240");
    expect(index).not.toContain("Velocidad de impresión");
    expect(index.length).toBeLessThan(8000);
  });
});
