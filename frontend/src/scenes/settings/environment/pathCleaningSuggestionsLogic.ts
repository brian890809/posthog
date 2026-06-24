import { actions, afterMount, connect, kea, listeners, path, reducers, selectors } from 'kea'
import { loaders } from 'kea-loaders'

import { lemonToast } from '@posthog/lemon-ui'

import { teamLogic } from 'scenes/teamLogic'

import {
    webAnalyticsPathCleaningSuggestionsApply,
    webAnalyticsPathCleaningSuggestionsDismiss,
    webAnalyticsPathCleaningSuggestionsList,
} from 'products/web_analytics/frontend/generated/api'
import type { WebAnalyticsPathCleaningSuggestionApi } from 'products/web_analytics/frontend/generated/api.schemas'

import type { pathCleaningSuggestionsLogicType } from './pathCleaningSuggestionsLogicType'

export const pathCleaningSuggestionsLogic = kea<pathCleaningSuggestionsLogicType>([
    path(['scenes', 'settings', 'environment', 'pathCleaningSuggestionsLogic']),
    connect(() => ({
        values: [teamLogic, ['currentTeamId']],
        actions: [teamLogic, ['loadCurrentTeam']],
    })),
    actions({
        applySuggestion: (id: string) => ({ id }),
        dismissSuggestion: (id: string) => ({ id }),
    }),
    loaders(({ values }) => ({
        suggestions: [
            [] as WebAnalyticsPathCleaningSuggestionApi[],
            {
                loadSuggestions: async () => {
                    if (!values.currentTeamId) {
                        return []
                    }
                    const response = await webAnalyticsPathCleaningSuggestionsList(String(values.currentTeamId))
                    return response.results
                },
            },
        ],
    })),
    reducers({
        // Optimistically hide a suggestion the moment it's applied or dismissed.
        handledIds: [
            [] as string[],
            {
                applySuggestion: (state, { id }) => [...state, id],
                dismissSuggestion: (state, { id }) => [...state, id],
            },
        ],
    }),
    selectors({
        latestSuggestion: [
            (s) => [s.suggestions, s.handledIds],
            (suggestions, handledIds): WebAnalyticsPathCleaningSuggestionApi | null =>
                suggestions.find((suggestion) => !handledIds.includes(suggestion.id)) ?? null,
        ],
    }),
    listeners(({ values, actions }) => ({
        applySuggestion: async ({ id }) => {
            if (!values.currentTeamId) {
                return
            }
            const result = await webAnalyticsPathCleaningSuggestionsApply(String(values.currentTeamId), id)
            lemonToast.success(`Applied ${result.applied} path cleaning rule${result.applied === 1 ? '' : 's'}`)
            // Refresh the team so the rules table reflects the merged path_cleaning_filters.
            actions.loadCurrentTeam()
        },
        dismissSuggestion: async ({ id }) => {
            if (!values.currentTeamId) {
                return
            }
            await webAnalyticsPathCleaningSuggestionsDismiss(String(values.currentTeamId), id)
        },
    })),
    afterMount(({ actions }) => {
        actions.loadSuggestions()
    }),
])
