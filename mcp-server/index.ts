import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Address, TonClient, WalletContractV5R1, toNano, fromNano } from "@ton/ton";
import { getHttpEndpoint } from "@orbs-network/ton-access";
import { mnemonicToWalletKey } from "@ton/crypto";
import { TonPay402 } from "../build/TonPay402/TonPay402_TonPay402";
import { requestFacilitatorDecision } from "./facilitator";
import {
    assignAgentToEnvelope,
    BrokerState,
    createEnvelope,
    emptyBrokerState,
    getEnvelopeAllowance,
    reserveEnvelopeBudget,
    rollbackEnvelopeReservation,
} from "./broker";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const TON_NETWORK = process.env.TON_NETWORK ?? "testnet";
const AGENT_WALLET_WORKCHAIN = Number(process.env.AGENT_WALLET_WORKCHAIN ?? "0");
const EXECUTION_BUFFER_TON = process.env.EXECUTION_BUFFER_TON ?? "0.1";
const REQUEST_AUDIT_FILE = path.resolve(process.cwd(), process.env.REQUEST_AUDIT_FILE ?? "request-audit.json");
const X402_FACILITATOR_URL = process.env.X402_FACILITATOR_URL?.trim() ?? "";
const X402_FACILITATOR_API_KEY = process.env.X402_FACILITATOR_API_KEY?.trim() ?? "";
const X402_FACILITATOR_TIMEOUT_MS = Number(process.env.X402_FACILITATOR_TIMEOUT_MS ?? "15000");
const X402_FACILITATOR_RETRY_ATTEMPTS = Number(process.env.X402_FACILITATOR_RETRY_ATTEMPTS ?? "0");
const X402_FACILITATOR_RETRY_BACKOFF_MS = Number(process.env.X402_FACILITATOR_RETRY_BACKOFF_MS ?? "300");
const FACILITATOR_FAIL_OPEN = (process.env.X402_FACILITATOR_FAIL_OPEN ?? "false").toLowerCase() === "true";
const ENABLE_MAINNET_MODE = (process.env.ENABLE_MAINNET_MODE ?? "false").toLowerCase() === "true";
const BROKER_STATE_FILE = path.resolve(process.cwd(), process.env.BROKER_STATE_FILE ?? "broker-state.json");

type RequestAuditStatus = "submitted" | "approval_pending" | "approved" | "rejected" | "failed";

type RequestAuditRecord = {
    requestId: string;
    contractAddress: string;
    targetAddress: string;
    amountInTon: string;
    amountNano: string;
    createdAt: string;
    status: RequestAuditStatus;
    approvalExpected: boolean;
    facilitatorUrl?: string;
    facilitatorReference?: string;
    consumedByApprovalId?: string;
    statusUpdatedAt?: string;
};

type PaymentPreparation = {
    requestId: string;
    contractAddr: Address;
    targetAddr: Address;
    amountNano: bigint;
    amountInTon: string;
    facilitatorDecision: Awaited<ReturnType<typeof requestFacilitatorDecision>>;
};

const brokerState = readBrokerState();

function readAuditRecords(): RequestAuditRecord[] {
    if (!fs.existsSync(REQUEST_AUDIT_FILE)) {
        return [];
    }

    const raw = fs.readFileSync(REQUEST_AUDIT_FILE, "utf8").trim();
    if (!raw) {
        return [];
    }

    return JSON.parse(raw) as RequestAuditRecord[];
}

function readBrokerState(): BrokerState {
    if (!fs.existsSync(BROKER_STATE_FILE)) {
        return emptyBrokerState();
    }

    const raw = fs.readFileSync(BROKER_STATE_FILE, "utf8").trim();
    if (!raw) {
        return emptyBrokerState();
    }

    const parsed = JSON.parse(raw) as BrokerState;
    if (!parsed || typeof parsed !== "object" || !parsed.envelopes || typeof parsed.envelopes !== "object") {
        return emptyBrokerState();
    }

    return parsed;
}

function saveBrokerState(state: BrokerState) {
    fs.writeFileSync(BROKER_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function ensureRuntimeGuards() {
    if (TON_NETWORK === "mainnet" && !ENABLE_MAINNET_MODE) {
        throw new Error("Mainnet mode requires ENABLE_MAINNET_MODE=true");
    }

    if (TON_NETWORK === "mainnet") {
        requiredEnv("AGENT_MNEMONIC");
        requiredEnv("CONTRACT_ADDRESS");
        if (!REQUEST_AUDIT_FILE.trim()) {
            throw new Error("REQUEST_AUDIT_FILE must be configured in mainnet mode");
        }
        if (!BROKER_STATE_FILE.trim()) {
            throw new Error("BROKER_STATE_FILE must be configured in mainnet mode");
        }
    }
}

function logEvent(event: string, data: Record<string, unknown>) {
    console.error(JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...data,
    }));
}

async function preparePaymentRequest(args: {
    contractAddress: string;
    targetAddress: string;
    amountInTon: string;
    requestId: string;
    facilitatorContext?: unknown;
}): Promise<PaymentPreparation> {
    const contractAddr = Address.parse(args.contractAddress);

    let facilitatorDecision: Awaited<ReturnType<typeof requestFacilitatorDecision>> = null;
    try {
        facilitatorDecision = await requestFacilitatorDecision({
            requestId: args.requestId,
            contractAddress: args.contractAddress,
            targetAddress: args.targetAddress,
            amountInTon: args.amountInTon,
            facilitatorContext: args.facilitatorContext,
        }, {
            url: X402_FACILITATOR_URL,
            apiKey: X402_FACILITATOR_API_KEY,
            timeoutMs: X402_FACILITATOR_TIMEOUT_MS,
            retryAttempts: X402_FACILITATOR_RETRY_ATTEMPTS,
            retryBackoffMs: X402_FACILITATOR_RETRY_BACKOFF_MS,
            network: TON_NETWORK,
        });
    } catch (error) {
        if (!FACILITATOR_FAIL_OPEN) {
            throw error;
        }
        logEvent("facilitator_fail_open", {
            requestId: args.requestId,
            reason: error instanceof Error ? error.message : String(error),
        });
    }

    const effectiveTargetAddress = facilitatorDecision?.targetAddress ?? args.targetAddress;
    const effectiveAmountInTon = facilitatorDecision?.amountInTon ?? args.amountInTon;

    return {
        requestId: args.requestId,
        contractAddr,
        targetAddr: Address.parse(effectiveTargetAddress),
        amountNano: toNano(effectiveAmountInTon),
        amountInTon: effectiveAmountInTon,
        facilitatorDecision,
    };
}

async function submitPreparedPayment(client: TonClient, prepared: PaymentPreparation) {
    const bufferNano = toNano(EXECUTION_BUFFER_TON);
    const txValue = prepared.amountNano + bufferNano;

    const { sender, address: agentWallet } = await getAgentSender(client);
    const contract = client.open(TonPay402.fromAddress(prepared.contractAddr));
    const remaining = await contract.getRemainingAllowance();

    await contract.send(
        sender,
        { value: txValue },
        {
            $$type: "ExecutePayment",
            amount: prepared.amountNano,
            target: prepared.targetAddr,
        }
    );

    const approvalExpected = prepared.amountNano > remaining;
    appendAuditRecord({
        requestId: prepared.requestId,
        contractAddress: prepared.contractAddr.toString(),
        targetAddress: prepared.targetAddr.toString(),
        amountInTon: prepared.amountInTon,
        amountNano: prepared.amountNano.toString(),
        createdAt: new Date().toISOString(),
        status: approvalExpected ? "approval_pending" : "submitted",
        approvalExpected,
        facilitatorUrl: X402_FACILITATOR_URL || undefined,
        facilitatorReference: prepared.facilitatorDecision?.reference,
    });

    return {
        agentWallet,
        approvalExpected,
    };
}


function saveAuditRecords(records: RequestAuditRecord[]) {
    fs.writeFileSync(REQUEST_AUDIT_FILE, JSON.stringify(records, null, 2), "utf8");
}

function appendAuditRecord(record: RequestAuditRecord) {
    const records = readAuditRecords();
    records.push(record);
    saveAuditRecords(records);
}

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value || !value.trim()) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value.trim();
}

// Initialize the MCP Server
const server = new McpServer(
    { name: "ton-pay-402", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

// Setup TON Client (using Testnet for development)
async function getClient() {
    const endpoint = await getHttpEndpoint({ network: TON_NETWORK as "testnet" | "mainnet" });
    const apiKey = process.env.TON_API_KEY?.trim();
    return new TonClient({ endpoint, ...(apiKey ? { apiKey } : {}) });
}

async function getAgentSender(client: TonClient) {
    const mnemonic = requiredEnv("AGENT_MNEMONIC");
    const words = mnemonic.split(/\s+/).filter(Boolean);
    const keyPair = await mnemonicToWalletKey(words);
    const wallet = WalletContractV5R1.create({
        workchain: AGENT_WALLET_WORKCHAIN,
        publicKey: keyPair.publicKey,
    });
    const openedWallet = client.open(wallet);

    const isDeployed = await client.isContractDeployed(wallet.address);
    if (!isDeployed) {
        throw new Error(`Agent wallet ${wallet.address.toString()} is not deployed`);
    }

    return {
        address: wallet.address,
        sender: openedWallet.sender(keyPair.secretKey),
    };
}

// 1. List available tools to the AI Agent
server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "get_allowance",
            description: "Get the remaining allowance from a TonPay402 contract",
            inputSchema: {
                type: "object",
                properties: {
                    contractAddress: { type: "string" }
                },
                required: ["contractAddress"]
            }
        },
        {
            name: "execute_m2m_payment",
            description: "Execute an autonomous payment to a target address within allowed limits",
            inputSchema: {
                type: "object",
                properties: {
                    contractAddress: { type: "string" },
                    targetAddress: { type: "string" },
                    amountInTon: { type: "string", description: "Amount to pay in TON (e.g. '0.5')" },
                    requestId: { type: "string", description: "Optional external correlation ID for audit logs" },
                    facilitatorContext: {
                        type: "object",
                        description: "Optional metadata forwarded to AEON/x402 facilitator (resource, method, pricing, etc.)"
                    }
                },
                required: ["contractAddress", "targetAddress", "amountInTon"]
            }
        },
        {
            name: "create_envelope",
            description: "Create a broker envelope with shared budget for multiple agents",
            inputSchema: {
                type: "object",
                properties: {
                    envelopeId: { type: "string" },
                    totalBudgetTon: { type: "string" },
                    periodSeconds: { type: "number", description: "Budget reset window in seconds" }
                },
                required: ["envelopeId", "totalBudgetTon", "periodSeconds"]
            }
        },
        {
            name: "assign_agent_to_envelope",
            description: "Assign an agent identity to a broker envelope",
            inputSchema: {
                type: "object",
                properties: {
                    envelopeId: { type: "string" },
                    agentId: { type: "string" }
                },
                required: ["envelopeId", "agentId"]
            }
        },
        {
            name: "get_envelope_allowance",
            description: "Get remaining allowance for a broker envelope",
            inputSchema: {
                type: "object",
                properties: {
                    envelopeId: { type: "string" }
                },
                required: ["envelopeId"]
            }
        },
        {
            name: "execute_envelope_payment",
            description: "Execute payment through a broker envelope budget, then on-chain TonPay402 policy",
            inputSchema: {
                type: "object",
                properties: {
                    envelopeId: { type: "string" },
                    agentId: { type: "string" },
                    contractAddress: { type: "string" },
                    targetAddress: { type: "string" },
                    amountInTon: { type: "string" },
                    requestId: { type: "string" },
                    facilitatorContext: { type: "object" }
                },
                required: ["envelopeId", "agentId", "contractAddress", "targetAddress", "amountInTon"]
            }
        }
    ]
}));

// 2. Handle tool execution logic
server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const client = await getClient();
    
    switch (request.params.name) {
        case "get_allowance": {
            const address = Address.parse(request.params.arguments?.contractAddress as string);
            const contract = client.open(TonPay402.fromAddress(address));
            // Call the Tact getter we tested earlier
            const remaining = await contract.getRemainingAllowance();
            return {
                content: [
                    {
                        type: "text",
                        text: `Remaining allowance: ${fromNano(remaining)} TON`
                    }
                ]
            };
        }

        case "execute_m2m_payment": {
            const contractAddress = request.params.arguments?.contractAddress as string;
            const targetAddress = request.params.arguments?.targetAddress as string;
            const amountInTon = request.params.arguments?.amountInTon as string;
            const facilitatorContext = request.params.arguments?.facilitatorContext;
            const requestId = (request.params.arguments?.requestId as string | undefined)?.trim() ||
                `req_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

            const prepared = await preparePaymentRequest({
                contractAddress,
                targetAddress,
                amountInTon,
                requestId,
                facilitatorContext,
            });
            const { agentWallet, approvalExpected } = await submitPreparedPayment(client, prepared);

            const approvalHint = approvalExpected
                ? " Payment is above allowance; contract should emit ApprovalRequest for Telegram workflow."
                : "";

            const facilitatorHint = X402_FACILITATOR_URL
                ? ` Facilitator${prepared.facilitatorDecision?.reference ? ` ref=${prepared.facilitatorDecision.reference}` : ""}${prepared.facilitatorDecision?.note ? ` (${prepared.facilitatorDecision.note})` : ""}.`
                : "";
            logEvent("payment_submitted", {
                requestId,
                contractAddress: prepared.contractAddr.toString(),
                targetAddress: prepared.targetAddr.toString(),
                amountNano: prepared.amountNano.toString(),
                approvalExpected,
            });
            
            return {
                content: [
                    {
                        type: "text",
                        text: `Submitted ExecutePayment [requestId=${requestId}] from agent wallet ${agentWallet.toString()} for ${prepared.amountInTon} TON to ${prepared.targetAddr.toString()} on contract ${prepared.contractAddr.toString()}.${approvalHint}${facilitatorHint}`
                    }
                ]
            };
        }

        case "create_envelope": {
            const envelopeId = request.params.arguments?.envelopeId as string;
            const totalBudgetTon = request.params.arguments?.totalBudgetTon as string;
            const periodSeconds = Number(request.params.arguments?.periodSeconds);
            const envelope = createEnvelope({
                state: brokerState,
                envelopeId,
                totalBudgetNano: toNano(totalBudgetTon),
                periodSeconds,
            });
            saveBrokerState(brokerState);
            return {
                content: [{
                    type: "text",
                    text: `Created envelope ${envelope.id} with budget ${fromNano(BigInt(envelope.totalBudgetNano))} TON per ${envelope.periodSeconds}s window.`,
                }],
            };
        }

        case "assign_agent_to_envelope": {
            const envelopeId = request.params.arguments?.envelopeId as string;
            const agentId = request.params.arguments?.agentId as string;
            const envelope = assignAgentToEnvelope({ state: brokerState, envelopeId, agentId });
            saveBrokerState(brokerState);
            return {
                content: [{
                    type: "text",
                    text: `Assigned agent ${agentId} to envelope ${envelope.id}.`,
                }],
            };
        }

        case "get_envelope_allowance": {
            const envelopeId = request.params.arguments?.envelopeId as string;
            const { envelope, remainingNano } = getEnvelopeAllowance({ state: brokerState, envelopeId });
            saveBrokerState(brokerState);
            return {
                content: [{
                    type: "text",
                    text: `Envelope ${envelope.id} remaining allowance: ${fromNano(remainingNano)} TON (spent ${fromNano(BigInt(envelope.spentInWindowNano))}/${fromNano(BigInt(envelope.totalBudgetNano))}).`,
                }],
            };
        }

        case "execute_envelope_payment": {
            const envelopeId = request.params.arguments?.envelopeId as string;
            const agentId = request.params.arguments?.agentId as string;
            const contractAddress = request.params.arguments?.contractAddress as string;
            const targetAddress = request.params.arguments?.targetAddress as string;
            const amountInTon = request.params.arguments?.amountInTon as string;
            const facilitatorContext = request.params.arguments?.facilitatorContext;
            const requestId = (request.params.arguments?.requestId as string | undefined)?.trim() ||
                `req_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

            const prepared = await preparePaymentRequest({
                contractAddress,
                targetAddress,
                amountInTon,
                requestId,
                facilitatorContext,
            });

            reserveEnvelopeBudget({
                state: brokerState,
                envelopeId,
                agentId,
                amountNano: prepared.amountNano,
            });
            saveBrokerState(brokerState);

            try {
                const { agentWallet, approvalExpected } = await submitPreparedPayment(client, prepared);
                const { remainingNano } = getEnvelopeAllowance({ state: brokerState, envelopeId });
                saveBrokerState(brokerState);
                logEvent("envelope_payment_submitted", {
                    requestId,
                    envelopeId,
                    agentId,
                    amountNano: prepared.amountNano.toString(),
                    remainingNano: remainingNano.toString(),
                });

                return {
                    content: [{
                        type: "text",
                        text: `Envelope payment submitted [requestId=${requestId}] by ${agentId} via wallet ${agentWallet.toString()} for ${prepared.amountInTon} TON. Envelope remaining: ${fromNano(remainingNano)} TON.${approvalExpected ? " Approval workflow expected." : ""}`,
                    }],
                };
            } catch (error) {
                rollbackEnvelopeReservation({
                    state: brokerState,
                    envelopeId,
                    amountNano: prepared.amountNano,
                });
                saveBrokerState(brokerState);
                throw error;
            }
        }
        
        default:
            throw new Error("Tool not found");
    }
});

// Start the server using Standard I/O transport
async function main() {
    ensureRuntimeGuards();
    logEvent("mcp_startup", {
        network: TON_NETWORK,
        mainnetEnabled: ENABLE_MAINNET_MODE,
        facilitatorConfigured: Boolean(X402_FACILITATOR_URL),
        facilitatorFailOpen: FACILITATOR_FAIL_OPEN,
        facilitatorRetryAttempts: X402_FACILITATOR_RETRY_ATTEMPTS,
        brokerStateFile: BROKER_STATE_FILE,
        requestAuditFile: REQUEST_AUDIT_FILE,
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("TonPay402 MCP Server running...");
}

main().catch((error) => {
    console.error("Failed to start TonPay402 MCP Server:", error);
    process.exit(1);
});
