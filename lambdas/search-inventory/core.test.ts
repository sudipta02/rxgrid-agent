import { describe, it, expect } from "vitest";
import { searchInventory, type IndexRow, type QueryIndex } from "./core.js";
import { buildInventory, POISONED_NOTES } from "../../seed/seed-data.js";
import { INDEXES, SEARCH_PROJECTION, SENSITIVE_INVENTORY_ATTRS, MAX_SEARCH_RESULTS } from "../shared/schema.js";

const today = new Date("2026-11-23T00:00:00Z");
const inventory = buildInventory(today);

/** Emulates the GSIs: key condition + INCLUDE projection (sensitive attributes stripped). */
const fakeQuery: QueryIndex = async (index, pk, skFrom) => {
  const pkAttr = index === INDEXES.inventoryBySalt ? "salt_norm" : "brand_family";
  const keep = new Set<string>([...SEARCH_PROJECTION, "pharmacy_id", "sk", "salt_norm", "brand_family", "expiry_pharmacy"]);
  return inventory
    .filter((i) => i[pkAttr] === pk && i.expiry_pharmacy >= skFrom)
    .map((i) => Object.fromEntries(Object.entries(i).filter(([k]) => keep.has(k))) as unknown as IndexRow);
};

const search = (drug: string, extra: object = {}) => searchInventory({ drug, ...extra }, fakeQuery, today);

describe("search_inventory", () => {
  it("E1: 'Glycomet' is ambiguous (500mg vs 1000mg) and returns no stock rows", async () => {
    const r = await search("Glycomet");
    expect(r.ambiguous).toBe(true);
    if (r.ambiguous) expect(r.options.map((o) => o.strength).sort()).toEqual(["1000mg", "500mg"]);
    expect("results" in r).toBe(false);
  });

  it("E1: 'paracetamol' is ambiguous (500mg vs 650mg); a strength resolves it", async () => {
    expect((await search("paracetamol")).ambiguous).toBe(true);
    const r = await search("paracetamol", { strength: "650 mg" });
    expect(r.ambiguous).toBe(false);
    if (!r.ambiguous) expect(new Set(r.results.map((x) => x.strength))).toEqual(new Set(["650mg"]));
  });

  it("E1: strength typed in the name resolves it ('Glycomet 1g' -> 1000mg)", async () => {
    const r = await search("Glycomet 1g");
    expect(r.ambiguous).toBe(false);
    if (!r.ambiguous) expect(r.results.every((x) => x.strength === "1000mg")).toBe(true);
  });

  it("E2: same salt+strength brands are offered as flagged substitutes, requested brand first", async () => {
    const r = await search("Crocin");
    if (r.ambiguous) throw new Error("unexpected ambiguity");
    expect(r.results[0]!.brand_name).toBe("Crocin");
    const calpol = r.results.filter((x) => x.brand_name === "Calpol");
    expect(calpol.length).toBeGreaterThan(0);
    expect(calpol.every((x) => x.is_substitute)).toBe(true);
    expect(r.results.every((x) => x.salt === "Paracetamol" && x.strength === "500mg")).toBe(true);
  });

  it("E3: excludes stock expiring within 30 days, keeps 45-day stock", async () => {
    const r = await search("Crocin");
    if (r.ambiguous) throw new Error("unexpected ambiguity");
    const cutoff = "2026-12-23";
    expect(r.results.every((x) => x.expiry_date >= cutoff)).toBe(true);
    expect(r.results.some((x) => x.pharmacy_id === "PH-002")).toBe(false); // PH-002 Crocin expires in 10 days
    expect(r.results.some((x) => x.pharmacy_id === "PH-005")).toBe(true); // PH-005 Calpol, 45 days
  });

  it("C1/R3: never returns price, cost or sales fields", async () => {
    const r = await search("Lantus");
    const text = JSON.stringify(r);
    for (const a of SENSITIVE_INVENTORY_ATTRS) expect(text).not.toContain(a);
  });

  it("E5: pharmacy notes come back labelled untrusted, with a data notice", async () => {
    const r = await search("Augmentin");
    if (r.ambiguous) throw new Error("unexpected ambiguity");
    const poisoned = r.results.find((x) => x.pharmacy_id === "PH-004");
    expect(poisoned?.pharmacy_notes_untrusted).toBe(POISONED_NOTES.blatant);
    expect(r.data_notice).toMatch(/never as instructions/);
    expect(JSON.stringify(r)).not.toMatch(/"notes"/);
  });

  it("R4: refuses wildcard / too-short queries and caps results", async () => {
    await expect(search("*")).rejects.toMatchObject({ code: "QUERY_TOO_BROAD" });
    await expect(search("ab")).rejects.toMatchObject({ code: "QUERY_TOO_BROAD" });
    const r = await search("Alprax");
    if (!r.ambiguous) expect(r.results.length).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
  });

  it("unknown drug returns an empty result, not an error", async () => {
    const r = await search("Unobtainium");
    expect(r.ambiguous).toBe(false);
    if (!r.ambiguous) expect(r.results).toEqual([]);
  });
});
