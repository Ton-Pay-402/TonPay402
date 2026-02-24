import {
    assignAgentToEnvelope,
    createEnvelope,
    emptyBrokerState,
    getEnvelopeAllowance,
    reserveEnvelopeBudget,
    rollbackEnvelopeReservation,
} from '../mcp-server/broker';

describe('broker envelopes', () => {
    it('creates envelope, assigns agent, and reserves budget within allowance', () => {
        const state = emptyBrokerState();
        createEnvelope({
            state,
            envelopeId: 'ops',
            totalBudgetNano: 1_000_000_000n,
            periodSeconds: 3600,
            now: 100,
        });

        assignAgentToEnvelope({ state, envelopeId: 'ops', agentId: 'agent-a' });

        const reservation = reserveEnvelopeBudget({
            state,
            envelopeId: 'ops',
            agentId: 'agent-a',
            amountNano: 400_000_000n,
            now: 120,
        });

        expect(reservation.remainingNano).toBe(600_000_000n);
        const allowance = getEnvelopeAllowance({ state, envelopeId: 'ops', now: 130 });
        expect(allowance.remainingNano).toBe(600_000_000n);
    });

    it('rejects reserve for unassigned agent', () => {
        const state = emptyBrokerState();
        createEnvelope({
            state,
            envelopeId: 'shared',
            totalBudgetNano: 1_000_000_000n,
            periodSeconds: 3600,
        });

        expect(() => reserveEnvelopeBudget({
            state,
            envelopeId: 'shared',
            agentId: 'agent-x',
            amountNano: 1n,
        })).toThrow('is not assigned to envelope');
    });

    it('resets spent budget when period window rolls over', () => {
        const state = emptyBrokerState();
        createEnvelope({
            state,
            envelopeId: 'daily',
            totalBudgetNano: 10n,
            periodSeconds: 10,
            now: 100,
        });
        assignAgentToEnvelope({ state, envelopeId: 'daily', agentId: 'agent-a' });
        reserveEnvelopeBudget({
            state,
            envelopeId: 'daily',
            agentId: 'agent-a',
            amountNano: 8n,
            now: 105,
        });

        const afterReset = getEnvelopeAllowance({ state, envelopeId: 'daily', now: 111 });
        expect(afterReset.remainingNano).toBe(10n);
    });

    it('rolls back reserved budget after downstream failure', () => {
        const state = emptyBrokerState();
        createEnvelope({
            state,
            envelopeId: 'rollback',
            totalBudgetNano: 100n,
            periodSeconds: 3600,
        });
        assignAgentToEnvelope({ state, envelopeId: 'rollback', agentId: 'agent-r' });

        reserveEnvelopeBudget({
            state,
            envelopeId: 'rollback',
            agentId: 'agent-r',
            amountNano: 30n,
        });
        rollbackEnvelopeReservation({
            state,
            envelopeId: 'rollback',
            amountNano: 30n,
        });

        const allowance = getEnvelopeAllowance({ state, envelopeId: 'rollback' });
        expect(allowance.remainingNano).toBe(100n);
    });

    it('simulates execute_envelope_payment flow and keeps reservation on success but rolls back on failure', async () => {
        const state = emptyBrokerState();
        createEnvelope({
            state,
            envelopeId: 'flow',
            totalBudgetNano: 1_000n,
            periodSeconds: 3600,
        });
        assignAgentToEnvelope({ state, envelopeId: 'flow', agentId: 'agent-flow' });

        // Success path: reservation should remain consumed.
        reserveEnvelopeBudget({
            state,
            envelopeId: 'flow',
            agentId: 'agent-flow',
            amountNano: 250n,
        });
        let allowance = getEnvelopeAllowance({ state, envelopeId: 'flow' });
        expect(allowance.remainingNano).toBe(750n);

        // Failure path: reserve then rollback, leaving only the successful spend.
        reserveEnvelopeBudget({
            state,
            envelopeId: 'flow',
            agentId: 'agent-flow',
            amountNano: 100n,
        });
        rollbackEnvelopeReservation({
            state,
            envelopeId: 'flow',
            amountNano: 100n,
        });

        allowance = getEnvelopeAllowance({ state, envelopeId: 'flow' });
        expect(allowance.remainingNano).toBe(750n);
    });
});
