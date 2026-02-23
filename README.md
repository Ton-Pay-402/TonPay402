# TonPay402

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TON Network](https://img.shields.io/badge/TON-Testnet-0098EA)](https://ton.org)
[![Blueprint Tests](https://img.shields.io/badge/Blueprint-Tests%20Passing-success)](./tests)
[![MCP](https://img.shields.io/badge/MCP-Server-5A67D8)](./mcp-server)

🤖 TonPay 402: The Universal M2M Payment Rail for TON AI Agents
TonPay 402 is a specialized infrastructure toolkit designed to enable secure, autonomous, and policy-driven payments for AI agents on the TON Blockchain. By leveraging the Wallet V5 (W5) standard and the x402 (HTTP 402) protocol, it provides the "financial guardrails" necessary for agents to participate in the machine economy without compromising user funds.

## Problem 

🚀 The Problem: The "Toddler with a Credit Card" Dilemma
AI Agents are becoming autonomous economic actors—buying API credits, renting GPU power, or hiring other sub-agents. However, giving an LLM-based agent full access to a seed phrase is an extreme security risk . Current solutions either:

Risk total drainage via prompt injection or logic bugs.

Require constant human approval, defeating the purpose of autonomy.


## Solution

✅ The Solution: TonPay 402
TonPay 402 acts as a Supervised Gateway. It uses Wallet V5 Extensions to enforce on-chain spending limits and a Telegram-native Human-in-the-Loop (HITL) plane for high-value transactions.

Key Features
W5 Policy Extensions: Programmable guardrails (Daily limits, Whitelists) enforced directly on the TVM.
x402 Protocol Implementation: Seamless machine-to-machine commerce using the HTTP 402 "Payment Required" 

standard .
Gasless Transactions: Agents can pay network fees in USDT/Jettons, removing the need to manage native 

TON for gas .
MCP Server (Model Context Protocol): A standard bridge that allows LLMs (Claude, GPT) to "understand" and execute TON smart contract calls.

Telegram HITL Dashboard: A Mini App for humans to set budgets and approve "Exception Requests" in real-time .

## Architecture
🏗️ Architecture
AI Reasoning Layer: The agent identifies a need (e.g., "I need a weather forecast API").
x402 Challenge: The service provider issues an HTTP 402 challenge (Price, Address, Network).
SDK Policy Check: The TonPay 402 SDK checks the request against on-chain policies.
W5 Execution: If within limits, the Wallet V5 Extension authorizes an internal_signed message to execute the payment.

Human Escalation: If the limit is exceeded, an event is emitted to the Telegram Bot, providing the user with "Approve/Reject" buttons.

## Overview

TonPay402 combines:

- A **Tact smart contract** that enforces spending guardrails.
- An **MCP server** that lets AI agents call payment tools.
- A **Telegram bot** that catches over-limit approval requests and lets an owner approve/reject.

## Repository Structure

- `contracts/` — Tact contract source (`ton_pay402.tact`)
- `tests/` — sandbox tests for payment policy behavior
- `scripts/` — deploy script(s)
- `build/` — generated wrappers/artifacts
- `mcp-server/` — MCP runtime + Telegram approval bot

## How It Works

1. Agent calls MCP tool `execute_m2m_payment`.
2. MCP server sends `ExecutePayment` to contract using the **agent wallet**.
3. Contract behavior:
   - If within limit: executes transfer.
   - If over limit (agent path): emits `ApprovalRequest` and does not transfer.
4. Telegram bot polls contract transactions, decodes `ApprovalRequest`, and notifies owner.
5. Owner taps **Approve** (owner wallet sends `ExecutePayment`) or **Reject**.

## Smart Contract Policy

Current policy in `contracts/ton_pay402.tact`:

- Access control: only `owner` or `agent` can call `ExecutePayment`
- Daily spend limit with 24h reset
- Over-limit agent request escalates to manual approval path
- Owner can execute approved payment manually

## Prerequisites

- Node.js 20+
- npm
- TON testnet wallets (agent + owner) with balance for gas
- Telegram bot token (from `@BotFather`)

## Setup

### 1) Install root dependencies

```bash
npm install
```

### 2) Build contract wrappers

```bash
npx blueprint build
```

### 3) Run contract tests

```bash
npx blueprint test
```

### 4) Configure MCP server + bot

```bash
cd mcp-server
npm install
cp .env.example .env
```

Fill `.env` values:

- `TON_NETWORK` (`testnet` or `mainnet`)
- `TON_API_KEY` (optional)
- `EXECUTION_BUFFER_TON`
- `CONTRACT_ADDRESS`
- `AGENT_MNEMONIC`
- `AGENT_WALLET_WORKCHAIN`
- `OWNER_MNEMONIC`
- `OWNER_WALLET_WORKCHAIN`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `APPROVAL_POLL_INTERVAL_MS`

> Never commit real mnemonics or bot secrets.

## Running

From `mcp-server/`:

```bash
npm run start:mcp
```

In a second terminal:

```bash
npm run start:bot
```

## MCP Tools

- `get_allowance`
  - Input: `contractAddress`
  - Output: remaining allowance in TON

- `execute_m2m_payment`
  - Input: `contractAddress`, `targetAddress`, `amountInTon`
  - Sends `ExecutePayment` from agent wallet
  - Over-limit requests are escalated by contract and picked up by Telegram bot

## Security Notes

- Use separate mnemonics for owner and agent wallets.
- Keep owner mnemonic only in secure runtime environments.
- Restrict Telegram bot usage to the owner chat ID.
- Consider persistent storage for pending approvals in production.
- Consider indexed/event-driven ingestion (webhook/indexer) instead of pure polling.

## Development Notes

- Contract tests are in `tests/TonPay402.spec.ts`.
- MCP server implementation: `mcp-server/index.ts`.
- Telegram approval flow: `mcp-server/bot.ts`.

## 🗺️ Roadmap
[x] Core Tact Contract for Policy Management.
[x] MCP Server for LLM tool-calling.
[ ] Integration with AEON/x402 facilitators .
[ ] Multi-agent "Broker" for shared budget envelopes .
[ ] Mainnet Deployment with Wallet V5 integration.

## License

This project is licensed under the MIT License.
