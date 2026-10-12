import { TMarket } from '@/pages/scanner/scanner-feed';
import { TStrategy } from '../engine/types';
import { DIGIT_OPTIONS, lastDigit, marketName, overUnderLeg, pct, rangeOptions, TSide, VOLATILITY_10 } from './helpers';

/**
 * Osman (OSAM Trading Over/Under poster). Reads last-digit percentages over a
 * window, like the analysis tool's digit bars: the "green bar" is the most
 * frequent digit, the "red bar" the least frequent.
 *
 * Over: 0 and 1 below 10.5% and neither is a red/green bar; enter when the
 * last digit is 5 or 6, which must not be red/green either.
 * Under: 8 and 9 below 10.5%, neither red/green; enter on 4, 7 or 9, none of
 * them red/green.
 *
 * It scans every market for setups that meet all conditions, ranks them by
 * the recent win share of the contract, trades only the top one, and after
 * the set number of runs scans again — until take profit or stop loss.
 */

const LIMIT = 10.5;

type TSetup = { side: TSide; weak: number[]; entry: number[] };

export const SETUPS: TSetup[] = [
    { side: 'over', weak: [0, 1], entry: [5, 6] },
    { side: 'under', weak: [8, 9], entry: [4, 7, 9] },
];

type TBars = ReturnType<typeof digitBars>;

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

/** Each condition of a setup with whether it currently holds. */
export const setupChecks = (setup: TSetup, bars: TBars) => {
    const { percents, green, red } = bars;
    const barOf = (d: number) => (green.includes(d) ? 'green' : red.includes(d) ? 'red' : null);
    const noBars = (digits: number[]) => {
        const barred = digits.filter(d => barOf(d));
        return {
            label: barred.length
                ? `${barred.map(d => `${d} has the ${barOf(d)} bar`).join(', ')}`
                : `${digits.join(', ')} not red/green`,
            ok: barred.length === 0,
        };
    };
    return [
        ...setup.weak.map(d => ({ label: `${d} at ${pct(percents[d])} (< ${LIMIT}%)`, ok: percents[d] < LIMIT })),
        noBars(setup.weak),
        noBars(setup.entry),
    ];
};

export const sideName = (side: TSide) => (side === 'over' ? 'Over' : 'Under');

export type TOsmanCandidate = {
    symbol: string;
    setup: TSetup;
    barrier: number;
    /** Share of the window's digits that would have won this contract. */
    win_share: number;
    bars: TBars;
    checks: { label: string; ok: boolean }[];
};

export type TOsmanScanOptions = { symbols: string[]; side: string; window: number; over_barrier: number; under_barrier: number };

/**
 * Checks every market for the Osman setups. `ready` holds the setups meeting
 * every condition, best win share first; `closest` is the nearest miss when
 * none are ready; `collecting` counts markets still short of the window.
 */
export const scanOsman = (markets: Map<string, TMarket>, options: TOsmanScanOptions) => {
    const setups = SETUPS.filter(setup => options.side === 'both' || options.side === setup.side);
    const ready: TOsmanCandidate[] = [];
    const seen: TOsmanCandidate[] = [];
    let collecting = 0;
    options.symbols.forEach(symbol => {
        const digits = markets.get(symbol)?.digits.slice(-options.window) ?? [];
        if (digits.length < options.window) {
            collecting++;
            return;
        }
        const bars = digitBars(digits);
        setups.forEach(setup => {
            const barrier = setup.side === 'over' ? options.over_barrier : options.under_barrier;
            const wins = digits.filter(d => (setup.side === 'over' ? d > barrier : d < barrier)).length;
            const candidate = { symbol, setup, barrier, bars, checks: setupChecks(setup, bars), win_share: (100 * wins) / digits.length };
            seen.push(candidate);
            if (candidate.checks.every(c => c.ok)) ready.push(candidate);
        });
    });
    ready.sort((a, b) => b.win_share - a.win_share);
    const okCount = (c: TOsmanCandidate) => c.checks.filter(check => check.ok).length;
    const closest = ready.length ? null : ([...seen].sort((a, b) => okCount(b) - okCount(a) || b.win_share - a.win_share)[0] ?? null);
    return { ready, closest, collecting };
};

/** "Volatility 25 Index — Over 1: ✓ 0 at 9.2% (< 10.5%) · …" */
export const osmanChecklist = (c: TOsmanCandidate) =>
    `${marketName(c.symbol)} — ${sideName(c.setup.side)} ${c.barrier}: ${c.checks
        .map(check => `${check.ok ? '✓' : '✗'} ${check.label}`)
        .join(' · ')}`;

export const osman: TStrategy = {
    id: 'osman',
    label: 'Osman',
    group: 'Digits',
    uses_market: true,
    summary:
        'OSAM Over/Under rules. Over: 0 and 1 under 10.5% and not the red or green bar; entry when the last digit is 5 or 6 (not red/green). Under: 8 and 9 under 10.5% and not red/green; entry on 4, 7 or 9 (not red/green). Scans the markets, trades only the setup with the highest recent win share, runs it the set number of times, then scans for the next one until take profit or stop loss.',
    fields: [
        {
            key: 'scope',
            label: 'Scan',
            type: 'select',
            options: [
                { value: 'all', label: 'All 10 volatility markets' },
                { value: 'single', label: 'Selected market only' },
            ],
        },
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
            help: 'Over 1 loses only on 0 and 1, the digits the rule checks. Entry: last digit 5 or 6.',
        },
        {
            key: 'under_barrier',
            label: 'Under prediction',
            type: 'select',
            options: DIGIT_OPTIONS.slice(1),
            visible: s => s.side !== 'over',
            help: 'Under 8 loses only on 8 and 9, the digits the rule checks. Entry: last digit 4, 7 or 9.',
        },
        {
            key: 'window',
            label: 'Analysis window',
            type: 'select',
            options: [100, 250, 500, 1000].map(value => ({ value, label: `${value} ticks` })),
        },
        { key: 'runs', label: 'Runs per setup', type: 'select', options: rangeOptions(1, 20) },
        {
            key: 'after_runs',
            label: 'After the runs',
            type: 'select',
            options: [
                { value: 'scan', label: 'Scan for the next setup' },
                { value: 'stop', label: 'Stop' },
            ],
            help: 'Scanning continues until take profit or stop loss.',
        },
    ],
    defaults: { scope: 'all', side: 'both', over_barrier: 1, under_barrier: 8, window: 1000, runs: 3, after_runs: 'scan' },
    create: (s, money) => {
        const window = Number(s.window);
        const runs = Number(s.runs);
        const symbols = s.scope === 'single' ? [money.symbol] : VOLATILITY_10;
        const setups = SETUPS.filter(setup => s.side === 'both' || s.side === setup.side);
        const barrierFor = (side: TSide) => Number(side === 'over' ? s.over_barrier : s.under_barrier);
        const entryNote = setups
            .map(setup => `${sideName(setup.side)} ${barrierFor(setup.side)} entry: last digit ${setup.entry.join('/')}`)
            .join(' · ');

        /** The market and setup currently being run, and how many of its runs are done. */
        let locked: { symbol: string; side: TSide; done: number } | null = null;
        let setups_done = 0;
        let collecting = symbols.length;
        let notes: string[] = [];

        const headline = () =>
            locked
                ? `Running ${sideName(locked.side)} ${barrierFor(locked.side)} on ${marketName(locked.symbol)} — run ${locked.done + 1}/${runs}`
                : `Scanning ${symbols.length} market${symbols.length === 1 ? '' : 's'}${
                      collecting ? ` (${collecting} still loading ticks)` : ''
                  } · setups completed: ${setups_done}`;

        const scan_options = {
            symbols,
            side: String(s.side),
            window,
            over_barrier: barrierFor('over'),
            under_barrier: barrierFor('under'),
        };

        return {
            symbols,
            onTick: ctx => {
                const scan = scanOsman(ctx.markets, scan_options);
                const { ready, closest } = scan;
                collecting = scan.collecting;

                // A locked setup keeps its market while its conditions hold; otherwise the best ready one is the target.
                if (locked) {
                    const lock = locked;
                    const still = ready.find(c => c.symbol === lock.symbol && c.setup.side === lock.side);
                    if (!still) {
                        ctx.log(
                            `${sideName(lock.side)} on ${marketName(lock.symbol)} no longer meets the conditions after ${lock.done}/${runs} runs — scanning again`
                        );
                        locked = null;
                    }
                }
                const target = locked
                    ? ready.find(c => c.symbol === locked!.symbol && c.setup.side === locked!.side)!
                    : ready[0];

                notes = [entryNote];
                if (target) {
                    notes.push(`Best: ${osmanChecklist(target)} · win share ${pct(target.win_share)}`);
                    const others = ready.filter(c => c !== target).slice(0, 3);
                    if (others.length)
                        notes.push(
                            `Also ready: ${others
                                .map(c => `${sideName(c.setup.side)} ${c.barrier} on ${marketName(c.symbol)} (${pct(c.win_share)})`)
                                .join(', ')}`
                        );
                } else if (closest) {
                    notes.push(`No setup meets every condition. Closest: ${osmanChecklist(closest)}`);
                }

                if (!target || ctx.market.symbol !== target.symbol || !ctx.can_trade) return null;
                const digit = lastDigit(ctx.market);
                if (!target.setup.entry.includes(digit)) return null;

                if (!locked) {
                    locked = { symbol: target.symbol, side: target.setup.side, done: 0 };
                    ctx.log(`Setup found: ${osmanChecklist(target)} · win share ${pct(target.win_share)}`);
                }
                const weak = target.setup.weak.map(d => `${d}=${pct(target.bars.percents[d])}`).join(', ');
                return {
                    legs: [overUnderLeg(target.symbol, target.setup.side, target.barrier)],
                    reason: `Run ${locked.done + 1}/${runs} · ${weak} · entry digit ${digit} · win share ${pct(target.win_share)}`,
                };
            },
            onSettled: outcome => {
                if (!outcome.filled || !locked) return;
                locked.done += 1;
                if (locked.done >= runs) {
                    setups_done += 1;
                    locked = null;
                }
            },
            finishAfter: () =>
                s.after_runs === 'stop' && setups_done > 0 ? `${runs} run${runs === 1 ? '' : 's'} done — stopped` : false,
            status: () => [headline(), ...notes],
        };
    },
};
