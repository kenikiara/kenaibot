import { api_base } from '@/external/bot-skeleton';
import { getAccountCurrency, isTradingReady } from '@/pages/trading/trade-service';

/**
 * Places contracts directly with `buy` + parameters (one round trip, so
 * 1-tick entries land on the next tick) and waits for them to settle on the
 * app's authenticated connection.
 */

export type TContract =
    | 'DIGITOVER'
    | 'DIGITUNDER'
    | 'DIGITEVEN'
    | 'DIGITODD'
    | 'DIGITMATCH'
    | 'DIGITDIFF'
    | 'CALL'
    | 'PUT'
    | 'RUNHIGH'
    | 'RUNLOW'
    | 'ACCU';

export type TLeg = {
    symbol: string;
    contract_type: TContract;
    barrier?: number;
    /** Ticks; ignored for accumulators. */
    duration?: number;
    label: string;
    /** Accumulators only. */
    growth_rate?: number;
    take_profit?: number;
};

export type TLegResult = {
    leg: TLeg;
    contract_id?: number;
    buy_price: number;
    profit: number;
    is_win: boolean;
    contract?: any;
    error?: string;
};

export type TExecuteHooks = {
    onBought?: (leg: TLeg, buy: any) => void;
    onUpdate?: (leg: TLeg, contract: any) => void;
};

const SETTLE_TIMEOUT_MS = 90000;
const ACCU_TIMEOUT_MS = 15 * 60000;
const POLL_INTERVAL_MS = 3000;

const errorMessage = (error: any): string =>
    error?.error?.message || error?.message || (typeof error === 'string' ? error : 'Request failed');

export const send = async (payload: Record<string, unknown>): Promise<any> => {
    if (!api_base.api) throw new Error('Not connected');
    try {
        const response = await (api_base.api as unknown as { send: (data: unknown) => Promise<any> }).send(payload);
        if (response?.error) throw new Error(response.error.message);
        return response;
    } catch (error) {
        throw new Error(errorMessage(error));
    }
};

const waitForSettlement = (contract_id: number, timeout_ms: number, onUpdate?: (contract: any) => void) =>
    new Promise<any>((resolve, reject) => {
        let finished = false;
        const handle = (contract: any) => {
            if (finished || !contract) return;
            onUpdate?.(contract);
            if (!contract.is_sold) return;
            finished = true;
            cleanup();
            resolve(contract);
        };
        const subscription = api_base.api?.onMessage().subscribe(({ data }: { data: any }) => {
            if (data?.msg_type === 'proposal_open_contract' && data.proposal_open_contract?.contract_id === contract_id) {
                handle(data.proposal_open_contract);
            }
        });
        const poll = setInterval(() => {
            send({ proposal_open_contract: 1, contract_id })
                .then(response => handle(response.proposal_open_contract))
                .catch(() => undefined);
        }, POLL_INTERVAL_MS);
        const timeout = setTimeout(() => {
            if (finished) return;
            finished = true;
            cleanup();
            reject(new Error('Timed out waiting for the contract result'));
        }, timeout_ms);
        const cleanup = () => {
            subscription?.unsubscribe();
            clearInterval(poll);
            clearTimeout(timeout);
        };
    });

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Buys one contract and resolves once it has settled. Never rejects: failures come back with `error`. */
export const placeLeg = async (leg: TLeg, stake: number, hooks: TExecuteHooks = {}): Promise<TLegResult> => {
    if (!isTradingReady()) return { leg, buy_price: 0, profit: 0, is_win: false, error: 'Log in to trade' };
    const amount = round2(stake);
    const is_accumulator = leg.contract_type === 'ACCU';
    const parameters: Record<string, unknown> = {
        amount,
        basis: 'stake',
        contract_type: leg.contract_type,
        currency: getAccountCurrency(),
        underlying_symbol: leg.symbol,
    };
    if (is_accumulator) {
        parameters.growth_rate = leg.growth_rate ?? 0.05;
        if (leg.take_profit && leg.take_profit > 0) parameters.limit_order = { take_profit: round2(leg.take_profit) };
    } else {
        parameters.duration = leg.duration ?? 1;
        parameters.duration_unit = 't';
    }
    if (leg.barrier !== undefined) parameters.barrier = String(leg.barrier);

    try {
        const { buy } = await send({ buy: 1, price: amount, parameters });
        hooks.onBought?.(leg, buy);
        const contract = await waitForSettlement(
            buy.contract_id,
            is_accumulator ? ACCU_TIMEOUT_MS : SETTLE_TIMEOUT_MS,
            update => hooks.onUpdate?.(leg, update)
        );
        const profit = round2(Number(contract.profit) || 0);
        return {
            leg,
            contract_id: buy.contract_id,
            buy_price: Number(buy.buy_price) || amount,
            profit,
            is_win: profit > 0,
            contract,
        };
    } catch (error) {
        return { leg, buy_price: 0, profit: 0, is_win: false, error: errorMessage(error) };
    }
};

/** Sells an open contract at market (used to close accumulators early). */
export const sellContract = (contract_id: number) => send({ sell: contract_id, price: 0 });
