export type FacilitatorConfig = {
    url?: string;
    apiKey?: string;
    timeoutMs?: number;
    network: string;
};

export type FacilitatorDecision = {
    targetAddress: string;
    amountInTon: string;
    reference?: string;
    note?: string;
};

type FacilitatorRequestInput = {
    requestId: string;
    contractAddress: string;
    targetAddress: string;
    amountInTon: string;
    facilitatorContext?: unknown;
};

function parseFacilitatorJson(raw: unknown): Record<string, unknown> {
    if (!raw || typeof raw !== "object") {
        return {};
    }
    return raw as Record<string, unknown>;
}

export async function requestFacilitatorDecision(
    input: FacilitatorRequestInput,
    config: FacilitatorConfig
): Promise<FacilitatorDecision | null> {
    const url = config.url?.trim() ?? "";
    if (!url) {
        return null;
    }

    const timeoutMs = Number(config.timeoutMs ?? 15000);
    const apiKey = config.apiKey?.trim() ?? "";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
                requestId: input.requestId,
                network: config.network,
                contractAddress: input.contractAddress,
                targetAddress: input.targetAddress,
                amountInTon: input.amountInTon,
                context: input.facilitatorContext ?? null,
            }),
            signal: controller.signal,
        });

        const rawBody = await response.text();
        if (!response.ok) {
            throw new Error(`Facilitator error ${response.status}: ${rawBody || "no response body"}`);
        }

        const body = parseFacilitatorJson(rawBody ? JSON.parse(rawBody) : {});
        const accepted = typeof body.accepted === "boolean" ? body.accepted : true;
        if (!accepted) {
            const rejectionReason = typeof body.reason === "string"
                ? body.reason
                : "Facilitator rejected the payment request";
            throw new Error(rejectionReason);
        }

        return {
            targetAddress: typeof body.targetAddress === "string" ? body.targetAddress : input.targetAddress,
            amountInTon: typeof body.amountInTon === "string" ? body.amountInTon : input.amountInTon,
            reference: typeof body.reference === "string" ? body.reference : undefined,
            note: typeof body.note === "string" ? body.note : undefined,
        };
    } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        throw new Error(`x402 facilitator integration failed: ${details}`);
    } finally {
        clearTimeout(timeout);
    }
}
