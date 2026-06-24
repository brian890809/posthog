from posthog.test.base import APIBaseTest
from unittest.mock import patch

from rest_framework import status

from posthog.models import Organization, Team

from products.web_analytics.backend.models import WebAnalyticsPathCleaningSuggestion
from products.web_analytics.backend.path_cleaning_suggestions import service
from products.web_analytics.backend.path_cleaning_suggestions.prompts import SuggestedRule, SuggestedRulesResponse

RULES = [
    {
        "regex": r"/users/\d+/profile",
        "alias": "/users/<id>/profile",
        "order": 0,
        "reason": "user id",
        "match_count": 3,
        "examples": [{"before": "/users/1/profile", "after": "/users/<id>/profile"}],
    }
]


class TestPathCleaningSuggestionsAPI(APIBaseTest):
    def _url(self, suffix: str = "") -> str:
        return f"/api/projects/{self.team.id}/web_analytics_path_cleaning_suggestions/{suffix}"

    def _make_suggestion(self, team: Team, status_value: str = WebAnalyticsPathCleaningSuggestion.Status.SUGGESTED):
        return WebAnalyticsPathCleaningSuggestion.objects.for_team(team.id).create(
            team=team, status=status_value, model="claude-haiku-4-5", suggested_rules=RULES
        )

    def test_list_returns_only_suggested_rows_for_team(self) -> None:
        self._make_suggestion(self.team)
        self._make_suggestion(self.team, WebAnalyticsPathCleaningSuggestion.Status.DISMISSED)

        response = self.client.get(self._url())
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        results = response.json()["results"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["suggested_rules"][0]["alias"], "/users/<id>/profile")

    def test_apply_merges_rules_and_marks_applied(self) -> None:
        self.team.path_cleaning_filters = []
        self.team.save()
        suggestion = self._make_suggestion(self.team)

        response = self.client.post(self._url(f"{suggestion.id}/apply/"))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json()["applied"], 1)

        self.team.refresh_from_db()
        self.assertEqual(self.team.path_cleaning_filters[0]["regex"], r"/users/\d+/profile")
        suggestion.refresh_from_db()
        self.assertEqual(suggestion.status, WebAnalyticsPathCleaningSuggestion.Status.APPLIED)

    def test_apply_does_not_overwrite_existing_rules(self) -> None:
        self.team.path_cleaning_filters = [{"regex": r"/keep", "alias": "/keep", "order": 0}]
        self.team.save()
        suggestion = self._make_suggestion(self.team)

        self.client.post(self._url(f"{suggestion.id}/apply/"))
        self.team.refresh_from_db()
        regexes = [f["regex"] for f in self.team.path_cleaning_filters]
        self.assertIn(r"/keep", regexes)
        self.assertIn(r"/users/\d+/profile", regexes)

    def test_dismiss_marks_dismissed_and_drops_from_list(self) -> None:
        suggestion = self._make_suggestion(self.team)
        response = self.client.post(self._url(f"{suggestion.id}/dismiss/"))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        suggestion.refresh_from_db()
        self.assertEqual(suggestion.status, WebAnalyticsPathCleaningSuggestion.Status.DISMISSED)
        self.assertEqual(len(self.client.get(self._url()).json()["results"]), 0)

    def test_generate_creates_and_returns_suggestion(self) -> None:
        self.team.path_cleaning_filters = []
        self.team.save()
        llm_response = SuggestedRulesResponse(
            rules=[SuggestedRule(regex=r"/users/\d+/profile", alias="/users/<id>/profile")]
        )
        with (
            patch.object(service, "count_distinct_pathnames", return_value=500),
            patch.object(service, "sample_pathnames", return_value=[("/users/1/profile", 5), ("/users/2/profile", 3)]),
            patch.object(service, "call_llm_for_rules", return_value=llm_response),
        ):
            response = self.client.post(self._url("generate/"))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        body = response.json()
        self.assertEqual(body["status"], "generated")
        self.assertEqual(len(body["suggestion"]["suggested_rules"]), 1)
        self.assertEqual(body["suggestion"]["suggested_rules"][0]["alias"], "/users/<id>/profile")

    def test_cannot_apply_another_teams_suggestion(self) -> None:
        other_team = Team.objects.create(organization=Organization.objects.create(name="other"))
        other_suggestion = self._make_suggestion(other_team)

        response = self.client.post(self._url(f"{other_suggestion.id}/apply/"))
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertNotIn(str(other_suggestion.id), [r["id"] for r in self.client.get(self._url()).json()["results"]])
