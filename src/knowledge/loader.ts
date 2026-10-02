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

const STOPWORDS = new Set([
  "para", "con", "sin", "que", "una", "uno", "unos", "unas", "los", "las", "del", "por", "mas", "como",
  "quiero", "necesito", "busco", "tienen", "tiene", "hay", "red", "soluciones",
]);

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // "80 mm" y "80mm" deben coincidir
    .replace(/(\d)\s+(mm|km|gb|mah|dpi|ghz|hz|nm|mts)\b/g, "$1$2");

const compact = (s: string): string => normalize(s).replace(/[^a-z0-9]/g, "");

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Búsqueda simple por palabras (sin tildes, mayúsculas ni plurales) más coincidencia directa por modelo
 * ("e803b", "swift 2"); suficiente para catálogos de cientos de productos.
 */
export function searchCatalog(catalog: CatalogItem[], query: string, limit = 6): CatalogItem[] {
  const tokens = normalize(query)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map((t) => (t.length >= 5 && t.endsWith("s") ? t.slice(0, -1) : t));
  const q = compact(query);

  return catalog
    .map((item) => {
      const text = normalize(JSON.stringify(item));
      let score = tokens.filter((t) => text.includes(t)).length;
      if (q.length >= 4) {
        const model = compact(`${str(item.id)} ${str(item.modelo)} ${str(item.variante)}`);
        if (model.includes(q)) score += 10;
      }
      return { item, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}

/** Texto de precio de un producto: `precio` o `precios` (p. ej. unidad y caja). */
export function priceText(item: CatalogItem): string {
  if (typeof item.precio === "string") return item.precio;
  if (item.precios && typeof item.precios === "object") {
    return Object.entries(item.precios as Record<string, unknown>)
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(", ");
  }
  return "precio por confirmar";
}

/** Índice compacto agrupado por categoría: modelo, marca y precio (sin especificaciones). */
export function catalogIndex(catalog: CatalogItem[]): string {
  const groups = new Map<string, string[]>();
  for (const item of catalog) {
    const cat = str(item.categoria) || "Otros";
    const name = [str(item.marca), str(item.modelo)].filter(Boolean).join(" ");
    const variant = str(item.variante) ? ` (${str(item.variante)})` : "";
    const line = `- ${name}${variant}: ${priceText(item)}`;
    (groups.get(cat) ?? groups.set(cat, []).get(cat)!).push(line);
  }
  return [...groups].map(([cat, lines]) => `## ${cat}\n${lines.join("\n")}`).join("\n\n");
}
