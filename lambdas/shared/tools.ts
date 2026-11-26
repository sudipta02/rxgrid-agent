/**
 * Tool names shared by the harness config, the tool-cap hook and the sanitizer API.
 * The harness config (AgentCore CLI / CloudFormation) MUST use these names.
 */

/** Model-facing names of the harness inline functions (handed back to the sanitizer). */
export const INLINE_TOOLS = { createHold: "create_hold", listHolds: "list_holds" } as const;
export type InlineToolName = (typeof INLINE_TOOLS)[keyof typeof INLINE_TOOLS];

/** `name` of the agentcore_gateway tool entry in the harness config (the Agent Gateway). */
export const HARNESS_GATEWAY_TOOL = "rxgrid_search";

/** Gateway tool name of search: "<target>___<tool>" (see infra/lib/tool-schemas.ts). */
export const SEARCH_GATEWAY_TOOL = "rxgrid-search___search_inventory";

/**
 * allowedTools pinned by the sanitizer on EVERY InvokeHarness call. Never "*" and never
 * omitted: both mean the built-in set, including shell and file read/write/edit.
 * Selector syntax: "@<configured tool name>[/<tool>]" (harness-tools docs). Each <= 64 chars.
 */
export const ALLOWED_TOOLS = [
  `@${HARNESS_GATEWAY_TOOL}/${SEARCH_GATEWAY_TOOL}`,
  `@${INLINE_TOOLS.createHold}`,
  `@${INLINE_TOOLS.listHolds}`,
] as const;

export function isInlineTool(name: unknown): name is InlineToolName {
  return name === INLINE_TOOLS.createHold || name === INLINE_TOOLS.listHolds;
}
