export type EnvelopeRecord = {
    id: string;
    totalBudgetNano: string;
    spentInWindowNano: string;
    periodSeconds: number;
    windowStartedAt: number;
    createdAt: string;
    agentIds: string[];
};

export type BrokerState = {
    envelopes: Record<string, EnvelopeRecord>;
};

export type ReserveResult = {
    envelope: EnvelopeRecord;
    remainingNano: bigint;
};

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

function normalizeWindow(envelope: EnvelopeRecord, currentNow: number): EnvelopeRecord {
    if (currentNow >= envelope.windowStartedAt + envelope.periodSeconds) {
        return {
            ...envelope,
            windowStartedAt: currentNow,
            spentInWindowNano: "0",
        };
    }

    return envelope;
}

export function emptyBrokerState(): BrokerState {
    return { envelopes: {} };
}

export function createEnvelope(args: {
    state: BrokerState;
    envelopeId: string;
    totalBudgetNano: bigint;
    periodSeconds: number;
    now?: number;
}): EnvelopeRecord {
    if (!args.envelopeId.trim()) {
        throw new Error("envelopeId is required");
    }

    if (args.totalBudgetNano <= 0n) {
        throw new Error("totalBudgetNano must be greater than 0");
    }

    if (args.periodSeconds <= 0) {
        throw new Error("periodSeconds must be greater than 0");
    }

    if (args.state.envelopes[args.envelopeId]) {
        throw new Error(`Envelope ${args.envelopeId} already exists`);
    }

    const now = args.now ?? nowSeconds();
    const envelope: EnvelopeRecord = {
        id: args.envelopeId,
        totalBudgetNano: args.totalBudgetNano.toString(),
        spentInWindowNano: "0",
        periodSeconds: args.periodSeconds,
        windowStartedAt: now,
        createdAt: new Date(now * 1000).toISOString(),
        agentIds: [],
    };

    args.state.envelopes[args.envelopeId] = envelope;
    return envelope;
}

export function assignAgentToEnvelope(args: {
    state: BrokerState;
    envelopeId: string;
    agentId: string;
}): EnvelopeRecord {
    const envelope = args.state.envelopes[args.envelopeId];
    if (!envelope) {
        throw new Error(`Envelope ${args.envelopeId} not found`);
    }

    if (!args.agentId.trim()) {
        throw new Error("agentId is required");
    }

    if (!envelope.agentIds.includes(args.agentId)) {
        envelope.agentIds.push(args.agentId);
    }

    return envelope;
}

export function getEnvelopeAllowance(args: {
    state: BrokerState;
    envelopeId: string;
    now?: number;
}): { envelope: EnvelopeRecord; remainingNano: bigint } {
    const existing = args.state.envelopes[args.envelopeId];
    if (!existing) {
        throw new Error(`Envelope ${args.envelopeId} not found`);
    }

    const normalized = normalizeWindow(existing, args.now ?? nowSeconds());
    args.state.envelopes[args.envelopeId] = normalized;

    const total = BigInt(normalized.totalBudgetNano);
    const spent = BigInt(normalized.spentInWindowNano);

    return {
        envelope: normalized,
        remainingNano: total - spent,
    };
}

export function reserveEnvelopeBudget(args: {
    state: BrokerState;
    envelopeId: string;
    agentId: string;
    amountNano: bigint;
    now?: number;
}): ReserveResult {
    if (args.amountNano <= 0n) {
        throw new Error("amountNano must be greater than 0");
    }

    const { envelope, remainingNano } = getEnvelopeAllowance({
        state: args.state,
        envelopeId: args.envelopeId,
        now: args.now,
    });

    if (!envelope.agentIds.includes(args.agentId)) {
        throw new Error(`Agent ${args.agentId} is not assigned to envelope ${args.envelopeId}`);
    }

    if (args.amountNano > remainingNano) {
        throw new Error(
            `Envelope limit exceeded for ${args.envelopeId}: remaining ${remainingNano.toString()} nano, requested ${args.amountNano.toString()} nano`
        );
    }

    const nextSpent = BigInt(envelope.spentInWindowNano) + args.amountNano;
    const updated: EnvelopeRecord = {
        ...envelope,
        spentInWindowNano: nextSpent.toString(),
    };

    args.state.envelopes[args.envelopeId] = updated;

    return {
        envelope: updated,
        remainingNano: BigInt(updated.totalBudgetNano) - nextSpent,
    };
}

export function rollbackEnvelopeReservation(args: {
    state: BrokerState;
    envelopeId: string;
    amountNano: bigint;
}): EnvelopeRecord {
    if (args.amountNano <= 0n) {
        throw new Error("amountNano must be greater than 0");
    }

    const envelope = args.state.envelopes[args.envelopeId];
    if (!envelope) {
        throw new Error(`Envelope ${args.envelopeId} not found`);
    }

    const spent = BigInt(envelope.spentInWindowNano);
    const nextSpent = spent - args.amountNano;
    if (nextSpent < 0n) {
        throw new Error(
            `Cannot rollback ${args.amountNano.toString()} nano from envelope ${args.envelopeId} with spent ${spent.toString()} nano`
        );
    }

    const updated: EnvelopeRecord = {
        ...envelope,
        spentInWindowNano: nextSpent.toString(),
    };

    args.state.envelopes[args.envelopeId] = updated;
    return updated;
}
