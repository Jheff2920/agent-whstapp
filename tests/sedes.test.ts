import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { describeSchedule, openStatus, parseSedes, renderSedes } from "../src/knowledge/sedes.js";

const REAL = fs.readFileSync(new URL("../knowledge/sedes.yml", import.meta.url), "utf8");
const sedes = parseSedes(REAL);
const bySede = (id: string) => sedes.sedes.find((s) => s.id === id)!;

describe("sedes.yml real", () => {
  it("tiene las dos sedes con la dirección entregada", () => {
    expect(sedes.sedes.map((s) => s.nombre)).toEqual(["Cyberplaza", "San Isidro"]);
    expect(bySede("san-isidro").direccion).toBe("Av. Canaval y Moreyra 345 - San Isidro, piso 7");
    expect(bySede("cyberplaza").direccion).toContain("Av. Garcilazo de la Vega 1348");
    expect(sedes.zona_horaria).toBe("America/Lima");
  });

  it("describe los horarios confirmados", () => {
    expect(describeSchedule(bySede("cyberplaza").horario)).toBe("lunes a sábado 10:00-19:00; domingo cerrado");
    expect(describeSchedule(bySede("san-isidro").horario)).toBe(
      "lunes a viernes 09:00-18:00; sábado 09:00-13:00; domingo cerrado",
    );
    const text = renderSedes(sedes);
    expect(text).toContain("## Sede San Isidro");
    expect(text).toContain("piso 7");
  });
});

describe("openStatus (hora de Lima, UTC-5)", () => {
  const at = (iso: string) => openStatus(sedes, new Date(iso)).split("\n");

  it("jueves 10:00 Lima: ambas abiertas (Cyberplaza abre a las 10:00 en punto)", () => {
    expect(at("2026-10-01T15:00:00Z")).toEqual([
      "- Cyberplaza: abierta ahora (cierra a las 19:00)",
      "- San Isidro: abierta ahora (cierra a las 18:00)",
    ]);
  });
  it("jueves 08:00 Lima: aún cerradas, abren hoy", () => {
    expect(at("2026-10-01T13:00:00Z")).toEqual([
      "- Cyberplaza: cerrada ahora; abre hoy a las 10:00",
      "- San Isidro: cerrada ahora; abre hoy a las 09:00",
    ]);
  });
  it("sábado 14:00 Lima: San Isidro ya cerró y Cyberplaza sigue abierta", () => {
    expect(at("2026-10-03T19:00:00Z")).toEqual([
      "- Cyberplaza: abierta ahora (cierra a las 19:00)",
      "- San Isidro: cerrada ahora; abre el lunes a las 09:00",
    ]);
  });
  it("sábado 19:00 Lima (cierre exacto): cerradas hasta el lunes porque el domingo no abren", () => {
    expect(at("2026-10-04T00:00:00Z")).toEqual([
      "- Cyberplaza: cerrada ahora; abre el lunes a las 10:00",
      "- San Isidro: cerrada ahora; abre el lunes a las 09:00",
    ]);
  });
  it("viernes 22:00 Lima: abren mañana", () => {
    expect(at("2026-10-03T03:00:00Z")).toEqual([
      "- Cyberplaza: cerrada ahora; abre mañana a las 10:00",
      "- San Isidro: cerrada ahora; abre mañana a las 09:00",
    ]);
  });
  it("usa la zona horaria de Lima aunque en UTC ya sea otro día", () => {
    // 2026-10-02 23:30 en Lima = 2026-10-03 04:30 UTC (viernes en Lima, sábado en UTC)
    expect(at("2026-10-03T04:30:00Z")[0]).toBe("- Cyberplaza: cerrada ahora; abre mañana a las 10:00");
  });
});

describe("validación de sedes.yml", () => {
  const base = (horario: string) =>
    `sedes:\n  - id: a\n    nombre: A\n    direccion: "x"\n    horario:\n${horario}\n`;
  it("acepta varias ventanas por día", () => {
    const s = parseSedes(base('      lunes: ["09:00-13:00", "15:00-19:00"]'));
    expect(describeSchedule(s.sedes[0]!.horario)).toContain("lunes 09:00-13:00 y 15:00-19:00");
  });
  it("rechaza formatos de hora inválidos y cierres anteriores a la apertura", () => {
    expect(() => parseSedes(base('      lunes: ["9-18"]'))).toThrow("sedes.yml inválido");
    expect(() => parseSedes(base('      lunes: ["18:00-09:00"]'))).toThrow("posterior");
    expect(() => parseSedes("sedes: []")).toThrow("sedes.yml inválido");
    expect(() => parseSedes("{{ no es yaml")).toThrow("sedes.yml inválido");
  });
});
