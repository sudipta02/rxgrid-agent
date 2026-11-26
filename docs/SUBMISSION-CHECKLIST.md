# Hackathon submission checklist

Qualification is **pass/fail**. If any item marked **[REQ]** is missing, the entry is not judged.
Status as of 2026-11-26: ✅ done · 🟡 partly done · ⬜ not started.

## 1. A working agent that does one defined job [REQ]

The job: find a medicine in partner pharmacies and place a hold request within limits, for a human to confirm.

- 🟡 Data, auth, tools, hooks, harness and sanitizer stacks written and synthesized (`RxGrid-Data`, `-Auth`, `-Tools`, `-Hooks`, `-Harness`, `-Sanitizer`). **Not deployed.**
- 🟡 Harness defined in CDK (`RxGrid-Harness`, `CfnHarness`): `au.anthropic.claude-sonnet-5-5`, CUSTOM_JWT (Cognito, both clients), system prompt with every rule, `allowedTools` = `search_inventory` + inline `create_hold`, `list_holds` (never `*`, never omitted), three hooks, memory disabled, own least-privilege role. Synthesized. **Not deployed.**
- ⬜ Sanitizer adds the server-written `<rxgrid_session>` block (pharmacy_id, role from the verified token). Until it does, the model can't fill `pharmacy_id`, so holds and hold listing fail closed (ARCHITECTURE.md, Harness stack).
- 🟡 Hooks stack: `input-guard`, `tool-cap`, `result-guard` Lambdas + 2 CLASSIC guardrails. Written, unit-tested and synthesized (`RxGrid-Hooks`). **Not deployed.**
- 🟡 Sanitizer API: REST + Cognito + streaming Lambda (`/sessions`, `/chat`, `/confirm`). Written, unit-tested and synthesized (`RxGrid-Sanitizer`). **Not deployed.** Takes the harness ARN from `RxGrid-Harness`.
- ⬜ Next.js UI: chat + Confirm dialog + client-side output guardrail
- ⬜ Deploy (ask first: billable) → seed data (`npm run seed`) + test users (`npm run seed:users`)
- ⬜ Post-deploy VERIFY items: DOCS-CHECK 22, 32, 34, 37
- ⬜ End-to-end run: search → ambiguous ask → hold → Confirm → hold appears in `list_holds`

## 2. Written rule set in plain language [REQ]

- ✅ `docs/RULES.md`: CAN (C1–C3), MUST REFUSE (R1–R5), EDGE CASES (E1–E5)
- ⬜ Re-read after deploy. Make sure every number still matches `LIMITS` in `lambdas/shared/schema.ts`.

## 3. How each rule is enforced + architecture description or diagram [REQ]

- ✅ Rule → layer mapping in `docs/RULES.md`; layers L1–L9 in `docs/ARCHITECTURE.md`
- ✅ Two-gateway design and Tools stack described (ASCII diagram)
- ⬜ Proper architecture **diagram** image (PNG/SVG) for Builder Center and the README
- ⬜ Cedar policies moved from LOG_ONLY to **ENFORCE** after checking them against the generated schema (`policies/*.cedar` are DRAFT)
- ⬜ Update the "Enforced by" column for anything that changed during build

## 4. Stress test: ≥5 adversarial prompts, ≥1 prompt injection, documented [REQ]

Minimum to qualify: 5 prompts including 1 injection. Planned: 10.

- ⬜ `stress-test/prompts.json` with cases for:
  - direct injection
  - indirect injection (poisoned `notes` row)
  - limit splitting
  - role claim with a staff token
  - dosing advice
  - bulk export
  - cross-tenant cancel
  - encoded injection
  - raw API attack (`toolUse` block + `skills` override)
  - ambiguous drug
- ⬜ `stress-test/runner.ts`: runs each prompt 5×. Captures the response, hook decisions and the Cedar trace from CloudWatch.
- ⬜ Baseline run (prompt-only, no policy or hooks) and layered run
- ⬜ `stress-test/results.md`: for each prompt, **what it attempted**, **how the agent responded**, and the baseline vs layered result

## 5. AWS Builder Center written project [REQ]

The project must cover each of these:

- ⬜ The agent and the job it performs
- ⬜ The rule set (from RULES.md)
- ⬜ How each rule is enforced + the diagram
- ⬜ Stress test results (from results.md)
- ⬜ Build process
- ⬜ **Any rule that failed during testing and how it was fixed** (from `docs/BREAKS.md`, which has no entries yet. Log real failures as they happen; never invent them.)
- ⬜ Published (not left as a draft)

## 6. Repo/demo link + at least one screenshot of the agent running [REQ]

- ✅ Repo is public: `github.com/sudipta02/rxgrid-agent`. Confirmed 2026-11-26. Keep it public through judging.
- ✅ Work pushed to `master` (`a9bd02b`, `8e45817`).
- ✅ `LICENSE`: MIT (OSI-approved), committed and pushed.
- ⬜ README: what it is, the architecture, how to deploy and seed, and links to RULES, ARCHITECTURE, results and BREAKS
- ⬜ Screenshots in `docs/screenshots/` (empty now), at least one of the **agent running**. Useful ones:
  - chat with search results
  - the Confirm dialog
  - a refused injection
  - a Cedar decision in CloudWatch
- ⬜ Check for secrets before making the repo public: no `.env`, account-specific outputs, test-user passwords or `stress-test/.test-users.json`
- ⬜ (Optional) Demo video: public, with no third-party trademarks or copyrighted music

## 7. Original, previously unpublished agent [REQ]

- ✅ Built from scratch for this hackathon
- ⬜ Don't publish the Builder Center project or the public repo anywhere else before submitting

## Final pre-submit pass

- ⬜ Every **[REQ]** section above is fully ✅
- ⬜ Open the repo in a signed-out browser: it's public and the LICENSE shows
- ⬜ The Builder Center project links to the repo and shows at least one screenshot
- ⬜ Decide whether to keep or tear down the AWS resources after judging, to control cost
