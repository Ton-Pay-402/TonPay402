import { Bot, InlineKeyboard } from "grammy";
import { Address, fromNano, TonClient, WalletContractV4, toNano } from "@ton/ton";
import { getHttpEndpoint } from "@orbs-network/ton-access";
import { mnemonicToWalletKey } from "@ton/crypto";
import dotenv from "dotenv";
import { loadApprovalRequest, TonPay402 } from "../build/TonPay402/TonPay402_TonPay402";

dotenv.config();

const BOT_TOKEN = requiredEnv("TELEGRAM_BOT_TOKEN");
const OWNER_CHAT_ID = requiredEnv("TELEGRAM_CHAT_ID");
const CONTRACT_ADDRESS = Address.parse(requiredEnv("CONTRACT_ADDRESS"));
const TON_NETWORK = process.env.TON_NETWORK ?? "testnet";
const POLL_INTERVAL_MS = Number(process.env.APPROVAL_POLL_INTERVAL_MS ?? "10000");
const OWNER_WALLET_WORKCHAIN = Number(process.env.OWNER_WALLET_WORKCHAIN ?? "0");
const EXECUTION_BUFFER_TON = process.env.EXECUTION_BUFFER_TON ?? "0.1";

type PendingApproval = {
    id: string;
    amount: bigint;
    target: Address;
    txLt: string;
    txHashHex: string;
};

const pendingApprovals = new Map<string, PendingApproval>();
const seenTransactions = new Set<string>();

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value || !value.trim()) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value.trim();
}

// Initialize Telegram Bot with your Token from @BotFather
const bot = new Bot(BOT_TOKEN);

async function getClient() {
    const endpoint = await getHttpEndpoint({ network: TON_NETWORK as "testnet" | "mainnet" });
    const apiKey = process.env.TON_API_KEY?.trim();
    return new TonClient({ endpoint, ...(apiKey ? { apiKey } : {}) });
}

async function getOwnerSender(client: TonClient) {
    const mnemonic = requiredEnv("OWNER_MNEMONIC");
    const words = mnemonic.split(/\s+/).filter(Boolean);
    const keyPair = await mnemonicToWalletKey(words);
    const wallet = WalletContractV4.create({
        workchain: OWNER_WALLET_WORKCHAIN,
        publicKey: keyPair.publicKey,
    });
    const openedWallet = client.open(wallet);

    const isDeployed = await client.isContractDeployed(wallet.address);
    if (!isDeployed) {
        throw new Error(`Owner wallet ${wallet.address.toString()} is not deployed`);
    }

    return {
        address: wallet.address,
        sender: openedWallet.sender(keyPair.secretKey),
    };
}

function approvalKeyFromTx(txLt: bigint, txHashHex: string) {
    return `${txLt.toString()}-${txHashHex.slice(0, 8)}`;
}

function parseApprovalFromTransaction(tx: any): PendingApproval | null {
    const txHashHex = tx.hash().toString("hex");
    if (seenTransactions.has(txHashHex)) {
        return null;
    }

    const outMessages = tx.outMessages?.values?.() ?? [];
    for (const message of outMessages) {
        try {
            const parsed = loadApprovalRequest(message.body.beginParse());
            const id = approvalKeyFromTx(tx.lt, txHashHex);
            return {
                id,
                amount: parsed.amount,
                target: parsed.target,
                txLt: tx.lt.toString(),
                txHashHex,
            };
        } catch {
            // Not an ApprovalRequest payload
        }
    }

    return null;
}

async function submitOwnerApproval(approval: PendingApproval) {
    const client = await getClient();
    const contract = client.open(TonPay402.fromAddress(CONTRACT_ADDRESS));
    const { sender, address: ownerWallet } = await getOwnerSender(client);

    const txValue = approval.amount + toNano(EXECUTION_BUFFER_TON);
    await contract.send(
        sender,
        { value: txValue },
        {
            $$type: "ExecutePayment",
            amount: approval.amount,
            target: approval.target,
        }
    );

    return ownerWallet.toString();
}

async function notifyApprovalRequest(approval: PendingApproval) {
    if (pendingApprovals.has(approval.id)) {
        return;
    }

    pendingApprovals.set(approval.id, approval);
    const keyboard = new InlineKeyboard()
        .text("✅ Approve", `approve:${approval.id}`)
        .text("❌ Reject", `reject:${approval.id}`);

    await bot.api.sendMessage(
        OWNER_CHAT_ID,
        [
            "⚠️ *AI Agent Alert*",
            "Over-limit payment request detected.",
            `Amount: *${fromNano(approval.amount)} TON*`,
            `Target: \`${approval.target.toString()}\``,
            `Ref: \`${approval.id}\``,
        ].join("\n"),
        { parse_mode: "MarkdownV2", reply_markup: keyboard }
    );
}

function markSeen(transactions: any[]) {
    for (const tx of transactions) {
        seenTransactions.add(tx.hash().toString("hex"));
    }
}

function ensureAuthorizedChat(chatId: string) {
    if (chatId !== OWNER_CHAT_ID) {
        throw new Error("Unauthorized chat");
    }
}

async function bootstrapSeenTransactions(client: TonClient) {
    const recent = await client.getTransactions(CONTRACT_ADDRESS, { limit: 20, archival: true });
    markSeen(recent);
}

async function monitorContract() {
    const client = await getClient();
    await bootstrapSeenTransactions(client);

    console.log("Monitoring contract for approval requests...");

    setInterval(async () => {
        try {
            const transactions = await client.getTransactions(CONTRACT_ADDRESS, { limit: 10, archival: true });
            for (const tx of transactions) {
                const approval = parseApprovalFromTransaction(tx);
                if (approval) {
                    await notifyApprovalRequest(approval);
                }
            }
            markSeen(transactions);
        } catch (error) {
            console.error("Failed to poll contract:", error);
        }
    }, POLL_INTERVAL_MS);
}

bot.callbackQuery(/approve:(.+)/, async (ctx) => {
    try {
        ensureAuthorizedChat(String(ctx.chat?.id ?? ""));
        const approvalId = ctx.match[1];
        const approval = pendingApprovals.get(approvalId);
        if (!approval) {
            await ctx.answerCallbackQuery("Approval request not found or already handled.");
            return;
        }

        await ctx.answerCallbackQuery("Processing approval...");
        const ownerWallet = await submitOwnerApproval(approval);
        pendingApprovals.delete(approvalId);

        await ctx.reply(
            `✅ Approved and submitted by owner wallet ${ownerWallet}. Ref: ${approvalId}`
        );
    } catch (error: any) {
        await ctx.answerCallbackQuery("Approval failed.");
        await ctx.reply(`❌ Failed to approve request: ${error?.message ?? String(error)}`);
    }
});

bot.callbackQuery(/reject:(.+)/, async (ctx) => {
    try {
        ensureAuthorizedChat(String(ctx.chat?.id ?? ""));
        const approvalId = ctx.match[1];
        const removed = pendingApprovals.delete(approvalId);
        await ctx.answerCallbackQuery(removed ? "Request rejected." : "Request already handled.");
        await ctx.reply(`❌ Rejected request ${approvalId}`);
    } catch (error: any) {
        await ctx.answerCallbackQuery("Reject failed.");
        await ctx.reply(`❌ Failed to reject request: ${error?.message ?? String(error)}`);
    }
});

async function main() {
    await bot.start();
    await monitorContract();
    console.log("Telegram approval bot is running...");
}

main().catch((error) => {
    console.error("Telegram bot startup failed:", error);
    process.exit(1);
});