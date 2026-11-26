/**
 * tool-cap: before_tool_call hook (layers L6/L7; rules C3, R2, E4 and the tool allowlist).
 *
 * 1. Allowlist. Only these calls are allowed; everything else (shell, read/write/edit,
 *    browser, any other MCP tool) is denied, even if the harness allowedTools were wrong:
 *      - inline_function  create_hold, list_holds
 *      - agentcore_gateway whose name ends in "search_inventory"
 *    VERIFY after the harness exists: the exact model-facing name of the gateway tool
 *    (DOCS-CHECK item 11).
 * 2. create_hold early checks, so an impossible hold never reaches the Confirm dialog:
 *      - pharmacy_id must be the session's pharmacy (identity from Sessions, not the model)
 *      - qty a whole number 1..LIMITS.maxUnitsPerHold
 *      - schedule H1/X only for role pharmacist
 *      - today's units and hold count plus this request must fit the daily caps
 *    The INR cap is NOT checked here: it needs the stored unit price, and the price in the
 *    model's input cannot be trusted. The create-hold Lambda's transaction is the
 *    authoritative check for every limit; this hook only denies early.
 *
 * Deny skips the tool call and the agent loop continues, so reasons are written for the
 * model to relay (and E4: they point to a pharmacist handoff, never to splitting).
 */
import { LIMITS, RESTRICTED_SCHEDULES, istDate, type DailyUsageItem, type Schedule } from "../../shared/schema.js";
import {
  allow,
  deny,
  isTruncatedField,
  type GetSession,
  type HookDecision,
  type HookPayload,
} from "../../shared/hooks.js";

import { INLINE_TOOLS } from "../../shared/tools.js";

export { INLINE_TOOLS };
export const SEARCH_TOOL_SUFFIX = "search_inventory";

export interface ToolCallContext {
  toolName?: string;
  toolType?: string;
  toolUseId?: string;
  toolInput?: unknown;
}

export type GetDailyUsage = (pharmacyId: string, date: string) => Promise<Pick<DailyUsageItem, "units_total" | "hold_count"> | undefined>;

export interface ToolCapDeps {
  getSession: GetSession;
  getDailyUsage: GetDailyUsage;
  now: () => Date;
}

const HANDOFF = "Do not split the request; write a handoff summary for a pharmacist instead.";

export async function toolCap(event: HookPayload<ToolCallContext>, deps: ToolCapDeps): Promise<HookDecision> {
  if (event?.event !== "before_tool_call") return deny(`tool-cap received ${event?.event}`);
  const ctx = event.context ?? {};
  if (isTruncatedField(ctx.toolInput)) return deny("Tool input too large to check.");
  const name = String(ctx.toolName ?? "");
  const type = String(ctx.toolType ?? "");

  if (type === "agentcore_gateway" && (name === SEARCH_TOOL_SUFFIX || name.endsWith(`_${SEARCH_TOOL_SUFFIX}`))) {
    return allow();
  }
  if (type !== "inline_function" || (name !== INLINE_TOOLS.createHold && name !== INLINE_TOOLS.listHolds)) {
    return deny(`Tool "${name}" (${type || "unknown type"}) is not available to this agent.`);
  }

  const session = await deps.getSession(event.sessionId);
  if (!session) return deny("Unknown or expired session. Sign in again.");
  const input = (ctx.toolInput ?? {}) as Record<string, unknown>;

  if (input.pharmacy_id !== session.pharmacy_id) {
    return deny(`You can only act for your own pharmacy (${session.pharmacy_id}).`);
  }
  if (name === INLINE_TOOLS.listHolds) return allow();

  const qty = input.qty;
  if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1) {
    return deny("Quantity must be a whole number of at least 1.");
  }
  if (qty > LIMITS.maxUnitsPerHold) {
    return deny(`${qty} units is over the ${LIMITS.maxUnitsPerHold}-unit per-request limit. ${HANDOFF}`);
  }
  if (RESTRICTED_SCHEDULES.includes(input.schedule as Schedule) && session.role !== "pharmacist") {
    return deny(`Schedule ${String(input.schedule)} transfers need a pharmacist sign-in.`);
  }

  const usage = await deps.getDailyUsage(session.pharmacy_id, istDate(deps.now()));
  const units = usage?.units_total ?? 0;
  const count = usage?.hold_count ?? 0;
  if (count + 1 > LIMITS.dailyHoldCountCap) {
    return deny(`Today's limit of ${LIMITS.dailyHoldCountCap} holds is used up. ${HANDOFF}`);
  }
  if (units + qty > LIMITS.dailyUnitCap) {
    return deny(
      `This would take today's total to ${units + qty} units, over the ${LIMITS.dailyUnitCap}-unit daily cap (${units} used). ${HANDOFF}`,
    );
  }
  return allow();
}
