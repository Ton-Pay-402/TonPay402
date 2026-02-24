import { toNano, address } from '@ton/core';
import { TonPay402 } from '../build/TonPay402/TonPay402_TonPay402';
import { NetworkProvider } from '@ton/blueprint';

function requiredEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

export async function run(provider: NetworkProvider) {
    const owner = provider.sender().address!;
    const agent = address(requiredEnv('AGENT_ADDRESS'));
    const dailyLimitTon = process.env.DAILY_LIMIT_TON?.trim() || '10';
    const dailyLimit = toNano(dailyLimitTon);

    const tonPay402 = provider.open(await TonPay402.fromInit(owner, agent, dailyLimit));

    await tonPay402.send(
        provider.sender(),
        {
            value: toNano('0.05'),
        },
        { $$type: 'UpdateSettings', newLimit: dailyLimit },
    );

    await provider.waitForDeploy(tonPay402.address);
    console.log(`TonPay402 deployed at: ${tonPay402.address.toString()}`);
    console.log(`Owner: ${owner.toString()}`);
    console.log(`Agent: ${agent.toString()}`);
    console.log(`Daily limit: ${dailyLimitTon} TON`);
}
