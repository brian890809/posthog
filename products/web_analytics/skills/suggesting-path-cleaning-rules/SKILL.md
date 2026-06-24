---
name: suggesting-path-cleaning-rules
description: 'Runs and reasons about the automated AI job that suggests path-cleaning rules for web-analytics teams. Use when asked to generate path-cleaning suggestions for a team or cohort, to run the weekly suggestion job, to review/apply AI-suggested rules, to inspect WebAnalyticsPathCleaningSuggestion rows, or to extend the suggestion pipeline. Covers the suggest_path_cleaning_rules management command, the wa-path-cleaning-suggestions Temporal workflow, the cohort gating (precompute teams), and how suggestions are validated against real paths before storage. For hand-authoring or applying rules directly, use managing-path-cleaning-rules instead.'
---

# Suggesting path-cleaning rules

Many teams never configure path cleaning, so their Web analytics breakdowns fragment across
thousands of near-identical URLs. This feature **proactively suggests** cleaning rules for the
web-analytics precompute cohort: weekly, for each team, it samples real paths, asks the LLM for
`{regex, alias}` rules, validates them against the team's own paths, and stores them for review.

It **only suggests** — it never auto-applies. Applying rewrites historical numbers in every cleaned
chart, so that stays a human decision (the existing settings UI, or the `--apply` flag below after
review). To hand-author or directly apply rules, use the `managing-path-cleaning-rules` skill.

## Architecture

- **Core**: `products/web_analytics/backend/path_cleaning_suggestions/service.py`
  - `sample_pathnames` / `count_distinct_pathnames` — top `$pathname` by views via HogQL.
  - `call_llm_for_rules` — one-shot call through the LLM gateway
    (`get_llm_client(product="web_analytics", team_id=...)`, model
    `WEB_ANALYTICS_PATH_CLEANING_SUGGESTIONS_MODEL`, default `claude-haiku-4-5`).
  - `validate_and_annotate_rules` — compiles each regex with **re2** (the engine ClickHouse
    `replaceRegexpAll` uses) and test-applies it to the sampled paths. Rules that don't compile or
    match nothing are dropped; survivors get a dense `order`, a `match_count`, and before/after
    `examples`. This is the skill's "test before saving" step, automated.
  - `generate_suggestions_for_team` — orchestrates the above with gating (see below) and stores a
    `WebAnalyticsPathCleaningSuggestion` row.
  - `apply_suggestions_to_team` — **merges** rules into `path_cleaning_filters`, never overwrites
    (dedupes by regex, continues `order`).
- **Storage**: `WebAnalyticsPathCleaningSuggestion` (team-scoped, fail-closed). One row per run per
  team: `suggested_rules`, `status` (suggested/applied/dismissed), `sampled_path_count`,
  `distinct_path_count`, `existing_rule_count`, `model`, `error`.
- **Schedule**: `wa-path-cleaning-suggestions` Temporal workflow, weekly (Tue 6 AM PT), fans out per
  team. Registered on `MESSAGING_TASK_QUEUE` alongside the WA digest workflows.
- **Cohort**: `WEB_ANALYTICS_PATH_CLEANING_SUGGESTIONS_TEAM_IDS`, defaulting to the precompute
  enrollment list `WEB_ANALYTICS_LAZY_PRECOMPUTE_TEAM_IDS`.

## Gating (why a team is skipped)

`generate_suggestions_for_team` returns a status:

- `skipped_inactive` — team sent no `$pageview` within `visited_within_days` (default 30); we only
  suggest for teams actively using web analytics. Bypass with `--ignore-visit-gate`.
- `skipped_configured` — team already has path cleaning rules (override with `include_configured`).
- `skipped_low_cardinality` — fewer distinct paths than `min_distinct_paths` (default 50); cleaning
  adds no value, so we don't spend tokens.
- `skipped_no_paths` — no pageviews in the window.
- `generated` — rules produced (may be an empty list if paths are already clean).
- `error` — sampling/LLM failed; captured per-team, never aborts the cohort sweep.

## How users see and apply suggestions

- **Settings banner**: `PathCleaningSuggestionsBanner` on `/settings/project#path_cleaning` shows the
  latest `suggested` row with before/after previews; "Apply all" merges the rules, the close button
  dismisses. Driven by `pathCleaningSuggestionsLogic`.
- **Onboarding step**: `OnboardingWebAnalyticsPathCleaningStep` (stepKey `path_cleaning`) surfaces the
  same banner during Web analytics onboarding.
- **API** (`products/web_analytics/backend/api/web_analytics_path_cleaning_suggestions.py`):
  `GET /api/projects/:id/web_analytics_path_cleaning_suggestions/` lists `suggested` rows;
  `POST .../generate/` produces fresh suggestions on demand; `POST .../{id}/apply/` merges + marks
  applied; `POST .../{id}/dismiss/` marks dismissed. Frontend uses the generated functions
  (`webAnalyticsPathCleaningSuggestions*`).
- **PostHog AI (Max)**: the same operations are exposed as MCP tools in
  `products/web_analytics/mcp/tools.yaml` (`web-analytics-path-cleaning-suggestions-{list,generate,apply,dismiss}`),
  so a user can ask Max to suggest path-cleaning rules and apply them conversationally. Apply is
  flagged as changing historical chart numbers, so Max confirms before applying.

## Running it

```sh
# Default cohort, print suggestions, store rows:
python manage.py suggest_path_cleaning_rules

# Specific teams, dry run (no rows stored):
python manage.py suggest_path_cleaning_rules --teams 2,19279 --no-store

# Generate AND apply for one reviewed team (merges, never overwrites):
python manage.py suggest_path_cleaning_rules --teams 2 --apply
```

Useful flags: `--days` (lookback), `--limit` (top-N paths sampled), `--min-distinct-paths`,
`--include-configured`, `--no-store`, `--apply`.

To run the whole workflow once manually:

```sh
python manage.py start_temporal_workflow wa-path-cleaning-suggestions '{"dry_run": true}'
```

## Reviewing suggestions

Read the latest run per team (fail-closed manager — always scope by team):

```python
WebAnalyticsPathCleaningSuggestion.objects.for_team(team_id).order_by("-created_at").first()
```

Each rule in `suggested_rules` carries `match_count` and `examples` (before/after on the team's real
paths) — that's what to show a human deciding whether to apply.

## Extending

- Adding a surfacing channel (in-app notification, settings banner, onboarding wizard step): read a
  team's latest `suggested` row and render its `suggested_rules`. Keep apply manual.
- Changing the model: it must be allowlisted for the `web_analytics` product in
  `services/llm-gateway/src/llm_gateway/products/config.py`.
- The agentic alternative — a `signals-scout-web-analytics-path-cleaning` scout — is sketched in the
  design notes; prefer the dedicated job for the precompute cohort because it targets that exact
  cohort and surfaces structured, validated rows rather than Signals-inbox findings.
