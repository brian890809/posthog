import { PipelineResultType, isOkResult } from '~/ingestion/framework/results'
import { RetentionPeriod, RetentionPeriodToDaysMap } from '~/ingestion/pipelines/sessionreplay/shared/constants'
import { createMockSessionKey } from '~/ingestion/pipelines/sessionreplay/shared/test-helpers'
import { KeyStore } from '~/ingestion/pipelines/sessionreplay/shared/types'
import { TeamForReplay } from '~/ingestion/pipelines/sessionreplay/teams/types'

import { createResolveSessionKeyStep } from './session-batch-resolve-session-key-step'
import { SessionBatchManager } from './sessions/session-batch-manager'
import { SessionFilter } from './sessions/session-filter'
import { SessionTracker } from './sessions/session-tracker'
import { SessionReplayHeaders } from './validate-headers-step'

jest.mock('~/common/utils/logger', () => ({ logger: { debug: jest.fn() } }))

describe('createResolveSessionKeyStep', () => {
    let mockSessionTracker: jest.Mocked<Pick<SessionTracker, 'trackSession'>>
    let mockSessionFilter: jest.Mocked<Pick<SessionFilter, 'handleNewSession' | 'isBlocked'>>
    let mockKeyStore: jest.Mocked<Pick<KeyStore, 'generateKey' | 'getKey'>>
    let mockSessionBatchManager: jest.Mocked<Pick<SessionBatchManager, 'trackDroppedOffset'>>

    // Minimal element carrying just what the step reads (message offset, team, session_id header, retention).
    const element = (
        teamId: number,
        sessionId: string,
        retentionPeriod: RetentionPeriod = '30d',
        partition = 0,
        offset = 0
    ): {
        message: { partition: number; offset: number }
        team: TeamForReplay
        headers: SessionReplayHeaders
        retentionPeriod: RetentionPeriod
    } =>
        ({
            message: { partition, offset },
            team: { teamId, consoleLogIngestionEnabled: false, aiTrainingOptedIn: true },
            headers: { token: 'token', session_id: sessionId, distinct_id: 'distinct-1' },
            retentionPeriod,
        }) as unknown as {
            message: { partition: number; offset: number }
            team: TeamForReplay
            headers: SessionReplayHeaders
            retentionPeriod: RetentionPeriod
        }

    const createStep = () =>
        createResolveSessionKeyStep(
            mockSessionTracker as unknown as SessionTracker,
            mockSessionFilter as unknown as SessionFilter,
            mockKeyStore as unknown as KeyStore,
            mockSessionBatchManager as unknown as SessionBatchManager
        )

    beforeEach(() => {
        jest.clearAllMocks()
        mockSessionTracker = { trackSession: jest.fn().mockResolvedValue(false) }
        mockSessionFilter = {
            handleNewSession: jest.fn().mockResolvedValue(undefined),
            isBlocked: jest.fn().mockResolvedValue(false),
        }
        mockKeyStore = {
            generateKey: jest.fn().mockResolvedValue(createMockSessionKey()),
            getKey: jest.fn().mockResolvedValue(createMockSessionKey()),
        }
        mockSessionBatchManager = { trackDroppedOffset: jest.fn() }
    })

    it('generates a key for a new session, rate-limiting it, and attaches it', async () => {
        mockSessionTracker.trackSession.mockResolvedValue(true)
        const generated = createMockSessionKey({ encryptedKey: Buffer.from('new-key') })
        mockKeyStore.generateKey.mockResolvedValue(generated)
        const step = createStep()

        const results = await step([element(1, 'a', '90d')])

        expect(mockSessionFilter.handleNewSession).toHaveBeenCalledWith(1, 'a')
        // New sessions generate a key whose expiry is the resolved retention.
        expect(mockKeyStore.generateKey).toHaveBeenCalledWith('a', 1, RetentionPeriodToDaysMap['90d'])
        expect(mockKeyStore.getKey).not.toHaveBeenCalled()
        expect(isOkResult(results[0]) ? results[0].value.sessionKey : null).toBe(generated)
    })

    it('fetches the existing key for a seen session without rate-limiting it', async () => {
        mockSessionTracker.trackSession.mockResolvedValue(false)
        const existing = createMockSessionKey({ encryptedKey: Buffer.from('existing-key') })
        mockKeyStore.getKey.mockResolvedValue(existing)
        const step = createStep()

        const results = await step([element(1, 'a')])

        expect(mockSessionFilter.handleNewSession).not.toHaveBeenCalled()
        expect(mockKeyStore.getKey).toHaveBeenCalledWith('a', 1)
        expect(mockKeyStore.generateKey).not.toHaveBeenCalled()
        expect(isOkResult(results[0]) ? results[0].value.sessionKey : null).toBe(existing)
    })

    it('runs each session bootstrap once and fans the key out to all of its messages', async () => {
        mockSessionTracker.trackSession.mockResolvedValue(true)
        const generated = createMockSessionKey({ encryptedKey: Buffer.from('shared-key') })
        mockKeyStore.generateKey.mockResolvedValue(generated)
        const step = createStep()

        const results = await step([element(1, 'a'), element(1, 'a'), element(1, 'a')])

        // A new session must be tracked, rate-limited, and keyed exactly once, no matter how many of
        // its messages are in the batch — repeating would over-consume the new-session budget and
        // regenerate the key.
        expect(mockSessionTracker.trackSession).toHaveBeenCalledTimes(1)
        expect(mockSessionFilter.handleNewSession).toHaveBeenCalledTimes(1)
        expect(mockKeyStore.generateKey).toHaveBeenCalledTimes(1)
        expect(results.map((r) => (isOkResult(r) ? r.value.sessionKey : null))).toEqual([
            generated,
            generated,
            generated,
        ])
    })

    it('keys resolutions by (teamId, sessionId) across a mixed batch', async () => {
        const keyA = createMockSessionKey({ encryptedKey: Buffer.from('key-a') })
        const keyB = createMockSessionKey({ encryptedKey: Buffer.from('key-b') })
        mockKeyStore.getKey.mockImplementation((sessionId: string, teamId: number) =>
            Promise.resolve(teamId === 1 ? keyA : keyB)
        )
        const step = createStep()

        const results = await step([element(1, 'shared'), element(2, 'shared')])

        // Same session id, different teams must not collide.
        expect(results.map((r) => (isOkResult(r) ? r.value.sessionKey : null))).toEqual([keyA, keyB])
    })

    it('drops a blocked session without resolving a key, tracking its offset, keeping the rest', async () => {
        mockSessionFilter.isBlocked.mockImplementation((_teamId: number, sessionId: string) =>
            Promise.resolve(sessionId === 'blocked')
        )
        const step = createStep()

        const results = await step([element(1, 'blocked', '30d', 4, 42), element(1, 'ok')])

        expect(results[0].type).toBe(PipelineResultType.DROP)
        expect(isOkResult(results[1])).toBe(true)
        // A blocked session never resolves a key.
        expect(mockKeyStore.getKey).not.toHaveBeenCalledWith('blocked', 1)
        // The dropped message must still track its offset or its partition could replay forever.
        expect(mockSessionBatchManager.trackDroppedOffset).toHaveBeenCalledTimes(1)
        expect(mockSessionBatchManager.trackDroppedOffset).toHaveBeenCalledWith(4, 42)
    })

    it('rate-limits then blocks a brand-new session in the same batch, dropping it', async () => {
        // A new session runs handleNewSession (which may block it via its own budget) before the
        // block check — so a new session can be dropped by the block it just tripped. Reordering
        // isBlocked before handleNewSession would regress this.
        mockSessionTracker.trackSession.mockResolvedValue(true)
        mockSessionFilter.isBlocked.mockResolvedValue(true)
        const step = createStep()

        const results = await step([element(1, 'new-and-blocked', '30d', 2, 7)])

        expect(mockSessionFilter.handleNewSession).toHaveBeenCalledWith(1, 'new-and-blocked')
        expect(results[0].type).toBe(PipelineResultType.DROP)
        expect(mockSessionBatchManager.trackDroppedOffset).toHaveBeenCalledWith(2, 7)
    })

    it('drops a session whose key has been deleted, tracking its offset', async () => {
        mockKeyStore.getKey.mockResolvedValue(createMockSessionKey({ sessionState: 'deleted', deletedAt: 1 }))
        const step = createStep()

        const results = await step([element(1, 'gone', '30d', 3, 9)])

        expect(results[0].type).toBe(PipelineResultType.DROP)
        expect(mockSessionBatchManager.trackDroppedOffset).toHaveBeenCalledWith(3, 9)
    })

    it('propagates a keystore failure so the retry wrapper can retry the whole step', async () => {
        mockSessionTracker.trackSession.mockResolvedValue(true)
        mockKeyStore.generateKey.mockRejectedValue(new Error('KMS unavailable'))
        const step = createStep()

        await expect(step([element(1, 'a')])).rejects.toThrow('KMS unavailable')
    })
})
