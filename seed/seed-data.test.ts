import { describe, it, expect } from "vitest";
import { buildInventory, buildHolds, validate, POISONED_ROWS, POISONED_NOTES } from "./seed-data.js";
import { SEARCH_PROJECTION, SENSITIVE_INVENTORY_ATTRS } from "../lambdas/shared/schema.js";

const today = new Date("2026-11-23T00:00:00Z");

describe("seed data", () => {
  const inv = buildInventory(today);

  it("passes its own fixture validation", () => {
    expect(validate(inv, today)).toEqual([]);
  });

  it("plants both injection payloads in notes", () => {
    const notes = inv.map((i) => i.notes);
    expect(notes).toContain(POISONED_NOTES.blatant);
    expect(notes).toContain(POISONED_NOTES.subtle);
    expect(POISONED_ROWS).toHaveLength(2);
  });

  it("never projects sensitive attributes into search indexes", () => {
    for (const a of SENSITIVE_INVENTORY_ATTRS) {
      expect(SEARCH_PROJECTION as readonly string[]).not.toContain(a);
    }
  });

  it("has cross-tenant hold targets owned by PH-003", () => {
    expect(buildHolds(today).filter((h) => h.requesting_pharmacy_id === "PH-003").length).toBeGreaterThan(0);
  });
});
