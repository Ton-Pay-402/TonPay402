import { toNano, address } from '@ton/core';
import { TonPay402 } from '../build/TonPay402/TonPay402_TonPay402';
import { NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const owner = provider.sender().address!;
    const agent = address('REPLACE_WITH_AGENT_ADDRESS'); // TODO: set your AI agent's address
    const dailyLimit = toNano('10'); // 10 TON daily limit

    const tonPay402 = provider.open(await TonPay402.fromInit(owner, agent, dailyLimit));

    await tonPay402.send(
        provider.sender(),
        {
            value: toNano('0.05'),
        },
        { $$type: 'Deploy', queryId: 0n },
    );

    await provider.waitForDeploy(tonPay402.address);

    // run methods on `tonPay402`
}
