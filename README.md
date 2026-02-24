# TonPay402

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TON Network](https://img.shields.io/badge/TON-Testnet-0098EA)](https://ton.org)
[![Blueprint Tests](https://img.shields.io/badge/Blueprint-Tests%20Passing-success)](./tests)
[![MCP](https://img.shields.io/badge/MCP-Server-5A67D8)](./mcp-server)

🤖 TonPay 402: The Universal M2M Payment Rail for TON AI Agents
TonPay 402 is a specialized infrastructure toolkit designed to enable secure, autonomous, and policy-driven payments for AI agents on the TON Blockchain. By leveraging the Wallet V5 (W5) standard and the x402 (HTTP 402) protocol, it provides the "financial guardrails" necessary for agents to participate in the machine economy without compromising user funds.

## ⚡ Unique Differentiators 

> **TonPay402 is not just a 402 paywall gateway — it is a treasury policy engine for AI agents.**

### What you see in 10 seconds

- ✅ **On-chain spending policy enforcement** (not only backend checks)
- ✅ **Human-in-the-loop approval path** for risky transactions (`ApprovalRequest` -> Approve/Reject)
- ✅ **Whitelist bypass for trusted targets** (agent can pay approved oracles/APIs without daily cap)
- ✅ **Durable approval state + idempotent handling** (restart-safe bot workflows)
- ✅ **End-to-end audit correlation** via `requestId` + approval refs + status transitions

## TonPay402 vs Generic 402 Gateway Model

| Capability | Generic 402 Gateway | TonPay402 |
|---|---|---|
| Core flow | Paywall access (pay -> token) | Policy-checked treasury execution |
| Over-limit handling | Usually reject/fail | Emit `ApprovalRequest` + human approval path |
| Trusted vendor fast lane | Rare | Whitelist-based limit bypass for approved recipients |
| Approval lifecycle | Minimal/manual | `pending -> approved/rejected/failed` persisted state |
| Auditability | Basic payment logs | Correlated `requestId` + approval records + status trail |
| Agent safety | Limited | On-chain spend limits + explicit HITL escalation |

## Positioning

TonPay402 is a **policy engine for agent treasuries**, not only a payment gateway.

- Focus: autonomous spend with hard guardrails + human escalation
- Primary user: operators of AI agents that need both automation and accountability
- Core promise: programmable spending policies, approval lifecycle, and audit traceability

## Problem 

🚀 The Problem: The "Toddler with a Credit Card" Dilemma
AI Agents are becoming autonomous economic actors—buying API credits, renting GPU power, or hiring other sub-agents. However, giving an LLM-based agent full access to a seed phrase is an extreme security risk . Current solutions either:

Risk total drainage via prompt injection or logic bugs.

Require constant human approval, defeating the purpose of autonomy.


## Solution

✅ The Solution: TonPay 402
TonPay402 provides a supervised spending stack for agents:

- **On-chain policy contract** for daily budget controls
- **Whitelist policy** for trusted recipients (oracle/API fast lane)
- **MCP tool interface** for agent-native execution
- **Telegram HITL approvals** for exceptional payments
- **Persistent audit state** for production-safe operations

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
   - If target is whitelisted: executes transfer without consuming daily limit.
   - If target is not whitelisted and within limit: executes transfer.
   - If target is not whitelisted and over limit (agent path): emits `ApprovalRequest` and does not transfer.
4. Telegram bot polls contract transactions, decodes `ApprovalRequest`, and notifies owner.
5. Owner taps **Approve** (owner wallet sends `ExecutePayment`) or **Reject**.

## Approval Lifecycle & Audit State

TonPay402 tracks manual-approval requests through a durable lifecycle in the bot state file:

- `pending` — request detected from chain and awaiting decision
- `approved` — owner approved and submission was sent
- `rejected` — owner explicitly rejected
- `failed` — approval action failed during submission

Each request is identified by a stable approval reference and can be correlated with client-side `requestId` in MCP payment submissions.

## Smart Contract Policy

Current policy in `contracts/ton_pay402.tact`:

- Access control: only `owner` or `agent` can call `ExecutePayment`
- Daily spend limit with 24h reset
- Owner-managed whitelist for trusted recipients
- Whitelisted targets bypass daily-limit accounting for agent payments
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
- `APPROVAL_STATE_FILE` (persistent bot state file, default `approval-state.json`)
- `BOOTSTRAP_HISTORY_LIMIT` (how many recent txs to mark as seen on first startup)
- `REQUEST_AUDIT_FILE` (shared MCP/bot request audit log, default `request-audit.json`)

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
  - Input: `contractAddress`, `targetAddress`, `amountInTon`, optional `requestId`
  - Sends `ExecutePayment` from agent wallet
  - Over-limit requests are escalated by contract and picked up by Telegram bot

## Security Notes

- Use separate mnemonics for owner and agent wallets.
- Keep owner mnemonic only in secure runtime environments.
- Restrict Telegram bot usage to the owner chat ID.
- Back up and protect `APPROVAL_STATE_FILE` since it stores approval/audit state.
- Back up and protect `REQUEST_AUDIT_FILE` since it links `requestId` to approval outcomes.
- Consider indexed/event-driven ingestion (webhook/indexer) instead of pure polling.

## Development Notes

- Contract tests are in `tests/TonPay402.spec.ts`.
- MCP server implementation: `mcp-server/index.ts`.
- Telegram approval flow: `mcp-server/bot.ts`.

## 🗺️ Roadmap
- [x] Core Tact Contract for Policy Management.
- [x] MCP Server for LLM tool-calling.
- [ ] Integration with AEON/x402 facilitators .
- [ ] Multi-agent "Broker" for shared budget envelopes .
- [ ] Mainnet Deployment with Wallet V5 integration.

## License

This project is licensed under the MIT License.
