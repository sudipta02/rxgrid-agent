import { describe, it, expect, beforeEach } from "vitest";
import { createHold, DailyCapExceeded, type CreateHoldInput, type HoldDeps, type UsageDelta } from "./core.js";
import { buildInventory } from "../../seed/seed-data.js";
import { LIMITS, type HoldItem } from "../shared/schema.js";
import type { Caller } from "../shared/caller.js";

const today = new Date("2026-11-23T06:00:00Z");
const inventory = buildInventory(today);

const staff1: Caller = { sub: "s1", pharmacy_id: "PH-001", role: "staff" };
const pharm1: Caller = { sub: "p1", pharmacy_id: "PH-001", role: "pharmacist" };

/** In-memory deps that implement the same cap condition as the DynamoDB transaction. */
function memoryDeps() {
  const holds: HoldItem[] = [];
  const usage = new Map<string, { units: number; inr: number; count: number }>();
  const deps: HoldDeps = {
    now: () => today,
    async getInventory(p, sk) {
      return inventory.find((i) => i.pharmacy_id === p && i.sk === sk);
    },
    async commitHold(hold: HoldItem, d: UsageDelta) {
      const k = `${d.pharmacy_id}|${d.date}`;
      const u = usage.get(k);
      if (u && !(u.units <= LIMITS.dailyUnitCap - d.units && u.inr <= LIMITS.dailyInrCap - d.inr && u.count <= LIMITS.dailyHoldCountCap - 1)) {
        throw new DailyCapExceeded();
      }
      usage.set(k, { units: (u?.units ?? 0) + d.units, inr: (u?.inr ?? 0) + d.inr, count: (u?.count ?? 0) + 1 });
      holds.push(hold);
    },
  };
  return { deps, holds, usage };
}

const dolo = (qty: number, extra: Partial<CreateHoldInput> = {}): CreateHoldInput => ({
  pharmacy_id: "PH-001",
  source_pharmacy_id: "PH-002",
  drug_id: "DOLO650",
  batch: "DL2501",
  qty,
  schedule: "OTC",
  requested_salt: "Paracetamol",
  requested_strength: "650mg",
  requested_brand: "Dolo",
  ...extra,
});

let m: ReturnType<typeof memoryDeps>;
beforeEach(() => {
  m = memoryDeps();
});

describe("create_hold", () => {
  it("C3: places a valid hold and records who confirmed it, without revealing price", async () => {
    const r = await createHold(dolo(20), staff1, m.deps);
    expect(r.ok).toBe(true);
    expect(m.holds[0]!.confirmed_by_sub).toBe("s1");
    expect(JSON.stringify(r)).not.toMatch(/price|total_inr/);
  });

  it("C1/L1: refuses to act for another pharmacy than the signed token", async () => {
    await expect(createHold(dolo(5, { pharmacy_id: "PH-003" }), staff1, m.deps)).rejects.toMatchObject({ code: "FORBIDDEN_TENANT" });
  });

  it("C3/E4: over 50 units -> refused with a pharmacist handoff summary", async () => {
    const err = await createHold(dolo(60), staff1, m.deps).catch((e) => e);
    expect(err.code).toBe("QTY_LIMIT");
    expect(err.extra.handoff.summary).toMatch(/pharmacist review/);
    expect(m.holds).toHaveLength(0);
  });

  it("C3/E4: over ₹10,000 within 50 units (14 x Lantus) -> VALUE_LIMIT, price not disclosed", async () => {
    const err = await createHold(
      { ...dolo(14), source_pharmacy_id: "PH-003", drug_id: "LANTUS", batch: "LN2505", schedule: "H", requested_salt: "Insulin Glargine", requested_strength: "100IU/ml", requested_brand: "Lantus" },
      staff1,
      m.deps,
    ).catch((e) => e);
    expect(err.code).toBe("VALUE_LIMIT");
    expect(JSON.stringify(err.extra)).not.toMatch(/720/);
  });

  it("anti limit-splitting: 50-unit holds stop at the 150-unit daily cap", async () => {
    const results: string[] = [];
    for (let i = 0; i < 4; i++) {
      results.push(await createHold(dolo(50), staff1, m.deps).then(() => "ok", (e) => e.code));
    }
    expect(results).toEqual(["ok", "ok", "ok", "DAILY_CAP"]);
  });

  it("R2: staff cannot hold Schedule H1 stock; a pharmacist can", async () => {
    const alprax = { ...dolo(10), source_pharmacy_id: "PH-004", drug_id: "ALPRAX025", batch: "AX2502", schedule: "H1" as const, requested_salt: "Alprazolam", requested_strength: "0.25mg", requested_brand: "Alprax" };
    await expect(createHold(alprax, staff1, m.deps)).rejects.toMatchObject({ code: "PHARMACIST_REQUIRED" });
    await expect(createHold(alprax, pharm1, m.deps)).resolves.toMatchObject({ ok: true });
  });

  it("R2: lying about the schedule (X declared as OTC) is caught", async () => {
    const addwize = { ...dolo(5), source_pharmacy_id: "PH-003", drug_id: "ADDWIZE10", batch: "AW2504", schedule: "OTC" as const, requested_salt: "Methylphenidate", requested_strength: "10mg" };
    await expect(createHold(addwize, staff1, m.deps)).rejects.toMatchObject({ code: "SCHEDULE_MISMATCH" });
  });

  it("E3: short-dated batch is refused even if requested directly", async () => {
    const shortDated = { ...dolo(10), source_pharmacy_id: "PH-004", batch: "DL2412" };
    await expect(createHold(shortDated, staff1, m.deps)).rejects.toMatchObject({ code: "SHORT_DATED" });
  });

  it("E2: a different strength is not an allowed substitute; same salt+strength is flagged", async () => {
    await expect(createHold(dolo(5, { requested_strength: "500mg" }), staff1, m.deps)).rejects.toMatchObject({ code: "NOT_SAME_SALT_STRENGTH" });
    const calpol = { ...dolo(5), source_pharmacy_id: "PH-003", drug_id: "CALPOL500", batch: "CP2411", requested_strength: "500mg", requested_brand: "Crocin" };
    await expect(createHold(calpol, staff1, m.deps)).resolves.toMatchObject({ is_substitute: true });
  });

  it("rejects own-pharmacy holds, missing stock and over-stock quantities", async () => {
    await expect(createHold(dolo(5, { source_pharmacy_id: "PH-001" }), staff1, m.deps)).rejects.toMatchObject({ code: "SAME_PHARMACY" });
    await expect(createHold(dolo(5, { batch: "NOPE" }), staff1, m.deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const augmentin = { ...dolo(45), source_pharmacy_id: "PH-005", drug_id: "AUGMENTIN625", batch: "AG2502", schedule: "H" as const, requested_salt: "Amoxicillin + Clavulanic Acid", requested_strength: "625mg" };
    await expect(createHold(augmentin, staff1, m.deps)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    await expect(createHold(dolo(2.5), staff1, m.deps)).rejects.toMatchObject({ code: "INVALID_QTY" });
  });
});
