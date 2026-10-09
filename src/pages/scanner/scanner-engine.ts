/**
 * Pure statistics for the digit scanner. No I/O here so it can be unit tested.
 *
 * Synthetic index ticks come from an audited RNG, so every last digit is
 * expected to be uniform (10% each) and independent of the previous ones.
 * Everything below measures how far a window drifts from that expectation and
 * labels the drift honestly instead of presenting it as a signal.
 */

export type TScanMode = 'even_odd' | 'over_under';

export type TSide = {
    key: string;
    label: string;
    contract_type: 'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER';
    barrier?: number;
    /** Probability of a win if digits are uniform. */
    expected: number;
    wins: (digit: number) => boolean;
};

export type TSignificance = 'normal' | 'unusual' | 'rare';

export type TSideStats = {
    side: TSide;
    hits: number;
    rate: number;
    z: number;
    significance: TSignificance;
    /** Consecutive most-recent ticks where this side won. */
    win_streak: number;
    /** Consecutive most-recent ticks where this side lost. */
    loss_streak: number;
    longest_loss_streak: number;
};

export type TWindowStats = {
    sample_size: number;
    digit_counts: number[];
    sides: TSideStats[];
    /** The side with the largest absolute z-score. */
    leader: TSideStats | null;
};

export type TRuleResult = {
    trades: number;
    wins: number;
    win_rate: number;
    /** Net profit per 1 unit staked on every trade. */
    net: number;
};

/**
 * Last digit of a quote. Quotes must be padded to pip_size decimals first:
 * 1234.5 at 2 decimals is really 1234.50, so the last digit is 0, not 5.
 */
export const getLastDigit = (quote: number, decimals: number): number => {
    const text = quote.toFixed(Math.max(0, decimals));
    return Number(text[text.length - 1]);
};

/** active_symbols reports pip_size as a step (0.001); ticks report it as decimals (3). */
export const pipStepToDecimals = (pip: number | undefined): number => {
    if (!pip || pip <= 0) return 2;
    if (pip >= 1 && Number.isInteger(pip)) return pip;
    return Math.max(0, Math.round(-Math.log10(pip)));
};

export const getSides = (mode: TScanMode, barrier: number): TSide[] => {
    if (mode === 'even_odd') {
        return [
            {
                key: 'even',
                label: 'Even',
                contract_type: 'DIGITEVEN',
                expected: 0.5,
                wins: d => d % 2 === 0,
            },
            {
                key: 'odd',
                label: 'Odd',
                contract_type: 'DIGITODD',
                expected: 0.5,
                wins: d => d % 2 === 1,
            },
        ];
    }
    const sides: TSide[] = [];
    if (barrier <= 8) {
        sides.push({
            key: `over_${barrier}`,
            label: `Over ${barrier}`,
            contract_type: 'DIGITOVER',
            barrier,
            expected: (9 - barrier) / 10,
            wins: d => d > barrier,
        });
    }
    if (barrier >= 1) {
        sides.push({
            key: `under_${barrier}`,
            label: `Under ${barrier}`,
            contract_type: 'DIGITUNDER',
            barrier,
            expected: barrier / 10,
            wins: d => d < barrier,
        });
    }
    return sides;
};

/** Standard score of an observed hit rate against the uniform expectation. */
export const zScore = (hits: number, n: number, expected: number): number => {
    if (n === 0 || expected <= 0 || expected >= 1) return 0;
    const se = Math.sqrt((expected * (1 - expected)) / n);
    return (hits / n - expected) / se;
};

export const classifyZ = (z: number): TSignificance => {
    const abs = Math.abs(z);
    if (abs >= 3) return 'rare';
    if (abs >= 2) return 'unusual';
    return 'normal';
};

const trailingRun = (digits: number[], predicate: (d: number) => boolean): number => {
    let run = 0;
    for (let i = digits.length - 1; i >= 0 && predicate(digits[i]); i--) run++;
    return run;
};

const longestRun = (digits: number[], predicate: (d: number) => boolean): number => {
    let best = 0;
    let run = 0;
    for (const d of digits) {
        run = predicate(d) ? run + 1 : 0;
        if (run > best) best = run;
    }
    return best;
};

export const computeWindowStats = (all_digits: number[], window: number, sides: TSide[]): TWindowStats => {
    const digits = all_digits.slice(-window);
    const digit_counts = new Array(10).fill(0);
    for (const d of digits) digit_counts[d]++;

    const side_stats = sides.map<TSideStats>(side => {
        let hits = 0;
        for (let d = 0; d < 10; d++) if (side.wins(d)) hits += digit_counts[d];
        const z = zScore(hits, digits.length, side.expected);
        const loses = (d: number) => !side.wins(d);
        return {
            side,
            hits,
            rate: digits.length ? hits / digits.length : 0,
            z,
            significance: classifyZ(z),
            win_streak: trailingRun(digits, side.wins),
            loss_streak: trailingRun(digits, loses),
            longest_loss_streak: longestRun(digits, loses),
        };
    });

    const leader = side_stats.reduce<TSideStats | null>(
        (best, s) => (!best || Math.abs(s.z) > Math.abs(best.z) ? s : best),
        null
    );

    return { sample_size: digits.length, digit_counts, sides: side_stats, leader };
};

/**
 * Replays "after `trigger` losses in a row for this side, buy it on the next tick"
 * over the given digits. `payout` is the total return per 1 unit staked (e.g. 1.95).
 */
export const backtestStreakRule = (digits: number[], side: TSide, trigger: number, payout: number): TRuleResult => {
    let trades = 0;
    let wins = 0;
    let run = 0;
    for (let i = 0; i < digits.length; i++) {
        const won = side.wins(digits[i]);
        if (run >= trigger) {
            trades++;
            if (won) wins++;
        }
        run = won ? 0 : run + 1;
    }
    const net = wins * payout - trades;
    return { trades, wins, win_rate: trades ? wins / trades : 0, net };
};

/** Expected return per 1 unit staked when the true win probability is `expected`. */
export const expectedReturn = (payout: number, expected: number): number => expected * payout - 1;

export const breakEvenRate = (payout: number): number => (payout > 0 ? 1 / payout : 1);
