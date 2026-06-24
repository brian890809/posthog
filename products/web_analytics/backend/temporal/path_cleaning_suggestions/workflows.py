import json
import asyncio
import dataclasses
from datetime import timedelta

from temporalio import workflow

from posthog.temporal.common.base import PostHogWorkflow

with workflow.unsafe.imports_passed_through():
    from products.web_analytics.backend.temporal.digest_common import ACTIVITY_RETRY_POLICY
    from products.web_analytics.backend.temporal.path_cleaning_suggestions.activities import (
        generate_path_cleaning_suggestions_for_team,
        resolve_path_cleaning_team_ids,
    )
    from products.web_analytics.backend.temporal.path_cleaning_suggestions.types import (
        GenerateForTeamInput,
        PathCleaningSuggestionsInput,
        TeamSuggestionSummary,
    )


@workflow.defn(name="wa-path-cleaning-suggestions")
class WAPathCleaningSuggestionsWorkflow(PostHogWorkflow):
    """Weekly: for each team in the precompute cohort, sample its paths, ask the LLM for cleaning
    rules, validate them against the real paths, and store the suggestions for human review. Suggests
    only — never applies."""

    @staticmethod
    def parse_inputs(inputs: list[str]) -> PathCleaningSuggestionsInput:
        if inputs:
            data = json.loads(inputs[0])
            return PathCleaningSuggestionsInput(
                **{f.name: data[f.name] for f in dataclasses.fields(PathCleaningSuggestionsInput) if f.name in data}
            )
        return PathCleaningSuggestionsInput()

    @workflow.run
    async def run(self, input: PathCleaningSuggestionsInput | None = None) -> dict:
        if input is None:
            input = PathCleaningSuggestionsInput()

        team_ids = await workflow.execute_activity(
            resolve_path_cleaning_team_ids,
            input,
            start_to_close_timeout=timedelta(minutes=1),
            retry_policy=ACTIVITY_RETRY_POLICY,
        )

        if not team_ids:
            workflow.logger.info("No teams configured for path-cleaning suggestions")
            return {"teams": 0, "by_status": {}}

        semaphore = asyncio.Semaphore(input.max_concurrent)

        async def _run_team(team_id: int) -> TeamSuggestionSummary:
            async with semaphore:
                return await workflow.execute_activity(
                    generate_path_cleaning_suggestions_for_team,
                    GenerateForTeamInput(
                        team_id=team_id,
                        days=input.days,
                        limit=input.limit,
                        min_distinct_paths=input.min_distinct_paths,
                        include_configured=input.include_configured,
                        visited_within_days=input.visited_within_days,
                        store=not input.dry_run,
                    ),
                    start_to_close_timeout=timedelta(minutes=10),
                    heartbeat_timeout=timedelta(minutes=2),
                    retry_policy=ACTIVITY_RETRY_POLICY,
                )

        results = await asyncio.gather(*[_run_team(tid) for tid in team_ids], return_exceptions=True)

        by_status: dict[str, int] = {}
        rules_total = 0
        for team_id, r in zip(team_ids, results):
            if isinstance(r, BaseException):
                by_status["error"] = by_status.get("error", 0) + 1
                workflow.logger.error("Path-cleaning suggestion failed for team %s: %s", team_id, str(r))
            else:
                by_status[r.status] = by_status.get(r.status, 0) + 1
                rules_total += r.rule_count

        return {"teams": len(team_ids), "rules_suggested": rules_total, "by_status": by_status}
