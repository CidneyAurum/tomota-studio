# Deep polish chain

Objective: strengthen the full diagnosis → targeted revision → independent
verification → regression prevention chain, not merely require changed prose.
Local validation is authoritative for this task; remote CI remediation is excluded
by user request. Existing unrelated changes remain untouched.

## Work and evidence

- Require each model finding to quote the current reviewed artifact and use a
  unique finding ID. An unrelated valid top-level quote cannot legitimize an
  invented repair diagnosis.
- Validate failed review briefs before persisting the review artifact.
- Preserve self-check obligations in revision JSON schemas when allowing either
  full content or precise replacements.
- Prose failures now freeze stable repair targets with original anchors, explicit
  requirements and protected-content instructions in `polish_ledger.json`.
- Revisions cover every target with grounded before/after and preservation evidence;
  all previous repair approvals reopen whenever prose changes.
- Corresponding review gates require independent per-target confirmation. Canon
  submission rejects outstanding repair obligations.
- Pure ledger tests cover identity, history, input immutability, stale evidence,
  omitted/duplicate targets, fake preservation and reopening prior approvals.
- Public workflow tests cover missing revision receipts and missing independent
  verification; the authored workflow exercises the same stricter hand-off.
- Design failures use a separate `design_polish_ledger.json`; design receipts are
  stripped from the actual design so they cannot serve as their own repair evidence.
  Design rework has a finite budget and independent review before drafting.
- Final deterministic body checks and Canon-state regressions create repair
  obligations for the appropriate prose gate; the original final check still runs
  again after the repaired text passes all independent reviews.
- A complete public workflow test now reaches release-ready only after a failed
  review, grounded repair and independent verification, not just direct happy-path
  approvals.

## Final verification

- Python: `python -m unittest discover -s tests` — 176 tests passed.
- Studio: `npm test` — 148 tests passed.
- Build: `npm run build` — TypeScript and production Vite build passed.
- Rejected diagnosis inputs: invented finding quotes, duplicate IDs, invalid briefs
  do not persist an accepted failure artifact.
- Revision ledger: complete coverage, before/after anchors, preservation evidence,
  immutable input handling, stable identity/history, stale evidence rejection and
  reopening after later edits are covered by pure tests.
- Design: unchanged artifacts cannot cite new text only present in repair receipts;
  repaired design needs independent confirmation and has a bounded retry budget.
- Public workflow: missing repair receipts and confirmation are rejected; a grounded
  repair passes all later reviews and becomes release-ready.
- Final deterministic body failures generate required repair targets for logic
  review. The original deterministic final validator is not bypassed or disabled.
- Existing five-revision limit and draft retention tests continue to pass.

Local validation only: no live model generation or actual platform publication was
performed. GitHub CI remains the previously acknowledged separate issue; no CI
configuration or tests were disabled to obtain these results.

Textual grounding is necessary, not proof of literary quality. Semantic decisions
remain the responsibility of independent model review with visible evidence.
