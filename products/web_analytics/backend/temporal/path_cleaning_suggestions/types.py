import dataclasses


@dataclasses.dataclass
class PathCleaningSuggestionsInput:
    dry_run: bool = False  # when True, generate but don't persist suggestion rows
    team_ids: list[int] | None = None  # default: WEB_ANALYTICS_PATH_CLEANING_SUGGESTIONS_TEAM_IDS
    days: int = 30
    limit: int = 300
    min_distinct_paths: int = 50
    include_configured: bool = False
    visited_within_days: int = 30  # only teams that opened Web analytics within this window
    max_concurrent: int = 4


@dataclasses.dataclass
class GenerateForTeamInput:
    team_id: int
    days: int
    limit: int
    min_distinct_paths: int
    include_configured: bool
    visited_within_days: int | None
    store: bool


@dataclasses.dataclass
class TeamSuggestionSummary:
    team_id: int
    status: str
    rule_count: int = 0
    error: str | None = None
