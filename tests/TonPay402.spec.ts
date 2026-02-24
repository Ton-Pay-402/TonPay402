import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano, Address } from '@ton/core';
import { TonPay402 } from '../build/TonPay402/TonPay402_TonPay402';
import '@ton/test-utils';

describe('TonPay402 spending limits', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let agent: SandboxContract<TreasuryContract>;
    let tonPay402: SandboxContract<TonPay402>;
    let merchant: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        agent = await blockchain.treasury('agent');
        merchant = await blockchain.treasury('merchant');

        // Initialize contract with a 10 TON daily limit
        tonPay402 = blockchain.openContract(
            await TonPay402.fromInit(deployer.address, agent.address, toNano('10'))
        );

        const deployResult = await tonPay402.send(
            deployer.getSender(),
            { value: toNano('0.05') },
            { $$type: 'Deploy', queryId: 0n }
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: tonPay402.address,
            deploy: true,
            success: true,
        });
    });

    it('should allow payment within limit', async () => {
        const amount = toNano('2'); // 2 TON < 10 TON limit

        const result = await tonPay402.send(
            agent.getSender(),
            { value: toNano('2.1') }, // Send enough to cover payment + gas
            {
                $$type: 'ExecutePayment',
                amount: amount,
                target: merchant.address,
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: tonPay402.address,
            to: merchant.address,
            success: true,
        });
    });

    it('should allow agent over-limit payment to whitelisted target without consuming daily limit', async () => {
        await tonPay402.send(
            deployer.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'UpdateWhitelist',
                target: merchant.address,
                allowed: true,
            }
        );

        const overLimitResult = await tonPay402.send(
            agent.getSender(),
            { value: toNano('15.1') },
            {
                $$type: 'ExecutePayment',
                amount: toNano('15'),
                target: merchant.address,
            }
        );

        expect(overLimitResult.transactions).toHaveTransaction({
            from: tonPay402.address,
            to: merchant.address,
            success: true,
        });

        // Whitelisted transfers bypass daily limit accounting.
        const remaining = await tonPay402.getRemainingAllowance();
        expect(remaining).toEqual(toNano('10'));
    });

    it('should emit approval path and not transfer when agent exceeds limit', async () => {
        const amount = toNano('15'); // 15 TON > 10 TON limit

        const result = await tonPay402.send(
            agent.getSender(),
            { value: toNano('15.1') },
            {
                $$type: 'ExecutePayment',
                amount: amount,
                target: merchant.address,
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: agent.address,
            to: tonPay402.address,
            success: true,
        });

        // Should not execute the outgoing payment transfer
        expect(result.transactions).not.toHaveTransaction({
            from: tonPay402.address,
            to: merchant.address,
            success: true,
        });
    });

    it('should allow owner to execute an over-limit payment as manual approval', async () => {
        const result = await tonPay402.send(
            deployer.getSender(),
            { value: toNano('15.1') },
            {
                $$type: 'ExecutePayment',
                amount: toNano('15'),
                target: merchant.address,
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: tonPay402.address,
            to: merchant.address,
            success: true,
        });
    });

    it('should reject payment from unauthorized sender', async () => {
        const stranger = await blockchain.treasury('stranger');
        const amount = toNano('1');

        const result = await tonPay402.send(
            stranger.getSender(),
            { value: toNano('1.1') },
            {
                $$type: 'ExecutePayment',
                amount: amount,
                target: merchant.address,
            }
        );

        expect(result.transactions).toHaveTransaction({
            from: stranger.address,
            to: tonPay402.address,
            success: false,
        });
    });

    it('should reset limit after 24 hours', async () => {
        // 1. Spend 9 TON (almost full limit)
        await tonPay402.send(agent.getSender(), { value: toNano('9.1') }, {
            $$type: 'ExecutePayment',
            amount: toNano('9'),
            target: merchant.address,
        });

        // 2. Try to spend 5 TON more (should fail)
        const failedResult = await tonPay402.send(agent.getSender(), { value: toNano('5.1') }, {
            $$type: 'ExecutePayment',
            amount: toNano('5'),
            target: merchant.address,
        });
        expect(failedResult.transactions).toHaveTransaction({
            from: agent.address,
            to: tonPay402.address,
            success: true,
        });
        expect(failedResult.transactions).not.toHaveTransaction({
            from: tonPay402.address,
            to: merchant.address,
            success: true,
        });

        // 3. Fast-forward time by 25 hours 
        blockchain.now = (blockchain.now?? Math.floor(Date.now() / 1000)) + 90000;

        // 4. Try again (should succeed now)
        const successResult = await tonPay402.send(agent.getSender(), { value: toNano('5.1') }, {
            $$type: 'ExecutePayment',
            amount: toNano('5'),
            target: merchant.address,
        });
        expect(successResult.transactions).toHaveTransaction({ success: true });
    });
});