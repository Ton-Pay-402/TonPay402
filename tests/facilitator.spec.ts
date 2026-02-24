import { requestFacilitatorDecision } from '../mcp-server/facilitator';

describe('x402 facilitator decision', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('applies facilitator returned target/amount/reference on accept', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                accepted: true,
                targetAddress: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c',
                amountInTon: '0.25',
                reference: 'aeon-ref-1',
                note: 'priced via facilitator',
            }),
        } as Response);

        const result = await requestFacilitatorDecision({
            requestId: 'req-1',
            contractAddress: 'EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBRs8',
            targetAddress: 'EQCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCClzv',
            amountInTon: '0.1',
            facilitatorContext: { resource: '/weather', method: 'GET' },
        }, {
            url: 'https://facilitator.local/decide',
            apiKey: 'test-key',
            timeoutMs: 1000,
            network: 'testnet',
        });

        expect(result).toEqual({
            targetAddress: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c',
            amountInTon: '0.25',
            reference: 'aeon-ref-1',
            note: 'priced via facilitator',
        });
    });

    it('throws descriptive error when facilitator rejects', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                accepted: false,
                reason: 'insufficient prepaid balance',
            }),
        } as Response);

        await expect(requestFacilitatorDecision({
            requestId: 'req-2',
            contractAddress: 'EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBRs8',
            targetAddress: 'EQCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCClzv',
            amountInTon: '0.1',
        }, {
            url: 'https://facilitator.local/decide',
            timeoutMs: 1000,
            network: 'testnet',
        })).rejects.toThrow('x402 facilitator integration failed: insufficient prepaid balance');
    });

    it('aborts and throws descriptive timeout path error', async () => {
        global.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
            return new Promise((_resolve, reject) => {
                const signal = init?.signal;
                if (signal) {
                    signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
                }
            });
        });

        await expect(requestFacilitatorDecision({
            requestId: 'req-3',
            contractAddress: 'EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBRs8',
            targetAddress: 'EQCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCClzv',
            amountInTon: '0.1',
        }, {
            url: 'https://facilitator.local/decide',
            timeoutMs: 1,
            network: 'testnet',
        })).rejects.toThrow('x402 facilitator integration failed: The operation was aborted');
    });

    it('retries transient facilitator failures and succeeds on later attempt', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 503,
                text: async () => 'upstream unavailable',
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ accepted: true }),
            } as Response);

        const result = await requestFacilitatorDecision({
            requestId: 'req-4',
            contractAddress: 'EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBRs8',
            targetAddress: 'EQCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCClzv',
            amountInTon: '0.3',
        }, {
            url: 'https://facilitator.local/decide',
            timeoutMs: 1000,
            retryAttempts: 1,
            retryBackoffMs: 0,
            network: 'testnet',
        });

        expect(result).toEqual({
            targetAddress: 'EQCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCClzv',
            amountInTon: '0.3',
            reference: undefined,
            note: undefined,
        });
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('throws when facilitator returns invalid amount type', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ accepted: true, amountInTon: 10 }),
        } as Response);

        await expect(requestFacilitatorDecision({
            requestId: 'req-5',
            contractAddress: 'EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBRs8',
            targetAddress: 'EQCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCClzv',
            amountInTon: '0.4',
        }, {
            url: 'https://facilitator.local/decide',
            timeoutMs: 1000,
            network: 'testnet',
        })).rejects.toThrow('x402 facilitator integration failed: Facilitator response has invalid amountInTon type');
    });

    it('returns null and skips fetch when URL is not configured', async () => {
        const fetchSpy = jest.fn();
        global.fetch = fetchSpy as unknown as typeof fetch;

        const result = await requestFacilitatorDecision({
            requestId: 'req-6',
            contractAddress: 'EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBRs8',
            targetAddress: 'EQCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCClzv',
            amountInTon: '0.2',
        }, {
            network: 'testnet',
        });

        expect(result).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
