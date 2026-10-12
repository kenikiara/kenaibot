import { TStrategy } from '../engine/types';
import { DIGIT_OPTIONS, lastDigit, overUnderLeg, pct, rangeOptions, TSide } from './helpers';

/**
 * Osman (OSAM Trading Over/Under poster). Reads last-digit percentages over a
 * window, like the analysis tool's digit bars: the "green bar" is the most
 * frequent digit, the "red bar" the least frequent.
 *
 * Over: 0 and 1 below 10.5% and neither is a red/green bar; enter when the
 * last digit is 5 or 6, which must not be red/green either.
 * Under: 8 and 9 below 10.5%, neither red/green; enter on 4, 7 or 9, none of
 * them red/green. Stops after the set number of runs (3 on the poster).
 */

const LIMIT = 10.5;

type TSetup = { side: TSide; weak: number[]; entry: number[] };

const SETUPS: TSetup[] = [
    { side: 'over', weak: [0, 1], entry: [5, 6] },
    { side: 'under', weak: [8, 9], entry: [4, 7, 9] },
];

/** Percentage of each digit, plus the digits holding the green (highest) and red (lowest) bars. */
export const digitBars = (digits: number[]) => {
    const counts = Array(10).fill(0);
    digits.forEach(d => counts[d]++);
    const percents = counts.map(c => (100 * c) / (digits.length || 1));
    const high = Math.max(...counts);
    const low = Math.min(...counts);
    const green = counts.flatMap((c, d) => (c === high ? [d] : []));
    const red = counts.flatMap((c, d) => (c === low ? [d] : []));
    return { percents, green, red };
};

/** Why a setup is not ready, or null when its conditions hold. */
export const setupBlocker = (setup: TSetup, bars: ReturnType<typeof digitBars>): string | null => {
    const { percents, green, red } = bars;
    const high = setup.weak.find(d => percents[d] >= LIMIT);
    if (high !== undefined) return `${high} at ${pct(percents[high])} (needs < ${LIMIT}%)`;
    const barred = [...setup.weak, ...setup.entry].find(d => green.includes(d) || red.includes(d));
    if (barred !== undefined) return `${barred} has the ${green.includes(barred) ? 'green' : 'red'} bar`;
    return null;
};

export const osman: TStrategy = {
    id: 'osman',
    label: 'Osman',
    group: 'Digits',
    uses_market: true,
    summary:
        'OSAM Over/Under rules. Over: digits 0 and 1 under 10.5% and not the red or green bar; enters when the last digit is 5 or 6 (not red/green). Under: 8 and 9 under 10.5% and not red/green; enters on 4, 7 or 9 (not red/green). Stops after the set number of runs.',
    fields: [
        {
            key: 'side',
            label: 'Trade',
            type: 'select',
            options: [
                { value: 'both', label: 'Over and Under' },
                { value: 'over', label: 'Over only' },
                { value: 'under', label: 'Under only' },
            ],
        },
        {
            key: 'over_barrier',
            label: 'Over prediction',
            type: 'select',
            options: DIGIT_OPTIONS.slice(0, 9),
            visible: s => s.side !== 'under',
            help: 'Over 1 loses only on 0 and 1, the digits the rule checks.',
        },
        {
            key: 'under_barrier',
            label: 'Under prediction',
            type: 'select',
            options: DIGIT_OPTIONS.slice(1),
            visible: s => s.side !== 'over',
            help: 'Under 8 loses only on 8 and 9, the digits the rule checks.',
        },
        {
            key: 'window',
            label: 'Analysis window',
            type: 'select',
            options: [100, 250, 500, 1000].map(value => ({ value, label: `${value} ticks` })),
        },
        { key: 'runs', label: 'Runs before stopping', type: 'select', options: rangeOptions(1, 20) },
    ],
    defaults: { side: 'both', over_barrier: 1, under_barrier: 8, window: 1000, runs: 3 },
    create: (s, money) => {
        const window = Number(s.window);
        const runs = Number(s.runs);
        const setups = SETUPS.filter(setup => s.side === 'both' || s.side === setup.side);
        let done = 0;
        let notes: string[] = [];

        return {
            symbols: [money.symbol],
            onTick: ctx => {
                const digits = ctx.market.digits.slice(-window);
                if (digits.length < window) {
                    notes = [`Collecting ticks… ${digits.length}/${window}`];
                    return null;
                }
                const bars = digitBars(digits);
                const digit = lastDigit(ctx.market);
                notes = [`Green bar: ${bars.green.join(', ')} · Red bar: ${bars.red.join(', ')} · Last digit ${digit}`];

                for (const setup of setups) {
                    const name = setup.side === 'over' ? 'Over' : 'Under';
                    const blocker = setupBlocker(setup, bars);
                    if (blocker) {
                        notes.push(`${name}: waiting — ${blocker}`);
                        continue;
                    }
                    if (!setup.entry.includes(digit)) {
                        notes.push(`${name}: ready — waiting for digit ${setup.entry.join('/')}`);
                        continue;
                    }
                    if (!ctx.can_trade) continue;
                    const barrier = Number(setup.side === 'over' ? s.over_barrier : s.under_barrier);
                    const weak = setup.weak.map(d => `${d}=${pct(bars.percents[d])}`).join(', ');
                    return {
                        legs: [overUnderLeg(ctx.market.symbol, setup.side, barrier)],
                        reason: `${weak}; entry digit ${digit}`,
                    };
                }
                return null;
            },
            onSettled: outcome => {
                if (outcome.filled) done += 1;
            },
            finishAfter: () => (done >= runs ? `${runs} run${runs === 1 ? '' : 's'} done — stopped` : false),
            status: () => [...notes, `Runs: ${done}/${runs}`],
        };
    },
};
