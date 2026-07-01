from typing import Any

from django.db import transaction

from drf_spectacular.utils import extend_schema
from rest_framework import mixins, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.request import Request
from rest_framework.response import Response

from posthog.api.routing import TeamAndOrgViewSetMixin

from products.web_analytics.backend.models import WebAnalyticsPathCleaningSuggestion
from products.web_analytics.backend.path_cleaning_suggestions.service import (
    AnnotatedRule,
    apply_suggestions_to_team,
    generate_suggestions_for_team,
)


class PathCleaningExampleSerializer(serializers.Serializer):
    before = serializers.CharField(help_text="A real sampled path before this rule is applied.")
    after = serializers.CharField(help_text="The same path after this rule's regex replacement.")


class SuggestedRuleSerializer(serializers.Serializer):
    regex = serializers.CharField(help_text="re2 pattern matching the dynamic path segment.")
    alias = serializers.CharField(help_text="Replacement with angle-bracket placeholders, e.g. /users/<id>.")
    order = serializers.IntegerField(help_text="Apply order; rules run sequentially, output feeds the next.")
    reason = serializers.CharField(
        required=False, allow_blank=True, help_text="Short rationale for the rule from the model."
    )
    match_count = serializers.IntegerField(help_text="How many of the sampled paths this rule rewrites.")
    examples = PathCleaningExampleSerializer(
        many=True, help_text="Up to 3 before/after examples on the team's real paths."
    )


class WebAnalyticsPathCleaningSuggestionSerializer(serializers.ModelSerializer):
    status = serializers.CharField(read_only=True, help_text="suggested, applied, or dismissed.")
    suggested_rules = SuggestedRuleSerializer(
        many=True, read_only=True, help_text="Validated path-cleaning rules proposed for this team."
    )

    class Meta:
        model = WebAnalyticsPathCleaningSuggestion
        fields = [
            "id",
            "created_at",
            "status",
            "model",
            "suggested_rules",
            "sampled_path_count",
            "distinct_path_count",
            "existing_rule_count",
        ]
        read_only_fields = fields


class ApplyPathCleaningSuggestionResponseSerializer(serializers.Serializer):
    applied = serializers.IntegerField(help_text="Number of rules merged into the team's path_cleaning_filters.")
    suggestion = WebAnalyticsPathCleaningSuggestionSerializer(help_text="The suggestion, now marked applied.")


class GeneratePathCleaningSuggestionResponseSerializer(serializers.Serializer):
    status = serializers.CharField(
        help_text="generated, skipped_low_cardinality, skipped_no_paths, skipped_configured, or error."
    )
    suggestion = WebAnalyticsPathCleaningSuggestionSerializer(
        required=False, allow_null=True, help_text="The created suggestion when status is generated, else null."
    )


class WebAnalyticsPathCleaningSuggestionViewSet(TeamAndOrgViewSetMixin, mixins.ListModelMixin, viewsets.GenericViewSet):
    scope_object = "web_analytics"
    serializer_class = WebAnalyticsPathCleaningSuggestionSerializer
    # Fail-closed model: `unscoped()` is the import-safe constructor; the mixin still scopes every
    # request to the URL's team_id via parents lookups.
    queryset = WebAnalyticsPathCleaningSuggestion.objects.unscoped()

    def safely_get_queryset(self, queryset: Any) -> Any:
        # Only the actionable, not-yet-handled suggestions, newest first.
        return queryset.filter(status=WebAnalyticsPathCleaningSuggestion.Status.SUGGESTED).order_by("-created_at")

    @extend_schema(
        operation_id="web_analytics_path_cleaning_suggestions_generate",
        summary="Generate path-cleaning suggestions on demand",
        description="Samples the team's recent paths, asks the LLM for cleaning rules, validates them against the "
        "real paths, and stores a suggestion. Runs even if the team already has rules. Returns the suggestion (or a "
        "skip status when there aren't enough paths to suggest from).",
        request=None,
        responses={200: GeneratePathCleaningSuggestionResponseSerializer},
    )
    @action(detail=False, methods=["post"], required_scopes=["web_analytics:write"])
    def generate(self, request: Request, **kwargs: Any) -> Response:
        result = generate_suggestions_for_team(self.team, visited_within_days=None, include_configured=True, store=True)
        suggestion = None
        if result.suggestion_id:
            suggestion = (
                WebAnalyticsPathCleaningSuggestion.objects.for_team(self.team.id)
                .filter(id=result.suggestion_id)
                .first()
            )
        return Response(
            {
                "status": result.status,
                "suggestion": WebAnalyticsPathCleaningSuggestionSerializer(suggestion).data if suggestion else None,
            }
        )

    @extend_schema(
        operation_id="web_analytics_path_cleaning_suggestions_apply",
        summary="Apply a path-cleaning suggestion",
        description="Merges the suggestion's rules into the team's path_cleaning_filters (never overwrites existing "
        "rules) and marks the suggestion applied.",
        request=None,
        responses={200: ApplyPathCleaningSuggestionResponseSerializer},
    )
    @action(detail=True, methods=["post"], required_scopes=["web_analytics:write"])
    def apply(self, request: Request, **kwargs: Any) -> Response:
        suggestion = self.get_object()
        rules = [AnnotatedRule(**rule) for rule in suggestion.suggested_rules]
        # Merge the rules and flip the status together — if the status write failed on its own the
        # banner would reappear and offer "Apply all" again for rules already applied.
        with transaction.atomic():
            added = apply_suggestions_to_team(self.team, rules)
            suggestion.status = WebAnalyticsPathCleaningSuggestion.Status.APPLIED
            suggestion.save(update_fields=["status", "updated_at"])
        return Response({"applied": added, "suggestion": WebAnalyticsPathCleaningSuggestionSerializer(suggestion).data})

    @extend_schema(
        operation_id="web_analytics_path_cleaning_suggestions_dismiss",
        summary="Dismiss a path-cleaning suggestion",
        description="Marks the suggestion dismissed so it no longer surfaces.",
        request=None,
        responses={200: WebAnalyticsPathCleaningSuggestionSerializer},
    )
    @action(detail=True, methods=["post"], required_scopes=["web_analytics:write"])
    def dismiss(self, request: Request, **kwargs: Any) -> Response:
        suggestion = self.get_object()
        suggestion.status = WebAnalyticsPathCleaningSuggestion.Status.DISMISSED
        suggestion.save(update_fields=["status", "updated_at"])
        return Response(WebAnalyticsPathCleaningSuggestionSerializer(suggestion).data)
