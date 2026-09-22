# Repository guidance

## Scope

`pi-jev-anti-slop` exposes structured TypeSafe Jev code/prose review to Pi. Jev findings are triage signals: verify them against the actual file before editing or claiming a defect.

## Layout

- `extension/` — extension entry point, policy, question sets, review composition, command/tool integration.
- `tests/` — deterministic Node tests; no live Jev requests by default.
- `README.md` — public contract for review types, checks, and limitations.

## Checks

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

Keep SDK access at the existing thin boundary. Composition and policy logic should remain pure and unit-testable. Never expose credential characters or submit sensitive files.

## Conventions

- Use the narrowest relevant review type.
- Preserve per-file isolation in batches and section/chunk location metadata.
- Treat typed probability output as evidence to investigate, not proof.
- Keep context bounded for Jev's 32k limit.
- Never log or commit credentials.

## Release

Run checks and pack validation, bump package versions without creating an automatic tag, commit with an imperative subject, push `main`, then `npm publish`. Verify with `npm view <package> version`.
