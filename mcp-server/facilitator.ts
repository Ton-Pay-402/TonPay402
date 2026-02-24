export type FacilitatorConfig = {
    url?: string;
    apiKey?: string;
    timeoutMs?: number;
    retryAttempts?: number;
    retryBackoffMs?: number;
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

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    const retryAttempts = Number(config.retryAttempts ?? 0);
    const retryBackoffMs = Number(config.retryBackoffMs ?? 300);
    const apiKey = config.apiKey?.trim() ?? "";

    let lastError: unknown;
    const totalAttempts = retryAttempts + 1;
    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
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

            if (body.targetAddress !== undefined && typeof body.targetAddress !== "string") {
                throw new Error("Facilitator response has invalid targetAddress type");
            }

            if (body.amountInTon !== undefined && typeof body.amountInTon !== "string") {
                throw new Error("Facilitator response has invalid amountInTon type");
            }

            return {
                targetAddress: typeof body.targetAddress === "string" ? body.targetAddress : input.targetAddress,
                amountInTon: typeof body.amountInTon === "string" ? body.amountInTon : input.amountInTon,
                reference: typeof body.reference === "string" ? body.reference : undefined,
                note: typeof body.note === "string" ? body.note : undefined,
            };
        } catch (error) {
            lastError = error;
            if (attempt < totalAttempts) {
                await sleep(retryBackoffMs * attempt);
                continue;
            }
        } finally {
            clearTimeout(timeout);
        }
    }

    const details = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`x402 facilitator integration failed: ${details}`);
}
