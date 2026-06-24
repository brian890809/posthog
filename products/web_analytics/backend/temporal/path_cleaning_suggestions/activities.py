from django.conf import settings
from django.db import close_old_connections

import structlog
from temporalio import activity

from posthog.models import Team
from posthog.sync import database_sync_to_async
from posthog.temporal.common.heartbeat import Heartbeater

from products.web_analytics.backend.path_cleaning_suggestions.service import generate_suggestions_for_team
from products.web_analytics.backend.temporal.path_cleaning_suggestions.types import (
    GenerateForTeamInput,
    PathCleaningSuggestionsInput,
    TeamSuggestionSummary,
)

logger = structlog.get_logger(__name__)


def _resolve_team_ids(input: PathCleaningSuggestionsInput) -> list[int]:
    if input.team_ids:
        return list(input.team_ids)
    return list(settings.WEB_ANALYTICS_PATH_CLEANING_SUGGESTIONS_TEAM_IDS)


@activity.defn(name="wa-path-cleaning-resolve-teams")
async def resolve_path_cleaning_team_ids(input: PathCleaningSuggestionsInput) -> list[int]:
    return await database_sync_to_async(_resolve_team_ids, thread_sensitive=False)(input)


def _generate_for_team(input: GenerateForTeamInput) -> TeamSuggestionSummary:
    close_old_connections()
    try:
        team = Team.objects.get(id=input.team_id)
    except Team.DoesNotExist:
        return TeamSuggestionSummary(team_id=input.team_id, status="error", error="team not found")

    result = generate_suggestions_for_team(
        team,
        days=input.days,
        limit=input.limit,
        min_distinct_paths=input.min_distinct_paths,
        include_configured=input.include_configured,
        visited_within_days=input.visited_within_days,
        store=input.store,
    )
    return TeamSuggestionSummary(
        team_id=input.team_id,
        status=result.status,
        rule_count=len(result.rules),
        error=result.error,
    )


@activity.defn(name="wa-path-cleaning-generate-for-team")
async def generate_path_cleaning_suggestions_for_team(input: GenerateForTeamInput) -> TeamSuggestionSummary:
    async with Heartbeater():
        return await database_sync_to_async(_generate_for_team, thread_sensitive=False)(input)
