# Jev Per-File Review Checklist

Generated from independent TypeSafe Jev reviews of each TypeScript file using `jev-1.13.0`.

> **Important:** Jev returns judgments and probabilities, not proof. Verify each item in the source before changing it. A `REVIEW` caused only by the composite threshold is a policy signal, not a concrete defect.

## Priority 1 — investigate possible unhandled errors

These are the only files with a bug-class signal above the configured review threshold.

- [x] **`extension/review.ts` — defensive validation added; residual signal P=0.80**
  - Added finite/range validation for scores, confidence, probabilities, and Noul values.
  - `runReview()` intentionally propagates SDK errors to its callers; both registered entry points catch and render those failures. Keep this boundary behavior unless callers need a typed error/result contract.
  - Residual Jev signal is therefore an architectural follow-up, not an unhandled exception confirmed in the current callers.

- [x] **`extension/jev-command.ts` — file-read handling added; no bug signal after fix**
  - Moved `readFileSync()` inside the command's existing `try/catch`, covering permission/race failures as well as API errors.
  - Post-fix Jev returned no concrete bug flags; its `BLOCK` result was composite-only.

- [x] **`extension/index.ts` — guarded client construction; no bug signal after fix**
  - `TypeSafeClient` construction is now caught so malformed configuration cannot break pi startup.
  - Post-fix Jev returned no bug signal; it raised only a low testability score because wiring occurs in the extension factory.

## Priority 2 — investigate quality flags

- [x] **`extension/availability.ts` — extensibility flag accepted: 0.50**
  - The hard-coded `TYPESAFE_API_KEY` gate is intentional and matches the requested security contract.
  - Do not make the gate configurable unless the security requirement changes; no key must continue to mean no registered tool or command.

## Priority 3 — policy/composite review signals

These files had no bug-class flags, but their weighted composite score was below the default `0.60` review threshold. Review the code if desired; do not assume a defect from this signal alone.

- [ ] `extension/compose.ts` — composite `0.506`
- [ ] `extension/config.ts` — composite `0.489`
- [ ] `extension/index.ts` — composite `0.401`
- [ ] `extension/jev-command.ts` — composite `0.299`
- [ ] `extension/jev-tool.ts` — composite `0.425`
- [ ] `extension/questions.ts` — composite `0.566`
- [ ] `extension/review.ts` — composite `0.234`

## Passing files

No concrete flags and composite passed:

- `extension/availability.ts` — composite `0.727` (also had the extensibility signal above)
- `extension/types.ts` — composite `0.699`
- `tests/compose.test.ts` — composite `0.675`

## Batch-review follow-up

- [x] Added `jev_review.paths` for explicit file groups.
- [x] Added `jev_review.directory` with recursive source-file discovery, ignored build/dependency directories, extension filters, and a 200-file safety cap.
- [x] Each file is reviewed in an independent TypeSafe request and returned under its exact normalized `file` path.
- [x] Per-file read/API failures are isolated and returned as that file's `error`; successful files still return their reports.
- [x] Re-ran the batch review after reload; 9/10 files pass, with one remaining low-confidence semantic-mismatch hypothesis that targeted Jev diagnostics did not confirm.

## Policy follow-up

- [ ] Revisit the default `compositeReviewBelow: 0.6` threshold after reviewing a representative set of files.
- [x] Composite-only reviews no longer set `escalate=true` when no concrete bug, flagged dimension, or uncertainty signal exists. This raised the current batch pass rate to 90% (9/10).
- [ ] Keep bug thresholds and quality thresholds independently tunable; do not lower bug thresholds merely to reduce style-related review volume.
- [ ] Consider extracting dependency wiring from `extension/index.ts` if testability becomes a practical maintenance issue; Jev's only post-fix dimension flag there was testability.

## Verification after fixes

For each changed TypeScript file:

1. Run `npm run typecheck`.
2. Run `npm test`.
3. Call `jev_review` on the changed file.
4. Verify each Jev flag against the source before editing.
5. Re-run the per-file review after fixes and update this checklist.
