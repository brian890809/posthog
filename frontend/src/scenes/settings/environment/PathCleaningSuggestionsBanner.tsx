import { useActions, useValues } from 'kea'

import { IconArrowRight } from '@posthog/icons'
import { LemonBanner } from '@posthog/lemon-ui'

import { pathCleaningSuggestionsLogic } from './pathCleaningSuggestionsLogic'

export function PathCleaningSuggestionsBanner(): JSX.Element | null {
    const { latestSuggestion, suggestionsLoading } = useValues(pathCleaningSuggestionsLogic)
    const { applySuggestion, dismissSuggestion } = useActions(pathCleaningSuggestionsLogic)

    if (suggestionsLoading || !latestSuggestion || latestSuggestion.suggested_rules.length === 0) {
        return null
    }

    const ruleCount = latestSuggestion.suggested_rules.length

    return (
        <LemonBanner
            type="info"
            className="mb-4"
            action={{
                children: 'Apply all',
                onClick: () => applySuggestion(latestSuggestion.id),
            }}
            onClose={() => dismissSuggestion(latestSuggestion.id)}
        >
            <div className="flex flex-col gap-2">
                <span>
                    We analyzed your traffic and suggest <strong>{ruleCount}</strong> path cleaning{' '}
                    {ruleCount === 1 ? 'rule' : 'rules'} to group similar pages. Review and apply them:
                </span>
                <div className="flex flex-col gap-1">
                    {latestSuggestion.suggested_rules.map((rule) => (
                        <div key={rule.order} className="flex flex-wrap items-center gap-2 font-mono text-xs">
                            <code>{rule.regex}</code>
                            <IconArrowRight />
                            <code>{rule.alias}</code>
                            <span className="text-secondary">matches {rule.match_count} paths</span>
                        </div>
                    ))}
                </div>
            </div>
        </LemonBanner>
    )
}
