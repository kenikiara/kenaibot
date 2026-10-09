import { api_base } from '@/external/bot-skeleton';
import { TContractType } from './trade-types';

/**
 * Buys a single contract on the logged-in account and waits for it to settle.
 * Uses the app's authenticated (OTP) connection, which already streams
 * proposal_open_contract updates for every open contract.
 */

export type TTradeRequest = {
    symbol: string;
    contract_type: TContractType;
    barrier?: number;
    stake: number;
    duration: number;
};

export type TTradeResult = {
    contract_id: number;
    contract_type: TContractType;
    barrier?: number;
    buy_price: number;
    payout: number;
    profit: number;
    is_win: boolean;
    exit_spot?: string;
    currency: string;
    time: number;
};

const SETTLE_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 3000;

export const isTradingReady = () => Boolean(api_base.api && api_base.is_authorized);

export const getAccountCurrency = (): string => (api_base.account_info as { currency?: string })?.currency || 'USD';

const errorMessage = (error: any): string =>
    error?.error?.message || error?.message || (typeof error === 'string' ? error : 'Request failed');

const send = async (payload: Record<string, unknown>): Promise<any> => {
    if (!api_base.api) throw new Error('Not connected');
    try {
        // DerivAPIBasic.send resolves with the response; the vendored type says void
        const response = await (api_base.api as unknown as { send: (data: unknown) => Promise<any> }).send(payload);
        if (response?.error) throw new Error(response.error.message);
        return response;
    } catch (error) {
        throw new Error(errorMessage(error));
    }
};

const waitForSettlement = (contract_id: number): Promise<any> =>
    new Promise((resolve, reject) => {
        let finished = false;
        const done = (contract: any) => {
            if (finished || !contract?.is_sold) return;
            finished = true;
            cleanup();
            resolve(contract);
        };
        const subscription = api_base.api?.onMessage().subscribe(({ data }: { data: any }) => {
            if (
                data?.msg_type === 'proposal_open_contract' &&
                data.proposal_open_contract?.contract_id === contract_id
            ) {
                done(data.proposal_open_contract);
            }
        });
        // Fallback in case the stream drops an update
        const poll = setInterval(() => {
            send({ proposal_open_contract: 1, contract_id })
                .then(response => done(response.proposal_open_contract))
                .catch(() => undefined);
        }, POLL_INTERVAL_MS);
        const timeout = setTimeout(() => {
            if (finished) return;
            finished = true;
            cleanup();
            reject(new Error('Timed out waiting for the contract result'));
        }, SETTLE_TIMEOUT_MS);
        const cleanup = () => {
            subscription?.unsubscribe();
            clearInterval(poll);
            clearTimeout(timeout);
        };
    });

export const buyContract = async (request: TTradeRequest): Promise<TTradeResult> => {
    if (!isTradingReady()) throw new Error('Log in to trade');
    const currency = getAccountCurrency();

    const { proposal } = await send({
        proposal: 1,
        amount: request.stake,
        basis: 'stake',
        currency,
        duration: request.duration,
        duration_unit: 't',
        contract_type: request.contract_type,
        underlying_symbol: request.symbol,
        ...(request.barrier !== undefined ? { barrier: String(request.barrier) } : {}),
    });

    const { buy } = await send({ buy: proposal.id, price: proposal.ask_price });
    const contract = await waitForSettlement(buy.contract_id);
    const profit = Number(contract.profit);

    return {
        contract_id: buy.contract_id,
        contract_type: request.contract_type,
        barrier: request.barrier,
        buy_price: Number(buy.buy_price),
        payout: Number(buy.payout),
        profit,
        is_win: profit > 0,
        exit_spot: contract.exit_tick_display_value ?? contract.exit_spot,
        currency,
        time: Date.now(),
    };
};
