import { TMarket } from '@/pages/scanner/scanner-feed';
import { TContract, TLeg } from '../engine/execute';
import { TFieldOption } from '../engine/types';

export const VOLATILITY_10 = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'];
export const ONE_SECOND_8 = ['1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V'];
export const ONE_SECOND_5 = ['1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'];
export const JUMP_5 = ['JD10', 'JD25', 'JD50', 'JD75', 'JD100'];
export const ALL_SYNTHETIC = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', ...ONE_SECOND_8, ...JUMP_5];

export const MARKET_NAMES: Record<string, string> = {
    R_10: 'Volatility 10 Index',
    R_25: 'Volatility 25 Index',
    R_50: 'Volatility 50 Index',
    R_75: 'Volatility 75 Index',
    R_100: 'Volatility 100 Index',
    '1HZ10V': 'Volatility 10 (1s) Index',
    '1HZ15V': 'Volatility 15 (1s) Index',
    '1HZ25V': 'Volatility 25 (1s) Index',
    '1HZ30V': 'Volatility 30 (1s) Index',
    '1HZ50V': 'Volatility 50 (1s) Index',
    '1HZ75V': 'Volatility 75 (1s) Index',
    '1HZ90V': 'Volatility 90 (1s) Index',
    '1HZ100V': 'Volatility 100 (1s) Index',
    JD10: 'Jump 10 Index',
    JD25: 'Jump 25 Index',
    JD50: 'Jump 50 Index',
    JD75: 'Jump 75 Index',
    JD100: 'Jump 100 Index',
};

export const marketName = (symbol: string) => MARKET_NAMES[symbol] ?? symbol;

export const marketOptions = (symbols: string[]): TFieldOption[] =>
    symbols.map(symbol => ({ value: symbol, label: marketName(symbol) }));

export const DIGIT_OPTIONS: TFieldOption[] = Array.from({ length: 10 }, (_, d) => ({ value: d, label: String(d) }));

export const rangeOptions = (from: number, to: number, suffix = ''): TFieldOption[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ value: from + i, label: `${from + i}${suffix}` }));

export const SIDE_OPTIONS: TFieldOption[] = [
    { value: 'over', label: 'Over' },
    { value: 'under', label: 'Under' },
];

export const TRIGGER_OPTIONS: TFieldOption[] = [
    { value: 'losses', label: 'Losses' },
    { value: 'wins', label: 'Wins' },
];

export const STRATEGY_OPTIONS: TFieldOption[] = [
    { value: 'CONTINUING', label: 'Continuing (same side)' },
    { value: 'REVERSING', label: 'Reversing (opposite side)' },
];

export const TRACKING_OPTIONS: TFieldOption[] = [
    { value: 'all', label: 'All markets' },
    { value: 'single', label: 'Selected market only' },
];

export type TSide = 'over' | 'under';

export const lastDigit = (market: TMarket) => market.digits[market.digits.length - 1];

/** Over/Under barriers that can never win are nudged to the nearest playable one. */
export const playableBarrier = (side: TSide, barrier: number) => {
    if (side === 'over') return Math.min(8, Math.max(0, barrier));
    return Math.min(9, Math.max(1, barrier));
};

export const overUnderWins = (side: TSide, barrier: number, digit: number) => (side === 'over' ? digit > barrier : digit < barrier);

export const overUnderLeg = (symbol: string, side: TSide, barrier: number, duration = 1, prefix = ''): TLeg => {
    const playable = playableBarrier(side, barrier);
    return {
        symbol,
        contract_type: side === 'over' ? 'DIGITOVER' : 'DIGITUNDER',
        barrier: playable,
        duration,
        label: `${prefix}${side === 'over' ? 'Over' : 'Under'} ${playable}`,
    };
};

export const digitLeg = (symbol: string, contract_type: TContract, duration = 1, barrier?: number): TLeg => {
    const names: Partial<Record<TContract, string>> = {
        DIGITEVEN: 'Even',
        DIGITODD: 'Odd',
        DIGITMATCH: 'Matches',
        DIGITDIFF: 'Differs',
        CALL: 'Rise',
        PUT: 'Fall',
        RUNHIGH: 'Only Ups',
        RUNLOW: 'Only Downs',
    };
    const name = names[contract_type] ?? contract_type;
    return { symbol, contract_type, duration, barrier, label: barrier === undefined ? name : `${name} ${barrier}` };
};

/** Length and kind of the run at the end of `values` (e.g. 4 evens in a row). */
export const trailingRun = <T>(values: T[]): { kind: T | null; count: number } => {
    if (!values.length) return { kind: null, count: 0 };
    const kind = values[values.length - 1];
    let count = 1;
    for (let i = values.length - 2; i >= 0 && values[i] === kind; i--) count++;
    return { kind, count };
};

/** +1 / -1 for each price move, unchanged ticks skipped. */
export const priceMoves = (quotes: number[]) => {
    const moves: number[] = [];
    for (let i = 1; i < quotes.length; i++) {
        if (quotes[i] > quotes[i - 1]) moves.push(1);
        else if (quotes[i] < quotes[i - 1]) moves.push(-1);
    }
    return moves;
};

export const pct = (n: number) => `${n.toFixed(1)}%`;
