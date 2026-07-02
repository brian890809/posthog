import { logger } from '~/common/utils/logger'
import { BatchProcessingStep } from '~/ingestion/framework/base-batch-pipeline'
import { drop, ok } from '~/ingestion/framework/results'
import { RetentionPeriod, RetentionPeriodToDaysMap } from '~/ingestion/pipelines/sessionreplay/shared/constants'
import { SessionMap, SessionSet } from '~/ingestion/pipelines/sessionreplay/shared/session-map'
import { KeyStore, SessionKey } from '~/ingestion/pipelines/sessionreplay/shared/types'
import { TeamForReplay } from '~/ingestion/pipelines/sessionreplay/teams/types'

import { SessionFilter } from './sessions/session-filter'
import { SessionTracker } from './sessions/session-tracker'
import { SessionReplayHeaders } from './validate-headers-step'

/** A session either resolves to its encryption key, or is dropped before it reaches the recorder. */
type SessionResolution = { sessionKey: SessionKey } | { drop: string }

/**
 * Record-phase batch step: run each session's new-session bootstrap for the whole batch — off the S3
 * write path — and attach the resolved encryption key to every element, before the message is parsed
 * and recorded.
 *
 * For each distinct `(teamId, sessionId)` (deduped via a {@link SessionSet}, so the work runs once
 * per session even when the batch holds many of its messages):
 * - track the session ({@link SessionTracker}) to learn whether it's newly seen;
 * - for a new session, run the new-session rate limiter ({@link SessionFilter.handleNewSession}),
 *   which may block a team that's over its new-session budget — this consumes one token per new
 *   session, which is exactly why the work must be deduped and not repeated per message;
 * - drop the session if it's blocked;
 * - resolve its key — {@link KeyStore.generateKey} for a new session (using the retention resolved
 *   upstream to set the key's expiry), {@link KeyStore.getKey} otherwise — and drop it if the key
 *   has been deleted.
 *
 * Keys on the `session_id` header, which {@link createValidateSessionReplayHeadersStep} guarantees is
 * present, and on the retention resolved by {@link createResolveRetentionStep}, so it must run after
 * both. A transient failure (e.g. keystore Redis/KMS) throws so the pipeline's retry wrapper can
 * re-run the step; the tracker and filter fail open on Redis errors, matching prior behavior.
 */
export function createResolveSessionKeyStep<
    T extends { team: TeamForReplay; headers: SessionReplayHeaders; retentionPeriod: RetentionPeriod },
>(
    sessionTracker: SessionTracker,
    sessionFilter: SessionFilter,
    keyStore: KeyStore
): BatchProcessingStep<T, T & { sessionKey: SessionKey }> {
    return async function resolveSessionKeyStep(values) {
        // Dedupe repeated sessions so each one's Redis bootstrap runs exactly once per batch.
        const toResolve = new SessionSet()
        const retentionBySession = new SessionMap<RetentionPeriod>()
        for (const value of values) {
            toResolve.add(value.team.teamId, value.headers.session_id)
            retentionBySession.set(value.team.teamId, value.headers.session_id, value.retentionPeriod)
        }

        const resolutions = new SessionMap<SessionResolution>()
        await Promise.all(
            [...toResolve].map(async ({ teamId, sessionId }) => {
                const isNewSession = await sessionTracker.trackSession(teamId, sessionId)
                if (isNewSession) {
                    await sessionFilter.handleNewSession(teamId, sessionId)
                }

                if (await sessionFilter.isBlocked(teamId, sessionId)) {
                    resolutions.set(teamId, sessionId, { drop: 'session_blocked' })
                    return
                }

                const retentionPeriod = retentionBySession.get(teamId, sessionId)!
                const sessionKey = isNewSession
                    ? await keyStore.generateKey(sessionId, teamId, RetentionPeriodToDaysMap[retentionPeriod])
                    : await keyStore.getKey(sessionId, teamId)

                if (sessionKey.sessionState === 'deleted') {
                    resolutions.set(teamId, sessionId, { drop: 'session_deleted' })
                    return
                }

                resolutions.set(teamId, sessionId, { sessionKey })
            })
        )

        return values.map((value) => {
            const resolution = resolutions.get(value.team.teamId, value.headers.session_id)!
            if ('drop' in resolution) {
                logger.debug('🔁', 'session_replay_session_dropped_before_record', {
                    sessionId: value.headers.session_id,
                    teamId: value.team.teamId,
                    reason: resolution.drop,
                })
                return drop(resolution.drop)
            }
            return ok({ ...value, sessionKey: resolution.sessionKey })
        })
    }
}
