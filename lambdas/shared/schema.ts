/**
 * DynamoDB schema for RxGrid. This file is the single source of truth for table names,
 * key layouts, index projections, item types and the numeric limits in docs/RULES.md.
 * infra/lib/data-stack.ts, the seed script and every Lambda import from here.
 *
 * Design principle: sensitive attributes (unit price, sales, internal cost) live on the
 * Inventory base table but are NOT projected into the search indexes. The search Lambda's
 * IAM role may only Query those indexes, so it physically cannot read prices or sales,
 * whatever the model asks for (enforcement layer 5).
 */

// ---------------------------------------------------------------------------
// Limits (keep in sync with docs/RULES.md)
// ---------------------------------------------------------------------------
export const LIMITS = {
  /** Max units in a single hold request. Also enforced in Cedar (policies/). */
  maxUnitsPerHold: 50,
  /** Max value of a single hold request, in whole rupees (qty × unit_price_inr). */
  maxInrPerHold: 10_000,
  /** Cumulative caps per requesting pharmacy per IST calendar day (anti limit-splitting). */
  dailyUnitCap: 150,
  dailyInrCap: 25_000,
  dailyHoldCountCap: 10,
  /** Stock expiring in fewer than this many days is never offered. */
  minDaysToExpiry: 30,
} as const;

/** Drug schedules under India's Drugs and Cosmetics Rules relevant here. */
export type Schedule = "OTC" | "H" | "H1" | "X";
/** Schedules that only a JWT role=pharmacist may transfer. */
export const RESTRICTED_SCHEDULES: readonly Schedule[] = ["H1", "X"];

export type Role = "staff" | "pharmacist";

/** Pharmacy IDs look like "PH-001". Validated wherever a pharmacy_id enters the system. */
export const PHARMACY_ID_PATTERN = /^PH-\d{3}$/;

// ---------------------------------------------------------------------------
// Table names (overridable per environment via env vars)
// ---------------------------------------------------------------------------
export const TABLES = {
  pharmacies: process.env.PHARMACIES_TABLE ?? "RxGrid-Pharmacies",
  inventory: process.env.INVENTORY_TABLE ?? "RxGrid-Inventory",
  holds: process.env.HOLDS_TABLE ?? "RxGrid-Holds",
  dailyUsage: process.env.DAILY_USAGE_TABLE ?? "RxGrid-DailyUsage",
  sessions: process.env.SESSIONS_TABLE ?? "RxGrid-Sessions",
} as const;

export const INDEXES = {
  /** Inventory GSI: every stock row of a salt (e.g. "paracetamol"), across strengths and brands. */
  inventoryBySalt: "BySalt",
  /**
   * Inventory GSI: every stock row of a brand family (first word of the brand, e.g.
   * "glycomet" covers Glycomet 500 and Glycomet 1g). An exact-brand index could not
   * detect that "Glycomet" is ambiguous (rule E1).
   */
  inventoryByBrandFamily: "ByBrandFamily",
} as const;

/** Most stock rows the search tool ever returns (rule R4: no bulk export). */
export const MAX_SEARCH_RESULTS = 20;

/**
 * Attributes projected into both Inventory search GSIs (INCLUDE projection). Table and
 * index keys are always projected too. Anything not listed here is invisible to the
 * search Lambda.
 */
export const SEARCH_PROJECTION = [
  "drug_id",
  "batch",
  "brand_name",
  "salt",
  "strength",
  "form",
  "schedule",
  "qty_available",
  "expiry_date",
  "area",
  "notes",
] as const;

/** Attributes that must NEVER appear in a search index projection. */
export const SENSITIVE_INVENTORY_ATTRS = ["unit_price_inr", "unit_cost_inr", "sales_30d_units"] as const;

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------
/** "Amoxicillin + Clavulanic Acid" → "amoxicillin+clavulanicacid" */
export function saltKey(salt: string): string {
  return norm(salt);
}
/** First word of the brand: "Dolo 650" → "dolo", "Taxim-O 200" → "taxim-o". */
export function brandFamilyKey(brandOrQuery: string): string {
  return norm(brandOrQuery.trim().split(/\s+/)[0] ?? "");
}
/** "500 mg" → "500mg", "1 g" / "1g" → "1000mg", "100 IU/ml" → "100iu/ml". */
export function normStrength(strength: string): string {
  const s = norm(strength);
  const grams = /^(\d+(?:\.\d+)?)g$/.exec(s);
  return grams ? `${Number(grams[1]) * 1000}mg` : s;
}
export function inventorySk(drugId: string, batch: string): string {
  return `DRUG#${drugId}#BATCH#${batch}`;
}
/** GSI sort key: expiry first, so a Query with SK >= cutoff excludes short-dated stock. */
export function expiryPharmacySk(expiryDate: string, pharmacyId: string): string {
  return `${expiryDate}#${pharmacyId}`;
}
export function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "").trim();
}

/** YYYY-MM-DD that is `days` after `d` (UTC calendar arithmetic). */
export function addDays(d: Date, days: number): string {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x.toISOString().slice(0, 10);
}

/** Calendar date in India Standard Time (UTC+5:30), YYYY-MM-DD. Daily caps reset at IST midnight. */
export function istDate(d: Date = new Date()): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Item types
// ---------------------------------------------------------------------------

/** RxGrid-Pharmacies. PK: pharmacy_id. Directory only; no commercial data. */
export interface PharmacyItem {
  pharmacy_id: string;
  name: string;
  area: string;
  city: string;
  /** Drug licence number. Not exposed by any agent tool. */
  licence_no: string;
}

/**
 * RxGrid-Inventory. One row per (pharmacy, drug, batch).
 * PK: pharmacy_id   SK: "DRUG#<drug_id>#BATCH#<batch>"
 * GSI BySalt:        PK salt_norm,    SK expiry_pharmacy
 * GSI ByBrandFamily: PK brand_family, SK expiry_pharmacy
 */
export interface InventoryItem {
  pharmacy_id: string;
  sk: string;
  drug_id: string;
  batch: string;
  brand_name: string;
  /** Active ingredient(s), e.g. "Amoxicillin + Clavulanic Acid". */
  salt: string;
  /** e.g. "500mg", "625mg", "0.25mg". */
  strength: string;
  form: "tablet" | "capsule" | "syrup" | "injection";
  schedule: Schedule;
  qty_available: number;
  /** ISO date YYYY-MM-DD. */
  expiry_date: string;
  area: string;
  /**
   * Free text written by the pharmacy. UNTRUSTED. It is returned to the model as data and
   * is the vector for the indirect-injection stress test.
   */
  notes?: string;
  // GSI keys
  salt_norm: string;
  brand_family: string;
  expiry_pharmacy: string;
  // Sensitive: base table only, never projected
  unit_price_inr: number;
  unit_cost_inr: number;
  sales_30d_units: number;
}

export type HoldStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "CANCELLED" | "EXPIRED";

/**
 * RxGrid-Holds. PK: requesting_pharmacy_id   SK: hold_id
 * A pharmacy can only read or modify rows under its own partition key. The key comes from
 * the JWT, never from the model.
 */
export interface HoldItem {
  requesting_pharmacy_id: string;
  hold_id: string;
  source_pharmacy_id: string;
  drug_id: string;
  batch: string;
  brand_name: string;
  salt: string;
  strength: string;
  schedule: Schedule;
  qty: number;
  unit_price_inr: number;
  total_inr: number;
  /** True if this is a same-salt, same-strength substitute for what was asked for. */
  is_substitute: boolean;
  status: HoldStatus;
  /** Cognito `sub` of the human who clicked Confirm. */
  confirmed_by_sub: string;
  confirmed_by_role: Role;
  harness_session_id: string;
  created_at: string;
}

/**
 * RxGrid-DailyUsage. PK: pharmacy_id   SK: date (IST, YYYY-MM-DD)
 * Updated with a conditional UpdateItem in the same TransactWriteItems as the Holds Put,
 * so concurrent or split requests cannot exceed the cap.
 */
export interface DailyUsageItem {
  pharmacy_id: string;
  date: string;
  units_total: number;
  inr_total: number;
  hold_count: number;
  /** Epoch seconds; DynamoDB TTL removes rows after 35 days. */
  ttl: number;
}

/**
 * RxGrid-Sessions. PK: session_id (the harness runtimeSessionId, generated by the
 * sanitizer API, never by the client).
 *
 * Added because harness lifecycle-hook payloads do not carry JWT claims, only sessionId.
 * The sanitizer verifies the Cognito JWT and writes this row before the first
 * InvokeHarness. Hooks look up the caller's pharmacy and role here.
 */
export interface SessionItem {
  session_id: string;
  pharmacy_id: string;
  role: Role;
  sub: string;
  created_at: string;
  ttl: number;
}
