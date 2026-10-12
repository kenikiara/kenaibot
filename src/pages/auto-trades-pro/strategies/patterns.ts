import { TMarket } from '@/pages/scanner/scanner-feed';
import { TOrder, TStrategy } from '../engine/types';
import {
    ALL_SYNTHETIC,
    digitLeg,
    lastDigit,
    marketName,
    ONE_SECOND_5,
    overUnderLeg,
    pct,
    priceMoves,
    rangeOptions,
    STRATEGY_OPTIONS,
    TRACKING_OPTIONS,
    trailingRun,
    TSide,
    VOLATILITY_10,
} from './helpers';

type TRunSignal = { order: TOrder; key: string };

/**
 * Shared engine for the "RC" strategies: watch the run of the same outcome at
 * the end of each market, trade once when it reaches the set length, and
 * optionally re-trade straight away after a loss.
 */
const createRunTracker = <K extends string>(options: {
    symbols: string[];
    /** Run kinds at the end of this market, or null to skip this tick. */
    series: (market: TMarket) => K[] | null;
    /** Required run length for this kind, or null when the kind is not tracked. */
    required: (kind: K) => number | null;
    build: (market: TMarket, kind: K, count: number) => TOrder;
    recovery: (kind: K) => { enabled: boolean; count: number };
}) => {
    const traded = new Map<string, number>();
    const previous_run = new Map<string, number>();
    let retry: { signal: TRunSignal; kind: K } | null = null;
    let retries = 0;
    let last: { signal: TRunSignal; kind: K } | null = null;
    let watching = '';

    return {
        onTick: (market: TMarket, can_trade: boolean): TOrder | null => {
            if (retry && can_trade) {
                const order = retry.signal.order;
                retry = null;
                return { ...order, reason: `Immediate recovery ${retries}` };
            }
            const series = options.series(market);
            if (!series) return null;
            const run = trailingRun(series);
            if (!run.kind) return null;
            const before = previous_run.get(market.symbol) ?? 0;
            if (before > 1 && run.count === 1) {
                [...traded.keys()].filter(key => key.startsWith(`${market.symbol}-`)).forEach(key => traded.delete(key));
            }
            previous_run.set(market.symbol, run.count);
            const required = options.required(run.kind);
            if (required !== null && run.count >= required - 1) {
                watching = `${marketName(market.symbol)}: ${run.count}/${required} ${run.kind.toLowerCase()}`;
            }
            if (!can_trade || required === null || run.count !== required) return null;
            const key = `${market.symbol}-${run.kind}`;
            if ((traded.get(key) ?? 0) >= run.count) return null;
            traded.set(key, run.count);
            const order = options.build(market, run.kind, run.count);
            last = { signal: { order, key }, kind: run.kind };
            retries = 0;
            return order;
        },
        onSettled: (is_win: boolean, filled: boolean) => {
            if (!filled || is_win || !last) {
                retries = 0;
                retry = null;
                return;
            }
            const { enabled, count } = options.recovery(last.kind);
            if (enabled && retries < count) {
                retries += 1;
                retry = last;
            } else {
                retries = 0;
                retry = null;
            }
        },
        status: () => [watching || 'Watching for runs…', retry ? `Immediate recovery ${retries} queued` : ''].filter(Boolean),
    };
};

const runFields = (count_label: string) => [
    { key: 'tracking', label: 'Market tracking', type: 'select' as const, options: TRACKING_OPTIONS },
    { key: 'strategy', label: 'Trading strategy', type: 'select' as const, options: STRATEGY_OPTIONS },
    { key: 'consecutive', label: count_label, type: 'select' as const, options: rangeOptions(1, 10) },
    { key: 'duration', label: 'Duration (ticks)', type: 'select' as const, options: rangeOptions(1, 10) },
    { key: 'immediate_recovery', label: 'Immediate recovery', type: 'toggle' as const },
    {
        key: 'recovery_count',
        label: 'Recovery attempts',
        type: 'select' as const,
        options: rangeOptions(1, 10),
        visible: (s: Record<string, any>) => s.immediate_recovery,
    },
];

export const rcEvenOdd: TStrategy = {
    id: 'rc-even-odd',
    label: 'RC Even/Odd',
    group: 'Digits',
    uses_market: true,
    summary:
        'Trades once when a market prints the set number of even (or odd) digits in a row — continuing with the same parity or reversing. Optional immediate re-trade after a loss.',
    fields: runFields('Consecutive digits'),
    defaults: { tracking: 'all', strategy: 'CONTINUING', consecutive: 3, duration: 1, immediate_recovery: false, recovery_count: 2 },
    create: (s, money) => {
        const symbols = s.tracking === 'all' ? ALL_SYNTHETIC : [money.symbol];
        const tracker = createRunTracker<'EVEN' | 'ODD'>({
            symbols,
            series: market => market.digits.slice(-50).map(d => (d % 2 === 0 ? 'EVEN' : 'ODD')),
            required: () => Number(s.consecutive),
            build: (market, kind, count) => {
                const trade = s.strategy === 'CONTINUING' ? kind : kind === 'EVEN' ? 'ODD' : 'EVEN';
                return {
                    legs: [digitLeg(market.symbol, trade === 'EVEN' ? 'DIGITEVEN' : 'DIGITODD', Number(s.duration))],
                    reason: `${marketName(market.symbol)}: ${count} ${kind.toLowerCase()} in a row`,
                };
            },
            recovery: () => ({ enabled: s.immediate_recovery, count: Number(s.recovery_count) }),
        });
        return {
            symbols,
            onTick: ctx => tracker.onTick(ctx.market, ctx.can_trade),
            onSettled: outcome => tracker.onSettled(outcome.is_win, outcome.filled),
            status: tracker.status,
        };
    },
};

const highLow = (digit: number) => (digit <= 4 ? 'UNDER5' : 'OVER4');

export const rcOver4Under5: TStrategy = {
    id: 'rc-over4-under5',
    label: 'RC Over4/Under5',
    group: 'Digits',
    uses_market: true,
    summary:
        'Watches runs of high digits (5-9) and low digits (0-4). When a run reaches its set length it buys Over 4 or Under 5 — continuing or reversing — with optional immediate recovery per side.',
    fields: [
        { key: 'tracking', label: 'Market tracking', type: 'select', options: TRACKING_OPTIONS },
        { key: 'strategy', label: 'Trading strategy', type: 'select', options: STRATEGY_OPTIONS },
        { key: 'track', label: 'Track', type: 'select', options: [
            { value: 'both', label: 'Both' },
            { value: 'over4', label: 'Over 4 runs only' },
            { value: 'under5', label: 'Under 5 runs only' },
        ] },
        {
            key: 'over4_count',
            label: 'Over 4 count',
            type: 'select',
            options: rangeOptions(1, 10),
            visible: s => s.track !== 'under5',
        },
        {
            key: 'under5_count',
            label: 'Under 5 count',
            type: 'select',
            options: rangeOptions(1, 10),
            visible: s => s.track !== 'over4',
        },
        { key: 'duration', label: 'Duration (ticks)', type: 'select', options: rangeOptions(1, 10) },
        { key: 'over4_recovery', label: 'Over 4 recovery', type: 'toggle', visible: s => s.track !== 'under5' },
        {
            key: 'over4_recover_count',
            label: 'Over 4 recovery attempts',
            type: 'select',
            options: rangeOptions(1, 10),
            visible: s => s.track !== 'under5' && s.over4_recovery,
        },
        { key: 'under5_recovery', label: 'Under 5 recovery', type: 'toggle', visible: s => s.track !== 'over4' },
        {
            key: 'under5_recover_count',
            label: 'Under 5 recovery attempts',
            type: 'select',
            options: rangeOptions(1, 10),
            visible: s => s.track !== 'over4' && s.under5_recovery,
        },
    ],
    defaults: {
        tracking: 'all',
        strategy: 'CONTINUING',
        track: 'both',
        over4_count: 3,
        under5_count: 3,
        duration: 1,
        over4_recovery: false,
        over4_recover_count: 2,
        under5_recovery: false,
        under5_recover_count: 2,
    },
    create: (s, money) => {
        const symbols = s.tracking === 'all' ? ALL_SYNTHETIC : [money.symbol];
        const tracker = createRunTracker<'OVER4' | 'UNDER5'>({
            symbols,
            series: market => market.digits.slice(-50).map(highLow),
            required: kind => {
                if (kind === 'OVER4') return s.track === 'under5' ? null : Number(s.over4_count);
                return s.track === 'over4' ? null : Number(s.under5_count);
            },
            build: (market, kind, count) => {
                const trade = s.strategy === 'CONTINUING' ? kind : kind === 'OVER4' ? 'UNDER5' : 'OVER4';
                const leg =
                    trade === 'OVER4'
                        ? overUnderLeg(market.symbol, 'over', 4, Number(s.duration))
                        : overUnderLeg(market.symbol, 'under', 5, Number(s.duration));
                return {
                    legs: [leg],
                    reason: `${marketName(market.symbol)}: ${count} ${kind === 'OVER4' ? 'high' : 'low'} digits in a row`,
                };
            },
            recovery: kind =>
                kind === 'OVER4'
                    ? { enabled: s.over4_recovery, count: Number(s.over4_recover_count) }
                    : { enabled: s.under5_recovery, count: Number(s.under5_recover_count) },
        });
        return {
            symbols,
            onTick: ctx => tracker.onTick(ctx.market, ctx.can_trade),
            onSettled: outcome => tracker.onSettled(outcome.is_win, outcome.filled),
            status: tracker.status,
        };
    },
};

export const rcRiseFall: TStrategy = {
    id: 'rc-rise-fall',
    label: 'RC Rise/Fall',
    group: 'Ups/Downs',
    uses_market: true,
    summary:
        'Trades once when a market moves up (or down) the set number of ticks in a row — continuing or reversing — with optional immediate recovery.',
    fields: runFields('Consecutive rise/fall'),
    defaults: { tracking: 'all', strategy: 'CONTINUING', consecutive: 3, duration: 1, immediate_recovery: false, recovery_count: 2 },
    create: (s, money) => {
        const symbols = s.tracking === 'all' ? ALL_SYNTHETIC : [money.symbol];
        const tracker = createRunTracker<'RISE' | 'FALL'>({
            symbols,
            series: market => {
                const quotes = market.quotes;
                const n = quotes.length;
                // Unchanged ticks neither extend nor break a run
                if (n < 2 || quotes[n - 1] === quotes[n - 2]) return null;
                return priceMoves(quotes.slice(-51)).map(move => (move > 0 ? 'RISE' : 'FALL'));
            },
            required: () => Number(s.consecutive),
            build: (market, kind, count) => {
                const trade = s.strategy === 'CONTINUING' ? kind : kind === 'RISE' ? 'FALL' : 'RISE';
                return {
                    legs: [digitLeg(market.symbol, trade === 'RISE' ? 'CALL' : 'PUT', Number(s.duration))],
                    reason: `${marketName(market.symbol)}: ${count} ${kind === 'RISE' ? 'rises' : 'falls'} in a row`,
                };
            },
            recovery: () => ({ enabled: s.immediate_recovery, count: Number(s.recovery_count) }),
        });
        return {
            symbols,
            onTick: ctx => tracker.onTick(ctx.market, ctx.can_trade),
            onSettled: outcome => tracker.onSettled(outcome.is_win, outcome.filled),
            status: tracker.status,
        };
    },
};

export const percentageEvenOdd: TStrategy = {
    id: 'percentage-even-odd',
    label: '%Even/Odd',
    group: 'Digits',
    summary:
        'Monitors every volatility market and trades Even (or Odd) on the first market where that side reaches the threshold share of the last N ticks.',
    fields: [
        { key: 'window', label: 'Ticks to monitor', type: 'number', min: 1, max: 1000, step: 1 },
        { key: 'threshold', label: 'Percentage threshold (%)', type: 'number', min: 0, max: 100, step: 1 },
    ],
    defaults: { window: 10, threshold: 50 },
    create: s => {
        let latest = '';
        return {
            symbols: VOLATILITY_10,
            onTick: ctx => {
                const window = Number(s.window);
                const digits = ctx.market.digits;
                if (digits.length < window) return null;
                const recent = digits.slice(-window);
                const even = (recent.filter(d => d % 2 === 0).length / recent.length) * 100;
                const odd = 100 - even;
                latest = `${marketName(ctx.market.symbol)}: even ${pct(even)} / odd ${pct(odd)}`;
                if (!ctx.can_trade) return null;
                const side = even >= Number(s.threshold) ? 'EVEN' : odd >= Number(s.threshold) ? 'ODD' : null;
                if (!side) return null;
                return {
                    legs: [digitLeg(ctx.market.symbol, side === 'EVEN' ? 'DIGITEVEN' : 'DIGITODD')],
                    reason: `${marketName(ctx.market.symbol)}: ${side.toLowerCase()} ${pct(side === 'EVEN' ? even : odd)} of last ${window}`,
                };
            },
            status: () => [latest || 'Collecting ticks…'],
        };
    },
};

type TStep = { digit: number; direction: TSide };

const RISK_STEPS: Record<string, TStep[]> = {
    low: [
        { digit: 8, direction: 'under' },
        { digit: 7, direction: 'under' },
        { digit: 1, direction: 'over' },
        { digit: 2, direction: 'over' },
    ],
    medium: [
        { digit: 6, direction: 'under' },
        { digit: 5, direction: 'under' },
        { digit: 4, direction: 'under' },
        { digit: 3, direction: 'over' },
        { digit: 4, direction: 'over' },
        { digit: 5, direction: 'over' },
    ],
    high: [
        { digit: 3, direction: 'under' },
        { digit: 2, direction: 'under' },
        { digit: 6, direction: 'over' },
        { digit: 7, direction: 'over' },
    ],
    mix: [
        ...[8, 7, 6, 5, 4, 3, 2, 1].map(digit => ({ digit, direction: 'under' as const })),
        ...[1, 2, 3, 4, 5, 6, 7, 8].map(digit => ({ digit, direction: 'over' as const })),
    ],
};

/** Minimum win share (%) required per barrier digit before a step is taken. */
const OVER_THRESHOLDS = [90, 80, 70, 65, 60, 55, 40, 30, 20, 1];
const UNDER_THRESHOLDS = [1, 20, 30, 35, 40, 50, 60, 70, 80, 90];

export const percentageOverUnder: TStrategy = {
    id: 'percentage-over-under',
    label: '%Over/Under',
    group: 'Digits',
    uses_market: true,
    summary:
        "Each risk set is a list of Over/Under bets with their own threshold. Every tick it takes the bet whose win share over the window beats its threshold by the most, skipping any bet that just lost 3 times in a row.",
    fields: [
        {
            key: 'risk_sets',
            label: 'Risk sets',
            type: 'multi',
            options: [
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
                { value: 'mix', label: 'Mix' },
            ],
        },
        {
            key: 'window',
            label: 'Window (ticks)',
            type: 'select',
            options: [50, 100, 150, 250, 500, 1000].map(value => ({ value, label: `${value} ticks` })),
        },
        { key: 'duration', label: 'Duration (ticks)', type: 'select', options: rangeOptions(1, 10) },
    ],
    defaults: { risk_sets: ['medium'], window: 100, duration: 1 },
    create: (s, money) => {
        const sets: string[] = s.risk_sets?.length ? s.risk_sets : ['medium'];
        const steps: TStep[] = [];
        const seen = new Set<string>();
        sets.forEach(set =>
            (RISK_STEPS[set] ?? []).forEach(step => {
                const key = `${step.direction}_${step.digit}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    steps.push(step);
                }
            })
        );
        const losses: Record<string, number> = {};
        let last_step: TStep | null = null;
        let best_text = '';

        return {
            symbols: [money.symbol],
            onTick: ctx => {
                const window = ctx.market.digits.slice(-Number(s.window));
                if (!window.length) return null;
                let best: { step: TStep; share: number; threshold: number; margin: number } | null = null;
                for (const step of steps) {
                    const key = `${step.direction}_${step.digit}`;
                    const wins = window.filter(d => (step.direction === 'over' ? d > step.digit : d < step.digit)).length;
                    const share = (wins / window.length) * 100;
                    const threshold = step.direction === 'over' ? OVER_THRESHOLDS[step.digit] : UNDER_THRESHOLDS[step.digit];
                    const margin = share - threshold;
                    if (margin < 0) {
                        losses[key] = 0;
                        continue;
                    }
                    if ((losses[key] ?? 0) >= 3) continue;
                    if (!best || margin > best.margin) best = { step, share, threshold, margin };
                }
                best_text = best
                    ? `Best: ${best.step.direction === 'over' ? 'Over' : 'Under'} ${best.step.digit} at ${pct(best.share)} (needs ${best.threshold}%)`
                    : 'No bet above its threshold';
                if (!best || !ctx.can_trade) return null;
                last_step = best.step;
                return {
                    legs: [overUnderLeg(ctx.market.symbol, best.step.direction, best.step.digit, Number(s.duration))],
                    reason: `${pct(best.share)} vs ${best.threshold}% threshold`,
                };
            },
            onSettled: outcome => {
                if (!outcome.filled || !last_step) return;
                const key = `${last_step.direction}_${last_step.digit}`;
                losses[key] = outcome.is_win ? 0 : (losses[key] ?? 0) + 1;
            },
            status: () => [best_text || 'Collecting ticks…'],
        };
    },
};

export const over4: TStrategy = {
    id: 'over4',
    label: 'Over4',
    group: 'Digits',
    summary:
        'On the five 1-second volatility markets: after 4 or more digits of 4 or below in a row, the next digit above 4 triggers one Over 4 trade on that market.',
    fields: [],
    defaults: {},
    create: () => {
        const lows = new Map<string, number>();
        let watching = '';
        return {
            symbols: ONE_SECOND_5,
            onTick: ctx => {
                const symbol = ctx.market.symbol;
                const digit = lastDigit(ctx.market);
                if (digit <= 4) {
                    lows.set(symbol, (lows.get(symbol) ?? 0) + 1);
                    if ((lows.get(symbol) ?? 0) >= 3) watching = `${marketName(symbol)}: ${lows.get(symbol)} low digits`;
                    return null;
                }
                const run = lows.get(symbol) ?? 0;
                lows.set(symbol, 0);
                if (run < 4 || !ctx.can_trade) return null;
                return {
                    legs: [overUnderLeg(symbol, 'over', 4)],
                    reason: `${marketName(symbol)}: ${run} digits ≤4, then ${digit}`,
                };
            },
            status: () => [watching || 'Waiting for 4+ low digits in a row…'],
        };
    },
};

export const onlyUpsDowns: TStrategy = {
    id: 'only-ups-downs',
    label: 'OnlyUps/OnlyDowns',
    group: 'Ups/Downs',
    summary:
        'When 60%+ of a market’s last 100 price moves were up it buys a 2-tick Only Ups; at 40% or less it buys Only Downs.',
    fields: [],
    defaults: {},
    create: () => {
        let latest = '';
        return {
            symbols: VOLATILITY_10,
            onTick: ctx => {
                const moves = priceMoves(ctx.market.quotes.slice(-101));
                if (moves.length < 40) return null;
                const up_share = moves.filter(m => m > 0).length / moves.length;
                latest = `${marketName(ctx.market.symbol)}: ${pct(up_share * 100)} up-moves`;
                if (!ctx.can_trade) return null;
                const kind = up_share >= 0.6 ? 'RUNHIGH' : up_share <= 0.4 ? 'RUNLOW' : null;
                if (!kind) return null;
                return {
                    legs: [digitLeg(ctx.market.symbol, kind, 2)],
                    reason: `${marketName(ctx.market.symbol)}: ${pct(up_share * 100)} up-moves over the last ${moves.length}`,
                };
            },
            status: () => [latest || 'Collecting price moves…'],
        };
    },
};
