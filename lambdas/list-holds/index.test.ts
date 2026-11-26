import { describe, it, expect } from "vitest";
import { listHolds, type QueryHolds } from "./index.js";
import { buildHolds } from "../../seed/seed-data.js";

const holds = buildHolds(new Date("2026-11-23T00:00:00Z"));
const queryHolds: QueryHolds = async (p) => holds.filter((h) => h.requesting_pharmacy_id === p);

describe("list_holds", () => {
  it("C2: returns only the caller's own holds, without prices", async () => {
    const r = await listHolds({ pharmacy_id: "PH-001" }, { sub: "s", pharmacy_id: "PH-001", role: "staff" }, queryHolds);
    expect(r.holds.map((h) => h.hold_id)).toEqual(["HOLD-SEED-PH001-0001"]);
    expect(JSON.stringify(r)).not.toMatch(/price|total_inr/);
  });

  it("R5/C2: asking for another pharmacy's holds is refused", async () => {
    await expect(
      listHolds({ pharmacy_id: "PH-003" }, { sub: "s", pharmacy_id: "PH-001", role: "staff" }, queryHolds),
    ).rejects.toMatchObject({ code: "FORBIDDEN_TENANT" });
  });
});
