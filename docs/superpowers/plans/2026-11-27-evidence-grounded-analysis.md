# Evidence-grounded analysis implementation plan

> **For agentic workers** — Use superpowers:executing-plans for the implementation. Steps use checkboxes for tracking.

**Goal** — Generate release conclusions, analytical answers and Redmine drafts from evidence for the selected scope.

**Architecture** — Keep evidence selection, calculations, source versions, access and Redmine targets on the server. Give the model named evidence items and accept claims only when they cite items from the scoped catalog. Preserve existing previews, saved versions and factual views when generation is unavailable.

**Tech stack** — Node.js, SQLite, Zod, React, Playwright.

**Spec** — The request in this chat, including the Kaspersky R-09 and T-07 reproduction.

## Global constraints

- Calculate metrics on the server.
- Resolve citations to a saved version and row.
- Limit source selection and model context to the product, release, period and permissions.
- Keep Redmine writes behind explicit confirmation and preserve the user's task selection.
- Show evidence gaps and allow retries after model failure.

## Review focus

- The selected task can differ from the strongest evidence. The preview must keep the selected key.
- A historical date can predate an approved revision of an older row. The historical catalog must use the older version.
- Undated research can be useful in a current decision but is excluded from historical evidence.
- The same archive may contain another product's records. An invented or out-of-scope citation must fail before saving.
- Users may browse and search while the model is unavailable. Retrying must keep the selected scope.

## Task 1. Release evidence and generation

Files — server/release-decision.mjs, server/analysis-composer.mjs, server/workspace-operations.mjs, server/workbench.mjs, server/effect-plan.mjs, server/account-release.mjs, web/release-decision.tsx, web/tracking.tsx, tests/release-analysis.test.mjs and tests/workspace.browser.mjs.

- [x] Reproduce the fixed release draft with the normal HTTP routes and a fixture model. Assert independently computed means, distinct interview findings, missing interview, a historical revision, a foreign citation, and zero Redmine writes before confirmation.
- [x] Replace decision prose with structured evidence. Add release-analysis for the saved context and call the same composer from release-tracker-draft after resolving the selected key.
- [x] Render claims with row links, show preparation errors beside the action, and keep facts available. Run node --test tests/release-analysis.test.mjs and exercise the browser path from button to preview, source row and confirmation.

## Task 2. Other analytical entry points

Files — server/chat-brief.mjs, server/workbench.mjs, server/workspace-agent.mjs, server/archive-search.mjs, server/backlog.mjs, server/investigation-engine.mjs, server/presentation-case.mjs, server/presentations.mjs and existing scenario tests.

- [x] Capture regressions for the canned next-step reply, synthetic backlog recommendation, hardcoded observation criterion and deck decision.
- [x] Send analytical chat shortcuts through evidence-based generation. Preserve direct calculation and lookup results. Keep investigation and knowledge outputs tied to their saved evidence and remove canned recommendations. Presentations use a cited editorial conclusion or a documented status with factual slides.
- [x] Run focused tests, pnpm test, pnpm build and pnpm test:ui. Review pending drafts from older versions, retries, source permissions and every remaining user-facing template.

## Verification

- `pnpm test` passed all 282 tests with the organizer archive, the archive browser scenario and three migration fixtures enabled.
- `pnpm test:ui` passed all 43 browser tests and built the application.
- On the organizer archive, the browser preview kept T-07 selected, included the index and the saved interview row, and recorded exactly one comment after confirmation.
- Reproducible inputs covered two distinct releases, a release without interviews, an unavailable model, a foreign citation and a historical workbook revision. The historical chat also rejected foreign workbook access and excluded later corrections.
