from django.db import models

from posthog.models.scoping.root_mixin import TeamScopedRootMixin
from posthog.models.utils import UUIDModel


class WebAnalyticsPathCleaningSuggestion(TeamScopedRootMixin, UUIDModel):
    """One AI-generated set of suggested path-cleaning rules for a team, produced by the weekly
    suggestion job. Suggestions are never auto-applied — applying rewrites historical numbers in
    every cleaned chart, so it stays a human decision. `suggested_rules` is a list of
    `{regex, alias, order, match_count, examples}` already validated against the team's real paths."""

    class Status(models.TextChoices):
        SUGGESTED = "suggested", "Suggested"
        APPLIED = "applied", "Applied"
        DISMISSED = "dismissed", "Dismissed"

    team = models.ForeignKey("posthog.Team", on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.SUGGESTED)
    model = models.CharField(max_length=64, blank=True)
    suggested_rules = models.JSONField(default=list)
    sampled_path_count = models.IntegerField(default=0)
    distinct_path_count = models.IntegerField(default=0)
    existing_rule_count = models.IntegerField(default=0)
    error = models.TextField(null=True, blank=True)

    class Meta:
        db_table = "posthog_webanalyticspathcleaningsuggestion"
        indexes = [
            models.Index(fields=["team", "-created_at"], name="wa_pcs_team_created_idx"),
        ]
