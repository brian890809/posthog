from products.web_analytics.backend.temporal.path_cleaning_suggestions.activities import (
    generate_path_cleaning_suggestions_for_team,
    resolve_path_cleaning_team_ids,
)
from products.web_analytics.backend.temporal.path_cleaning_suggestions.workflows import (
    WAPathCleaningSuggestionsWorkflow,
)

WORKFLOWS = [WAPathCleaningSuggestionsWorkflow]
ACTIVITIES = [
    resolve_path_cleaning_team_ids,
    generate_path_cleaning_suggestions_for_team,
]
