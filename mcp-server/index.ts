import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Address, TonClient, WalletContractV4, toNano, fromNano } from "@ton/ton";
import { getHttpEndpoint } from "@orbs-network/ton-access";
import { mnemonicToWalletKey } from "@ton/crypto";
import { TonPay402 } from "../build/TonPay402/TonPay402_TonPay402";
import dotenv from "dotenv";

dotenv.config();

const TON_NETWORK = process.env.TON_NETWORK ?? "testnet";
const AGENT_WALLET_WORKCHAIN = Number(process.env.AGENT_WALLET_WORKCHAIN ?? "0");
const EXECUTION_BUFFER_TON = process.env.EXECUTION_BUFFER_TON ?? "0.1";

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
    const wallet = WalletContractV4.create({
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
                    amountInTon: { type: "string", description: "Amount to pay in TON (e.g. '0.5')" }
                },
                required: ["contractAddress", "targetAddress", "amountInTon"]
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

            const contractAddr = Address.parse(contractAddress);
            const targetAddr = Address.parse(targetAddress);
            const amountNano = toNano(amountInTon);
            const bufferNano = toNano(EXECUTION_BUFFER_TON);
            const txValue = amountNano + bufferNano;

            const { sender, address: agentWallet } = await getAgentSender(client);
            const contract = client.open(TonPay402.fromAddress(contractAddr));
            const remaining = await contract.getRemainingAllowance();

            await contract.send(
                sender,
                { value: txValue },
                {
                    $$type: "ExecutePayment",
                    amount: amountNano,
                    target: targetAddr,
                }
            );

            const approvalHint = amountNano > remaining
                ? " Payment is above allowance; contract should emit ApprovalRequest for Telegram workflow."
                : "";
            
            return {
                content: [
                    {
                        type: "text",
                        text: `Submitted ExecutePayment from agent wallet ${agentWallet.toString()} for ${amountInTon} TON to ${targetAddr.toString()} on contract ${contractAddr.toString()}.${approvalHint}`
                    }
                ]
            };
        }
        
        default:
            throw new Error("Tool not found");
    }
});

// Start the server using Standard I/O transport
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("TonPay402 MCP Server running...");
}

main().catch((error) => {
    console.error("Failed to start TonPay402 MCP Server:", error);
    process.exit(1);
});
