/**
 * create_hold: place a hold request on another pharmacy's stock (User Gateway only).
 *
 * The model never calls this directly. The harness hands an inline `create_hold` call to
 * the UI, a person clicks Confirm, and the UI backend calls the User Gateway with that
 * person's JWT. Everything below is re-checked against stored data; nothing the model
 * wrote into the request is trusted except as a request.
 *
 * Rules (docs/RULES.md): C3 limits + daily cap, R2 H1/X needs pharmacist, E2 same
 * salt+strength, E3 no short-dated stock, E4 over-limit gives a handoff summary.
 */
import { randomUUID } from "node:crypto";
import {
  LIMITS,
  RESTRICTED_SCHEDULES,
  addDays,
  brandFamilyKey,
  inventorySk,
  istDate,
  normStrength,
  saltKey,
  type HoldItem,
  type InventoryItem,
  type Schedule,
} from "../shared/schema.js";
import { ToolError } from "../shared/gateway.js";
import { assertOwnPharmacy, type Caller } from "../shared/caller.js";

export interface CreateHoldInput {
  /** Requesting pharmacy. Must equal the signed-in user's pharmacy. */
  pharmacy_id: string;
  source_pharmacy_id: string;
  drug_id: string;
  batch: string;
  qty: number;
  /** Schedule the request claims. Must match the stored schedule (lets Cedar gate H1/X). */
  schedule: Schedule;
  /** What the user asked for, from search_inventory's `matched`. Enforces rule E2. */
  requested_salt: string;
  requested_strength: string;
  requested_brand?: string;
  harness_session_id?: string;
}

export interface UsageDelta {
  pharmacy_id: string;
  date: string;
  units: number;
  inr: number;
}

export interface HoldDeps {
  getInventory(pharmacyId: string, sk: string): Promise<InventoryItem | undefined>;
  /** Atomically writes the hold and adds to today's usage; throws DailyCapExceeded if a cap would be passed. */
  commitHold(hold: HoldItem, usage: UsageDelta): Promise<void>;
  now(): Date;
}

export class DailyCapExceeded extends Error {}

export interface CreateHoldOutput {
  ok: true;
  hold_id: string;
  status: "PENDING";
  summary: string;
  is_substitute: boolean;
}

function handoff(code: string, reason: string, i: CreateHoldInput, row?: InventoryItem): ToolError {
  const what = `${i.qty} x ${row?.brand_name ?? i.drug_id} (${row?.strength ?? i.requested_strength}) from ${i.source_pharmacy_id}`;
  return new ToolError(code, `This request is over a limit and was not placed: ${reason}`, {
    handoff: {
      for: "pharmacist",
      summary: `Hold request needs pharmacist review: ${what} for ${i.pharmacy_id}. Reason: ${reason}`,
      requested: { source_pharmacy_id: i.source_pharmacy_id, drug_id: i.drug_id, batch: i.batch, qty: i.qty },
    },
  });
}

export async function createHold(input: CreateHoldInput, caller: Caller, deps: HoldDeps): Promise<CreateHoldOutput> {
  assertOwnPharmacy(caller, input?.pharmacy_id);

  if (!Number.isInteger(input.qty) || input.qty < 1) {
    throw new ToolError("INVALID_QTY", "Quantity must be a whole number of at least 1.");
  }
  if (input.qty > LIMITS.maxUnitsPerHold) {
    throw handoff("QTY_LIMIT", `${input.qty} units is more than the ${LIMITS.maxUnitsPerHold}-unit per-request limit.`, input);
  }
  if (input.source_pharmacy_id === caller.pharmacy_id) {
    throw new ToolError("SAME_PHARMACY", "You cannot place a hold on your own pharmacy's stock.");
  }

  const row = await deps.getInventory(input.source_pharmacy_id, inventorySk(input.drug_id, input.batch));
  if (!row) throw new ToolError("NOT_FOUND", "That stock item does not exist. Search again.");

  if (input.schedule !== row.schedule) {
    throw new ToolError("SCHEDULE_MISMATCH", "The request's drug schedule does not match the stock record.");
  }
  if (RESTRICTED_SCHEDULES.includes(row.schedule) && caller.role !== "pharmacist") {
    throw new ToolError(
      "PHARMACIST_REQUIRED",
      `Schedule ${row.schedule} transfers need a signed-in pharmacist. Claiming a role in chat does not count.`,
    );
  }
  const now = deps.now();
  if (row.expiry_date < addDays(now, LIMITS.minDaysToExpiry)) {
    throw new ToolError("SHORT_DATED", `This batch expires on ${row.expiry_date}, within ${LIMITS.minDaysToExpiry} days.`);
  }
  if (saltKey(row.salt) !== saltKey(input.requested_salt ?? "") || normStrength(row.strength) !== normStrength(input.requested_strength ?? "")) {
    throw new ToolError("NOT_SAME_SALT_STRENGTH", "Substitutes must have exactly the same salt and strength as requested.");
  }
  if (input.qty > row.qty_available) {
    throw new ToolError("INSUFFICIENT_STOCK", `${input.source_pharmacy_id} has only ${row.qty_available} units of this batch.`);
  }
  const total = input.qty * row.unit_price_inr;
  if (total > LIMITS.maxInrPerHold) {
    // The price is used for the check but not revealed: it is another pharmacy's commercial data (R3).
    throw handoff("VALUE_LIMIT", `the request is worth more than ₹${LIMITS.maxInrPerHold.toLocaleString("en-IN")}.`, input, row);
  }

  const is_substitute = !!input.requested_brand && brandFamilyKey(input.requested_brand) !== row.brand_family;
  const hold: HoldItem = {
    requesting_pharmacy_id: caller.pharmacy_id,
    hold_id: `HOLD-${istDate(now)}-${randomUUID()}`,
    source_pharmacy_id: row.pharmacy_id,
    drug_id: row.drug_id,
    batch: row.batch,
    brand_name: row.brand_name,
    salt: row.salt,
    strength: row.strength,
    schedule: row.schedule,
    qty: input.qty,
    unit_price_inr: row.unit_price_inr,
    total_inr: total,
    is_substitute,
    status: "PENDING",
    confirmed_by_sub: caller.sub,
    confirmed_by_role: caller.role,
    harness_session_id: input.harness_session_id ?? "unknown",
    created_at: now.toISOString(),
  };

  try {
    await deps.commitHold(hold, { pharmacy_id: caller.pharmacy_id, date: istDate(now), units: input.qty, inr: total });
  } catch (e) {
    if (e instanceof DailyCapExceeded) {
      throw handoff(
        "DAILY_CAP",
        `today's limit for ${caller.pharmacy_id} (${LIMITS.dailyUnitCap} units, ₹${LIMITS.dailyInrCap.toLocaleString("en-IN")}, ${LIMITS.dailyHoldCountCap} holds) would be passed. Splitting the order does not get around it.`,
        input,
        row,
      );
    }
    throw e;
  }

  return {
    ok: true,
    hold_id: hold.hold_id,
    status: "PENDING",
    summary: `Hold placed: ${hold.qty} x ${hold.brand_name} ${hold.strength} from ${hold.source_pharmacy_id}${is_substitute ? " (substitute: same salt and strength)" : ""}. Awaiting the source pharmacy.`,
    is_substitute,
    // No total or unit price: total / qty would reveal another pharmacy's price (R3).
  };
}
