import { Bot, InlineKeyboard } from "grammy";
import { Address, fromNano, TonClient, WalletContractV5R1, toNano } from "@ton/ton";
import { getHttpEndpoint } from "@orbs-network/ton-access";
import { mnemonicToWalletKey } from "@ton/crypto";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { loadApprovalRequest, TonPay402 } from "../build/TonPay402/TonPay402_TonPay402";

dotenv.config();

const BOT_TOKEN = requiredEnv("TELEGRAM_BOT_TOKEN");
const OWNER_CHAT_ID = requiredEnv("TELEGRAM_CHAT_ID");
const CONTRACT_ADDRESS = Address.parse(requiredEnv("CONTRACT_ADDRESS"));
const TON_NETWORK = process.env.TON_NETWORK ?? "testnet";
const POLL_INTERVAL_MS = Number(process.env.APPROVAL_POLL_INTERVAL_MS ?? "10000");
const OWNER_WALLET_WORKCHAIN = Number(process.env.OWNER_WALLET_WORKCHAIN ?? "0");
const EXECUTION_BUFFER_TON = process.env.EXECUTION_BUFFER_TON ?? "0.1";
const APPROVAL_STATE_FILE = path.resolve(process.cwd(), process.env.APPROVAL_STATE_FILE ?? "approval-state.json");
const BOOTSTRAP_HISTORY_LIMIT = Number(process.env.BOOTSTRAP_HISTORY_LIMIT ?? "20");
const REQUEST_AUDIT_FILE = path.resolve(process.cwd(), process.env.REQUEST_AUDIT_FILE ?? "request-audit.json");

type PendingApproval = {
    id: string;
    amount: bigint;
    target: Address;
    txLt: string;
    txHashHex: string;
};

type ApprovalStatus = "pending" | "approved" | "rejected" | "failed";

type ApprovalRecord = PendingApproval & {
    status: ApprovalStatus;
    createdAt: string;
    requestId?: string;
    resolvedAt?: string;
    resolvedBy?: string;
    ownerWallet?: string;
    submitError?: string;
};

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
    consumedByApprovalId?: string;
    statusUpdatedAt?: string;
};

type PersistedState = {
    approvals: Record<string, {
        id: string;
        amount: string;
        target: string;
        txLt: string;
        txHashHex: string;
        status: ApprovalStatus;
        createdAt: string;
        requestId?: string;
        resolvedAt?: string;
        resolvedBy?: string;
        ownerWallet?: string;
        submitError?: string;
    }>;
    seenTransactions: string[];
};

const pendingApprovals = new Map<string, PendingApproval>();
const seenTransactions = new Set<string>();
const approvalRecords = new Map<string, ApprovalRecord>();

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value || !value.trim()) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value.trim();
}

function toPersistedRecord(record: ApprovalRecord): PersistedState["approvals"][string] {
    return {
        ...record,
        amount: record.amount.toString(),
        target: record.target.toString(),
    };
}

function fromPersistedRecord(raw: PersistedState["approvals"][string]): ApprovalRecord {
    return {
        ...raw,
        amount: BigInt(raw.amount),
        target: Address.parse(raw.target),
    };
}

function saveState() {
    const payload: PersistedState = {
        approvals: Object.fromEntries(
            Array.from(approvalRecords.entries()).map(([id, record]) => [id, toPersistedRecord(record)])
        ),
        seenTransactions: Array.from(seenTransactions),
    };
    fs.writeFileSync(APPROVAL_STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
}

function loadState() {
    if (!fs.existsSync(APPROVAL_STATE_FILE)) {
        return;
    }

    const raw = fs.readFileSync(APPROVAL_STATE_FILE, "utf8").trim();
    if (!raw) {
        return;
    }

    const parsed = JSON.parse(raw) as PersistedState;
    for (const txHash of parsed.seenTransactions ?? []) {
        seenTransactions.add(txHash);
    }

    for (const [id, rawRecord] of Object.entries(parsed.approvals ?? {})) {
        const record = fromPersistedRecord(rawRecord);
        approvalRecords.set(id, record);
        if (record.status === "pending") {
            pendingApprovals.set(id, {
                id: record.id,
                amount: record.amount,
                target: record.target,
                txLt: record.txLt,
                txHashHex: record.txHashHex,
            });
        }
    }
}

function upsertRecord(record: ApprovalRecord) {
    approvalRecords.set(record.id, record);
    saveState();
}

function setRecordStatus(
    approvalId: string,
    status: Exclude<ApprovalStatus, "pending">,
    resolvedBy: string,
    extra?: { ownerWallet?: string; submitError?: string }
) {
    const existing = approvalRecords.get(approvalId);
    if (!existing) {
        return;
    }

    approvalRecords.set(approvalId, {
        ...existing,
        status,
        resolvedAt: new Date().toISOString(),
        resolvedBy,
        ...extra,
    });
    saveState();
}

function readRequestAuditRecords(): RequestAuditRecord[] {
    if (!fs.existsSync(REQUEST_AUDIT_FILE)) {
        return [];
    }

    const raw = fs.readFileSync(REQUEST_AUDIT_FILE, "utf8").trim();
    if (!raw) {
        return [];
    }

    return JSON.parse(raw) as RequestAuditRecord[];
}

function saveRequestAuditRecords(records: RequestAuditRecord[]) {
    fs.writeFileSync(REQUEST_AUDIT_FILE, JSON.stringify(records, null, 2), "utf8");
}

function claimMatchingRequestId(approval: PendingApproval): string | undefined {
    const records = readRequestAuditRecords();
    let changed = false;

    for (let i = records.length - 1; i >= 0; i -= 1) {
        const record = records[i];
        if (record.consumedByApprovalId) {
            continue;
        }

        if (record.contractAddress !== CONTRACT_ADDRESS.toString()) {
            continue;
        }

        if (record.targetAddress !== approval.target.toString()) {
            continue;
        }

        if (record.amountNano !== approval.amount.toString()) {
            continue;
        }

        record.consumedByApprovalId = approval.id;
        record.status = "approval_pending";
        record.statusUpdatedAt = new Date().toISOString();
        changed = true;

        if (changed) {
            saveRequestAuditRecords(records);
        }
        return record.requestId;
    }

    return undefined;
}

function updateRequestAuditStatus(
    requestId: string | undefined,
    status: Extract<RequestAuditStatus, "approved" | "rejected" | "failed">
) {
    if (!requestId) {
        return;
    }

    const records = readRequestAuditRecords();
    let changed = false;
    for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i].requestId !== requestId) {
            continue;
        }

        records[i].status = status;
        records[i].statusUpdatedAt = new Date().toISOString();
        changed = true;
        break;
    }

    if (changed) {
        saveRequestAuditRecords(records);
    }
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
    const wallet = WalletContractV5R1.create({
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
    const existingRecord = approvalRecords.get(approval.id);
    if (existingRecord) {
        if (existingRecord.status === "pending" && !pendingApprovals.has(approval.id)) {
            pendingApprovals.set(approval.id, approval);
        }
        return;
    }

    pendingApprovals.set(approval.id, approval);
    const requestId = claimMatchingRequestId(approval);
    upsertRecord({
        ...approval,
        status: "pending",
        createdAt: new Date().toISOString(),
        requestId,
    });
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
            requestId ? `Request ID: \`${requestId}\`` : "",
        ].join("\n"),
        { parse_mode: "MarkdownV2", reply_markup: keyboard }
    );
}

function markSeen(transactions: any[]) {
    for (const tx of transactions) {
        seenTransactions.add(tx.hash().toString("hex"));
    }
    saveState();
}

function ensureAuthorizedChat(chatId: string) {
    if (chatId !== OWNER_CHAT_ID) {
        throw new Error("Unauthorized chat");
    }
}

async function bootstrapSeenTransactions(client: TonClient) {
    const recent = await client.getTransactions(CONTRACT_ADDRESS, { limit: BOOTSTRAP_HISTORY_LIMIT, archival: true });
    markSeen(recent);
}

async function monitorContract() {
    const client = await getClient();
    if (seenTransactions.size === 0 && pendingApprovals.size === 0) {
        await bootstrapSeenTransactions(client);
    }

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
        const record = approvalRecords.get(approvalId);
        if (record && record.status !== "pending") {
            await ctx.answerCallbackQuery(`Request already ${record.status}.`);
            return;
        }

        const approval = pendingApprovals.get(approvalId);
        if (!approval) {
            await ctx.answerCallbackQuery("Approval request not found or already handled.");
            return;
        }

        await ctx.answerCallbackQuery("Processing approval...");
        const ownerWallet = await submitOwnerApproval(approval);
        pendingApprovals.delete(approvalId);
        const recordRequestId = approvalRecords.get(approvalId)?.requestId;
        setRecordStatus(approvalId, "approved", String(ctx.from?.id ?? "unknown"), { ownerWallet });
        updateRequestAuditStatus(recordRequestId, "approved");

        await ctx.reply(
            `✅ Approved and submitted by owner wallet ${ownerWallet}. Ref: ${approvalId}`
        );
    } catch (error: any) {
        const approvalId = ctx.match?.[1];
        if (approvalId) {
            const recordRequestId = approvalRecords.get(approvalId)?.requestId;
            setRecordStatus(approvalId, "failed", String(ctx.from?.id ?? "unknown"), {
                submitError: error?.message ?? String(error),
            });
            updateRequestAuditStatus(recordRequestId, "failed");
        }
        await ctx.answerCallbackQuery("Approval failed.");
        await ctx.reply(`❌ Failed to approve request: ${error?.message ?? String(error)}`);
    }
});

bot.callbackQuery(/reject:(.+)/, async (ctx) => {
    try {
        ensureAuthorizedChat(String(ctx.chat?.id ?? ""));
        const approvalId = ctx.match[1];
        const record = approvalRecords.get(approvalId);
        if (record && record.status !== "pending") {
            await ctx.answerCallbackQuery(`Request already ${record.status}.`);
            return;
        }

        const removed = pendingApprovals.delete(approvalId);
        if (removed) {
            const recordRequestId = approvalRecords.get(approvalId)?.requestId;
            setRecordStatus(approvalId, "rejected", String(ctx.from?.id ?? "unknown"));
            updateRequestAuditStatus(recordRequestId, "rejected");
        }
        await ctx.answerCallbackQuery(removed ? "Request rejected." : "Request already handled.");
        await ctx.reply(`❌ Rejected request ${approvalId}`);
    } catch (error: any) {
        await ctx.answerCallbackQuery("Reject failed.");
        await ctx.reply(`❌ Failed to reject request: ${error?.message ?? String(error)}`);
    }
});

async function main() {
    loadState();
    await bot.start();
    await monitorContract();
    console.log("Telegram approval bot is running...");
}

main().catch((error) => {
    console.error("Telegram bot startup failed:", error);
    process.exit(1);
});