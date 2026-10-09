import { TMarket } from '../scanner/scanner-feed';
import { TContractType, TTradeTypeKey } from './trade-types';

/**
 * One simple, readable strategy per trade type. Each `decide` looks at the
 * latest ticks and returns the contract to buy now, or null to wait.
 *
 * None of these change the odds: every tick is independent, so they decide
 * *when* to trade, not whether a trade is more likely to win.
 */

export type TParamOption = { value: number; label: string };

export type TStrategyParam = {
    key: string;
    label: string;
    options: TParamOption[];
    default: number;
};

export type TDecision = { contract_type: TContractType; barrier?: number; duration: number } | null;

export type TStrategy = {
    key: string;
    name: string;
    trade_type: TTradeTypeKey;
    summary: string;
    reality: string;
    params: TStrategyParam[];
    decide: (market: TMarket, params: Record<string, number>) => TDecision;
};

const nums = (values: number[], suffix = '') =>
    values.map(value => ({ value, label: `${value}${value === 1 ? suffix.replace(/s$/, '') : suffix}` }));
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const lastN = <T>(items: T[], n: number) => (items.length >= n ? items.slice(-n) : null);

export const STRATEGIES: TStrategy[] = [
    {
        key: 'parity_reversal',
        name: 'Parity streak reversal',
        trade_type: 'even_odd',
        summary: 'Waits for the same parity several ticks in a row, then buys the opposite (e.g. 4 odds → buy Even).',
        reality:
            'Even pays about 1.95 per 1 staked, so you need about 51.2% wins to break even. The true rate stays 50% after any streak.',
        params: [
            { key: 'streak', label: 'Streak length', options: nums([2, 3, 4, 5, 6, 7, 8]), default: 4 },
            { key: 'duration', label: 'Duration', options: nums([1, 2, 3, 5], ' ticks'), default: 1 },
        ],
        decide: (market, { streak, duration }) => {
            const recent = lastN(market.digits, streak);
            if (!recent) return null;
            const parity = recent[0] % 2;
            if (!recent.every(d => d % 2 === parity)) return null;
            return { contract_type: parity === 0 ? 'DIGITODD' : 'DIGITEVEN', duration };
        },
    },
    {
        key: 'cold_side',
        name: 'Cold side entry',
        trade_type: 'over_under',
        summary: 'Picks Over or Under a barrier and only buys after that side has lost several ticks in a row.',
        reality:
            'Over 2 (and Under 7) win 70% of ticks but pay about 1.40, which needs 71.2% to break even. Waiting for a cold run does not raise that 70%.',
        params: [
            {
                key: 'direction',
                label: 'Side',
                options: [
                    { value: 1, label: 'Over' },
                    { value: 0, label: 'Under' },
                ],
                default: 1,
            },
            { key: 'barrier', label: 'Barrier', options: nums(DIGITS.slice(1, 9)), default: 2 },
            { key: 'streak', label: 'Losses in a row', options: nums([1, 2, 3, 4, 5]), default: 2 },
            { key: 'duration', label: 'Duration', options: nums([1, 2, 3, 5], ' ticks'), default: 1 },
        ],
        decide: (market, { direction, barrier, streak, duration }) => {
            const recent = lastN(market.digits, streak);
            if (!recent) return null;
            const is_over = direction === 1;
            const wins = (d: number) => (is_over ? d > barrier : d < barrier);
            if (recent.some(wins)) return null;
            return { contract_type: is_over ? 'DIGITOVER' : 'DIGITUNDER', barrier, duration };
        },
    },
    {
        key: 'differs_last',
        name: 'Differs from last digit',
        trade_type: 'matches_differs',
        summary: 'Buys Differs on whatever digit just appeared, betting it will not repeat on the next tick.',
        reality:
            'Wins about 90% of trades but pays only about 1.10 per 1 staked, so one loss wipes out roughly 10 wins. Break-even is 91.2%.',
        params: [{ key: 'duration', label: 'Duration', options: nums([1, 2, 3, 5], ' ticks'), default: 1 }],
        decide: (market, { duration }) => {
            const last = market.digits[market.digits.length - 1];
            if (last === undefined) return null;
            return { contract_type: 'DIGITDIFF', barrier: last, duration };
        },
    },
    {
        key: 'momentum',
        name: 'Tick momentum',
        trade_type: 'rise_fall',
        summary: 'After several rising ticks in a row buys Rise; after several falling ticks buys Fall.',
        reality:
            'Synthetic prices are a random walk, so past direction does not predict the next move. Payout is about 1.95 per 1 staked.',
        params: [
            { key: 'streak', label: 'Ticks in a row', options: nums([2, 3, 4, 5, 6]), default: 3 },
            { key: 'duration', label: 'Duration', options: nums([1, 2, 3, 5, 10], ' ticks'), default: 5 },
        ],
        decide: (market, { streak, duration }) => {
            const recent = lastN(market.quotes, streak + 1);
            if (!recent) return null;
            const moves = recent.slice(1).map((q, i) => Math.sign(q - recent[i]));
            if (moves.every(m => m > 0)) return { contract_type: 'CALL', duration };
            if (moves.every(m => m < 0)) return { contract_type: 'PUT', duration };
            return null;
        },
    },
];

export const defaultParams = (strategy: TStrategy) =>
    Object.fromEntries(strategy.params.map(p => [p.key, p.default])) as Record<string, number>;
