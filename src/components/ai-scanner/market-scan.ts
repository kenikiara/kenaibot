import { TMarket } from '@/pages/scanner/scanner-feed';

/**
 * The AI scanner's market rules. Each rule reads the last-digit frequencies
 * (or price moves) of recent ticks and, when a market clears its bar, names a
 * ready-made bot and the settings to load it with.
 *
 * These are frequency filters, not predictions: synthetic index ticks are
 * independent, so a market "clearing the bar" says what happened, not what
 * the next tick will do. `confidence` is the share of recent ticks that would
 * have won, shown as a percentage.
 */

export type TScanType = 'overunder' | 'evenodd' | 'matchesdiffers' | 'risefall';

export type TScanPlan =
    | { bot: 'magical'; is_over: boolean; over_barrier: number; under_barrier: number }
    | { bot: 'under8strategy'; primary_barrier: number; recovery_barrier: number }
    | { bot: 'over1ai'; primary_barrier: number; recovery_barrier: number }
    | { bot: 'underside'; primary_barrier: number; recovery_barrier: number }
    | { bot: 'oversingle'; barrier: number }
    | { bot: 'undersingle'; barrier: number }
    | { bot: 'evenodd'; side: 'DIGITEVEN' | 'DIGITODD' }
    | { bot: 'matches'; side: 'DIGITMATCH'; digit: number }
    | { bot: 'differs'; digit: number; trade_count: number }
    | { bot: 'risefall'; side: 'CALL' | 'PUT'; duration: number };

/** The contract a signal's bot opens first, used to price it. */
export type TScanContract = { contract_type: string; barrier?: number };

export type TScanSignal = {
    trade_type: TScanType;
    symbol: string;
    market_name: string;
    direction: string;
    confidence: number;
    note: string;
    plan: TScanPlan;
    contract: TScanContract;
    /** Over/Under: the rule that produced the signal, re-checked while the bot runs. */
    rule?: TOverUnderRule;
    /** Over/Under: enter once one of these (losing) digits prints. */
    entry_after?: number[];
    /** Matches: wait for this digit to print before entering. */
    entry_digit?: number;
    /** Single-side Over/Under: enter after 5 ticks against the trade. */
    streak_entry?: boolean;
    /** Rise/Fall only: share of moves in the signal direction, and its z-score. */
    agree?: number;
    z_score?: number;
};

export const SCAN_TYPES: { value: TScanType; label: string }[] = [
    { value: 'matchesdiffers', label: 'Matches / Differs' },
    { value: 'evenodd', label: 'Even / Odd' },
    { value: 'overunder', label: 'Over / Under' },
    { value: 'risefall', label: 'Rise / Fall' },
];

/** The markets the scanner checks, in order. Single-market scans use the first unless told otherwise. */
export const SCAN_MARKETS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'];

/** Ready-made bot loaded for each plan (files in public/xml/ai-scanner). */
export const PLAN_BOT_FILES: Record<TScanPlan['bot'], string> = {
    magical: 'Over Under Magical Bot.xml',
    over1ai: 'Over_1_AI.xml',
    underside: 'Same Side Over Under.xml',
    under8strategy: 'Under 8 Strategy.xml',
    matches: 'Matches Bot.xml',
    differs: 'Differs Bot.xml',
    evenodd: 'Even ODD Bot.xml',
    risefall: 'Rise and Fall  Simple.xml',
    oversingle: 'Over Single Side.xml',
    undersingle: 'Under Single Side.xml',
};

const MIN_TICKS = 400;
const EVEN = [0, 2, 4, 6, 8];
const ODD = [1, 3, 5, 7, 9];

type TSample = { symbol: string; name: string; freq: number[]; digits: number[]; prices: number[] };

const toSample = (market: TMarket): TSample | null => {
    if (market.digits.length < MIN_TICKS) return null;
    const freq = Array(10).fill(0);
    market.digits.forEach(digit => freq[digit]++);
    return {
        symbol: market.symbol,
        name: market.name,
        freq: freq.map(count => count / market.digits.length),
        digits: market.digits,
        prices: market.quotes,
    };
};

const sumFreq = (freq: number[], digits: number[]) => digits.reduce((total, d) => total + (freq[d] || 0), 0);

const winningDigits = (side: 'over' | 'under', barrier: number) =>
    side === 'over' ? Array.from({ length: 9 - barrier }, (_, i) => barrier + 1 + i) : Array.from({ length: barrier }, (_, i) => i);

export type TOverUnderRule = {
    side: 'over' | 'under';
    barrier: number;
    /** Every listed digit must be under 10%. */
    cold?: number[];
    /** At least two listed digits must be above 11%. */
    hot?: number[];
    recovery?: number;
    streak_entry?: boolean;
};

const OVER_UNDER_RULES: TOverUnderRule[] = [
    { side: 'over', barrier: 2, cold: [0, 1, 2, 3], recovery: 3 },
    { side: 'over', barrier: 3, cold: [0, 1, 2, 3, 4] },
    { side: 'under', barrier: 8, cold: [6, 7, 8, 9], recovery: 6 },
    { side: 'under', barrier: 7, cold: [7, 8, 9] },
    { side: 'under', barrier: 6, cold: [6, 7, 8, 9] },
    { side: 'under', barrier: 3, hot: [0, 1, 2], streak_entry: true },
    { side: 'over', barrier: 6, hot: [7, 8, 9], streak_entry: true },
];

const sideLabel = (side: 'over' | 'under') => (side === 'over' ? 'Over' : 'Under');

const overUnderPlan = (rule: TOverUnderRule, symbol: string): { plan: TScanPlan; direction: string } => {
    const is_one_second = symbol.startsWith('1HZ');
    if (!is_one_second && rule.side === 'over' && rule.barrier === 2) {
        return {
            plan: { bot: 'magical', is_over: true, over_barrier: 2, under_barrier: 7 },
            direction: 'Over 2 → recovery Under 7',
        };
    }
    if (!is_one_second && rule.side === 'under' && rule.barrier === 8) {
        return {
            plan: { bot: 'under8strategy', primary_barrier: 8, recovery_barrier: 3 },
            direction: 'Under 8 → recovery Over 3',
        };
    }
    if (rule.recovery === undefined) {
        return {
            plan: rule.side === 'over' ? { bot: 'oversingle', barrier: rule.barrier } : { bot: 'undersingle', barrier: rule.barrier },
            direction: `${sideLabel(rule.side)} ${rule.barrier}`,
        };
    }
    const recovery = { primary_barrier: rule.barrier, recovery_barrier: rule.recovery };
    return {
        plan: rule.side === 'over' ? { bot: 'over1ai', ...recovery } : { bot: 'underside', ...recovery },
        direction: `${sideLabel(rule.side)} ${rule.barrier} → recovery ${sideLabel(rule.side)} ${rule.recovery}`,
    };
};

const rulePasses = (rule: TOverUnderRule, freq: number[]) =>
    rule.cold ? rule.cold.every(d => freq[d] < 0.1) : (rule.hot ?? []).filter(d => freq[d] > 0.11).length >= 2;

/** Digits that lose the rule's trade. */
const losingDigits = (rule: TOverUnderRule) =>
    [...Array(10).keys()].filter(d => (rule.side === 'over' ? d <= rule.barrier : d >= rule.barrier));

const scanOverUnder = (sample: TSample): TScanSignal | null => {
    let best: TScanSignal | null = null;
    for (const rule of OVER_UNDER_RULES) {
        if (!rulePasses(rule, sample.freq)) continue;

        const confidence = Math.min(99, 100 * sumFreq(sample.freq, winningDigits(rule.side, rule.barrier)));
        if (best && confidence <= best.confidence) continue;

        const { plan, direction } = overUnderPlan(rule, sample.symbol);
        best = {
            trade_type: 'overunder',
            symbol: sample.symbol,
            market_name: sample.name,
            direction,
            confidence,
            note: rule.cold
                ? `${sideLabel(rule.side)} ${rule.barrier}: digits ${rule.cold.join(',')} all under 10% over ${sample.digits.length} ticks`
                : `${sideLabel(rule.side)} ${rule.barrier}: 2+ of digits ${(rule.hot ?? []).join(',')} above 11% — enters after 5 ticks against the trade`,
            plan,
            contract: { contract_type: rule.side === 'over' ? 'DIGITOVER' : 'DIGITUNDER', barrier: rule.barrier },
            rule,
            entry_after: rule.cold ? losingDigits(rule) : undefined,
            streak_entry: rule.streak_entry,
        };
    }
    return best;
};

const scanEvenOdd = (sample: TSample): TScanSignal | null => {
    const even_hot = EVEN.filter(d => sample.freq[d] > 0.1).length;
    const odd_hot = ODD.filter(d => sample.freq[d] > 0.1).length;
    if (even_hot === odd_hot) return null;
    const is_even = even_hot > odd_hot;
    return {
        trade_type: 'evenodd',
        symbol: sample.symbol,
        market_name: sample.name,
        direction: is_even ? 'Even' : 'Odd',
        confidence: Math.min(99, 100 * sumFreq(sample.freq, is_even ? EVEN : ODD)),
        note: `${is_even ? 'Even' : 'Odd'} side leads: ${is_even ? even_hot : odd_hot} digits above 10%`,
        plan: { bot: 'evenodd', side: is_even ? 'DIGITEVEN' : 'DIGITODD' },
        contract: { contract_type: is_even ? 'DIGITEVEN' : 'DIGITODD' },
    };
};

const pct = (n: number) => (100 * n).toFixed(1);

const scanMatchesDiffers = (sample: TSample, differs_trades: number): TScanSignal | null => {
    const ranked = [...Array(10).keys()].sort((a, b) => sample.freq[b] - sample.freq[a]);
    const [top, second] = ranked;
    const rarest = ranked[9];

    const differs: TScanSignal = {
        trade_type: 'matchesdiffers',
        symbol: sample.symbol,
        market_name: sample.name,
        direction: `Differs ${rarest}`,
        confidence: Math.min(99, 100 * (1 - sample.freq[rarest])),
        note: `Digit ${rarest} is rarest at ${pct(sample.freq[rarest])}%`,
        plan: { bot: 'differs', digit: rarest, trade_count: differs_trades },
        contract: { contract_type: 'DIGITDIFF', barrier: rarest },
    };
    if (!(sample.freq[top] > 0.11 && sample.freq[second] > 0.11)) return differs;

    const matches: TScanSignal = {
        trade_type: 'matchesdiffers',
        symbol: sample.symbol,
        market_name: sample.name,
        direction: `Matches ${top}`,
        confidence: Math.min(99, 100 * sample.freq[top] * 4),
        note: `Digit ${top} (${pct(sample.freq[top])}%) appears most — enters when ${second} (${pct(sample.freq[second])}%) shows`,
        entry_digit: second,
        plan: { bot: 'matches', side: 'DIGITMATCH', digit: top },
        contract: { contract_type: 'DIGITMATCH', barrier: top },
    };
    return matches.confidence > differs.confidence ? matches : differs;
};

const scanRiseFall = (sample: TSample): TScanSignal | null => {
    const span = Math.min(500, sample.prices.length - 1);
    if (span < 100) return null;
    const prices = sample.prices.slice(-(span + 1));
    let ups = 0;
    let downs = 0;
    for (let i = 1; i < prices.length; i++) {
        if (prices[i] > prices[i - 1]) ups++;
        else if (prices[i] < prices[i - 1]) downs++;
    }
    const moves = ups + downs;
    if (moves < 100) return null;
    const up_share = ups / moves;
    const z_score = Math.abs(ups - moves / 2) / Math.sqrt(moves / 4);
    if (z_score < 2) return null;
    const is_up = up_share > 0.5;
    const change = prices[prices.length - 1] - prices[0];
    if (change !== 0 && change > 0 !== is_up) return null;

    const agree = (is_up ? up_share : 1 - up_share) * 100;
    return {
        trade_type: 'risefall',
        symbol: sample.symbol,
        market_name: sample.name,
        direction: is_up ? 'Rise' : 'Fall',
        confidence: Math.min(95, 55 + (z_score - 2) * 8),
        agree: Math.round(agree),
        z_score: Math.round(z_score * 100) / 100,
        note: `Overall ${is_up ? 'up' : 'down'}trend over ${moves} ticks (${agree.toFixed(1)}% ${is_up ? 'up' : 'down'}). Enters ${is_up ? 'Rise' : 'Fall'} once ticks move that way.`,
        plan: { bot: 'risefall', side: is_up ? 'CALL' : 'PUT', duration: 1 },
        contract: { contract_type: is_up ? 'CALL' : 'PUT' },
    };
};

/**
 * Scores every market with enough history and returns the signals best-first.
 * `scanned` counts markets that had enough ticks to be analysed.
 */
export const scanMarkets = (
    markets: TMarket[],
    type: TScanType,
    options: { differs_trades?: number } = {}
): { signals: TScanSignal[]; scanned: number } => {
    const samples = markets.map(toSample).filter((sample): sample is TSample => sample !== null);
    const signals = samples
        .map(sample => {
            if (type === 'overunder') return scanOverUnder(sample);
            if (type === 'evenodd') return scanEvenOdd(sample);
            if (type === 'matchesdiffers') return scanMatchesDiffers(sample, options.differs_trades ?? 5);
            return scanRiseFall(sample);
        })
        .filter((signal): signal is TScanSignal => signal !== null)
        .sort((a, b) => b.confidence - a.confidence);
    return { signals, scanned: samples.length };
};

/**
 * Whether the market still meets the condition behind `signal`. Over/Under
 * re-checks the signal's own rule; Even/Odd and Rise/Fall must still lead the
 * same way. Matches/Differs bots run a fixed batch, so they are not re-checked.
 */
export const signalHolds = (signal: TScanSignal, market: TMarket): boolean => {
    const sample = toSample(market);
    if (!sample) return true;
    if (signal.trade_type === 'overunder') return signal.rule ? rulePasses(signal.rule, sample.freq) : true;
    if (signal.trade_type === 'evenodd') return scanEvenOdd(sample)?.direction === signal.direction;
    if (signal.trade_type === 'risefall') return scanRiseFall(sample)?.direction === signal.direction;
    return true;
};

/**
 * What a martingale does after one loss, given the payout per 1 staked.
 * `recovered` is the share of the lost stake a winning next trade wins back;
 * `break_even` is the multiplier that wins back exactly the loss.
 */
export const martingaleRecovery = (payout: number, multiplier: number) => {
    const profit = payout - 1;
    if (!(profit > 0)) return null;
    return { profit, recovered: multiplier * profit, break_even: 1 / profit };
};
