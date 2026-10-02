import fs from "node:fs";
import path from "node:path";

export type CatalogItem = Record<string, unknown>;

export interface Knowledge {
  empresa: string;
  catalog: CatalogItem[];
  resenas: string;
  /** Archivos que faltan, están vacíos o aún contienen marcas TODO. */
  pending: string[];
}

const FILES = ["empresa.md", "catalog.json", "resenas.md"] as const;

export function loadKnowledge(dir: string): Knowledge {
  const pending: string[] = [];
  const read = (name: string): string => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      return "";
    }
  };

  const empresa = read("empresa.md").trim();
  const resenas = read("resenas.md").trim();
  let catalog: CatalogItem[] = [];
  const rawCatalog = read("catalog.json").trim();
  if (rawCatalog) {
    try {
      const parsed: unknown = JSON.parse(rawCatalog);
      if (!Array.isArray(parsed)) throw new Error("debe ser una lista");
      catalog = parsed.filter((x): x is CatalogItem => typeof x === "object" && x !== null);
    } catch (err) {
      throw new Error(`knowledge/catalog.json inválido: ${(err as Error).message}`);
    }
  }

  if (!empresa || /\bTODO\b/.test(empresa)) pending.push("empresa.md");
  if (catalog.length === 0 || /\bTODO\b/.test(rawCatalog)) pending.push("catalog.json");
  if (!resenas || /\bTODO\b/.test(resenas)) pending.push("resenas.md");

  return { empresa, catalog, resenas, pending };
}

/** Recarga automáticamente cuando cambia algún archivo (sin reiniciar el servicio). */
export class KnowledgeStore {
  private cached?: Knowledge;
  private signature = "";

  constructor(private readonly dir: string) {}

  get(): Knowledge {
    const sig = FILES.map((f) => {
      try {
        return fs.statSync(path.join(this.dir, f)).mtimeMs;
      } catch {
        return 0;
      }
    }).join("|");
    if (!this.cached || sig !== this.signature) {
      this.cached = loadKnowledge(this.dir);
      this.signature = sig;
    }
    return this.cached;
  }
}

export function assertKnowledgeReady(k: Knowledge, nodeEnv: string): void {
  if (nodeEnv === "production" && k.pending.length > 0) {
    throw new Error(
      `Falta completar el conocimiento del negocio antes de producción: ${k.pending.join(", ")} ` +
        `(ver carpeta knowledge/).`,
    );
  }
}

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** Búsqueda simple por palabras (sin tildes ni mayúsculas); suficiente para catálogos pequeños. */
export function searchCatalog(catalog: CatalogItem[], query: string, limit = 5): CatalogItem[] {
  const tokens = normalize(query)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];
  return catalog
    .map((item) => {
      const text = normalize(JSON.stringify(item));
      return { item, score: tokens.filter((t) => text.includes(t)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}
