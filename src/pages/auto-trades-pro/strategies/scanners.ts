import { scanMarkets, TScanPlan, TScanSignal, TScanType } from '@/components/ai-scanner/market-scan';
import { TMarket } from '@/pages/scanner/scanner-feed';
import { hasLoadedBot, setBotNumber, setWorkspaceMarket } from '@/utils/bot-workspace';
import { TLeg } from '../engine/execute';
import { TOrder, TStrategy } from '../engine/types';
import { digitLeg, lastDigit, marketName, ONE_SECOND_8, overUnderLeg, pct, rangeOptions, TSide, VOLATILITY_10 } from './helpers';

const now = () => Date.now();

// ---------- AI Scanner (Digit Scanner) ----------

type TRiskSet = 'low' | 'medium' | 'high' | 'mix';

const RISK_BARRIERS: Record<Exclude<TRiskSet, 'mix'>, { side: TSide; barrier: number }[]> = {
    low: [
        { side: 'under', barrier: 9 },
        { side: 'under', barrier: 8 },
        { side: 'over', barrier: 0 },
        { side: 'over', barrier: 1 },
    ],
    medium: [
        { side: 'under', barrier: 6 },
        { side: 'under', barrier: 5 },
        { side: 'under', barrier: 4 },
        { side: 'over', barrier: 3 },
        { side: 'over', barrier: 4 },
        { side: 'over', barrier: 5 },
    ],
    high: [
        { side: 'under', barrier: 3 },
        { side: 'under', barrier: 2 },
        { side: 'over', barrier: 6 },
        { side: 'over', barrier: 7 },
    ],
};

const riskBarriers = (set: TRiskSet) =>
    set === 'mix' ? [...RISK_BARRIERS.low, ...RISK_BARRIERS.medium, ...RISK_BARRIERS.high] : RISK_BARRIERS[set];

type TContractPlan = { leg: (symbol: string) => TLeg; side?: TSide; barrier?: number; kind: string };

/** The contract a scanner plan trades, with Over/Under barriers moved to the nearest one in the risk set. */
const planContract = (plan: TScanPlan, risk: TRiskSet): TContractPlan | null => {
    const overUnder = (side: TSide, barrier: number): TContractPlan => {
        const allowed = riskBarriers(risk).filter(option => option.side === side);
        const nearest = allowed.length
            ? allowed.some(option => option.barrier === barrier)
                ? barrier
                : allowed.reduce((best, option) =>
                      Math.abs(option.barrier - barrier) < Math.abs(best.barrier - barrier) ? option : best
                  ).barrier
            : barrier;
        return { kind: 'overunder', side, barrier: nearest, leg: symbol => overUnderLeg(symbol, side, nearest) };
    };
    switch (plan.bot) {
        case 'magical':
            return plan.is_over ? overUnder('over', plan.over_barrier) : overUnder('under', plan.under_barrier);
        case 'over1ai':
            return overUnder('over', plan.primary_barrier);
        case 'oversingle':
            return overUnder('over', plan.barrier);
        case 'underside':
        case 'under8strategy':
            return overUnder('under', plan.primary_barrier);
        case 'undersingle':
            return overUnder('under', plan.barrier);
        case 'evenodd':
            return { kind: plan.side, leg: symbol => digitLeg(symbol, plan.side) };
        case 'matches':
            return { kind: 'DIGITMATCH', barrier: plan.digit, leg: symbol => digitLeg(symbol, 'DIGITMATCH', 1, plan.digit) };
        case 'differs':
            return { kind: 'DIGITDIFF', barrier: plan.digit, leg: symbol => digitLeg(symbol, 'DIGITDIFF', 1, plan.digit) };
        case 'risefall':
            return { kind: plan.side, leg: symbol => digitLeg(symbol, plan.side, plan.duration) };
        default:
            return null;
    }
};

type TWatch =
    | { kind: 'digit'; digit: number }
    | { kind: 'avoid'; digit: number }
    | { kind: 'parity'; ours_even: boolean; count: number }
    | { kind: 'trend'; want_up: boolean; count: number; against: number; prev: number | null }
    | { kind: 'streak'; is_under: boolean; barrier: number; count: number; threshold: number };

const buildWatch = (signal: TScanSignal, contract: TContractPlan): TWatch | null => {
    if (contract.kind === 'DIGITMATCH' && signal.entry_digit !== undefined) return { kind: 'digit', digit: signal.entry_digit };
    if (contract.kind === 'DIGITDIFF' && contract.barrier !== undefined) return { kind: 'avoid', digit: contract.barrier };
    if (contract.kind === 'DIGITEVEN' || contract.kind === 'DIGITODD') {
        return { kind: 'parity', ours_even: contract.kind === 'DIGITEVEN', count: 0 };
    }
    if (contract.kind === 'CALL' || contract.kind === 'PUT') {
        return { kind: 'trend', want_up: contract.kind === 'CALL', count: 0, against: 0, prev: null };
    }
    if (contract.kind === 'overunder' && contract.side && contract.barrier !== undefined) {
        const is_under = contract.side === 'under';
        const loss_share = (is_under ? 10 - contract.barrier : contract.barrier + 1) / 10;
        const threshold =
            loss_share <= 0 || loss_share >= 1
                ? 1
                : Math.min(5, Math.max(1, Math.round(Math.log(0.1) / Math.log(loss_share))));
        return { kind: 'streak', is_under, barrier: contract.barrier, count: 0, threshold };
    }
    return null;
};

/** Advances a watch with the newest tick: 'enter', 'drop' or a progress note. */
const stepWatch = (watch: TWatch, digit: number, quote: number): 'enter' | 'drop' | string => {
    switch (watch.kind) {
        case 'digit':
            return digit === watch.digit ? 'enter' : `waiting for ${watch.digit}`;
        case 'avoid':
            return digit === watch.digit ? 'enter' : `waiting for ${watch.digit} to print`;
        case 'parity':
            if ((digit % 2 === 0) === watch.ours_even) {
                if (watch.count >= 3) return 'enter';
                watch.count = 0;
                return '0/3 opposite ticks';
            }
            watch.count += 1;
            return watch.count > 3 ? 'drop' : `${watch.count}/3 opposite ticks`;
        case 'trend': {
            const previous = watch.prev;
            watch.prev = quote;
            if (previous === null || quote === previous) return `${watch.count}/3 ticks`;
            if (quote > previous === watch.want_up) {
                watch.against = 0;
                watch.count += 1;
                return watch.count >= 3 ? 'enter' : `${watch.count}/3 ticks ${watch.want_up ? 'up' : 'down'}`;
            }
            watch.count = 0;
            watch.against += 1;
            return watch.against >= 4 ? 'drop' : `${watch.against} ticks against`;
        }
        case 'streak': {
            const against = watch.is_under ? digit >= watch.barrier : digit <= watch.barrier;
            if (!against) {
                watch.count = 0;
                return `0/${watch.threshold} against the trade`;
            }
            watch.count += 1;
            return watch.count >= watch.threshold ? 'enter' : `${watch.count}/${watch.threshold} against the trade`;
        }
        default:
            return 'drop';
    }
};

export const aiScanner: TStrategy = {
    id: 'ai-market-scanner',
    label: 'AI Scanner',
    group: 'Digits',
    summary:
        'Digit Scanner: scans every volatility market with the AI scanner rules, watches up to five candidates for their entry pattern, then fires the set number of identical trades on the first one to trigger. One run per start.',
    fields: [
        {
            key: 'type',
            label: 'Trade type',
            type: 'select',
            options: [
                { value: 'overunder', label: 'Over / Under' },
                { value: 'evenodd', label: 'Even / Odd' },
                { value: 'matchesdiffers', label: 'Matches / Differs' },
                { value: 'risefall', label: 'Rise / Fall' },
            ],
        },
        { key: 'trades', label: 'Number of trades', type: 'number', min: 1, max: 50, step: 1 },
        {
            key: 'risk',
            label: 'Risk set',
            type: 'select',
            options: [
                { value: 'low', label: 'Low (Under 9, Under 8, Over 0, Over 1)' },
                { value: 'medium', label: 'Medium (Under 6/5/4, Over 3/4/5)' },
                { value: 'high', label: 'High (Under 3/2, Over 6/7)' },
                { value: 'mix', label: 'Mix (any of the above)' },
            ],
            visible: s => s.type === 'overunder',
        },
    ],
    defaults: { type: 'overunder', trades: 5, risk: 'low' },
    create: s => {
        let phase: 'scanning' | 'waiting' = 'scanning';
        let last_scan = 0;
        let passes = 0;
        let note = 'Standby — ready to scan every volatility market.';
        const watches = new Map<string, { signal: TScanSignal; contract: TContractPlan; watch: TWatch }>();

        const fire = (symbol: string, entry: { signal: TScanSignal; contract: TContractPlan }, why: string): TOrder => {
            const count = Math.max(1, Math.min(50, Math.round(Number(s.trades) || 1)));
            const leg = entry.contract.leg(symbol);
            watches.clear();
            note = `${entry.signal.market_name}: ${why} — entering ${count} × ${leg.label}`;
            return { legs: Array.from({ length: count }, () => ({ ...leg })), as_batch: true, reason: note };
        };

        return {
            symbols: VOLATILITY_10,
            onTick: ctx => {
                if (!ctx.can_trade) return null;
                if (phase === 'scanning') {
                    if (now() - last_scan < 1500) return null;
                    last_scan = now();
                    passes += 1;
                    const markets = VOLATILITY_10.map(symbol => ctx.markets.get(symbol)).filter(
                        (m): m is TMarket => Boolean(m)
                    );
                    const { signals, scanned } = scanMarkets(markets, s.type as TScanType);
                    if (!signals.length) {
                        note = `Pass ${passes}: ${scanned} market(s) analysed, none cleared the bar — rescanning`;
                        return null;
                    }
                    const candidates = signals
                        .map(signal => {
                            const contract = planContract(signal.plan, s.risk);
                            const watch = contract && buildWatch(signal, contract);
                            return contract && watch ? { signal, contract, watch } : null;
                        })
                        .filter(Boolean)
                        .slice(0, 5) as { signal: TScanSignal; contract: TContractPlan; watch: TWatch }[];
                    if (!candidates.length) {
                        const best = signals[0];
                        const contract = planContract(best.plan, s.risk);
                        return contract ? fire(best.symbol, { signal: best, contract }, 'best signal') : null;
                    }
                    candidates.forEach(candidate => watches.set(candidate.signal.symbol, candidate));
                    phase = 'waiting';
                    note = `Watching ${candidates.length} market(s) for entry: ${candidates
                        .map(c => c.signal.market_name)
                        .join(', ')}`;
                    ctx.log(note);
                    return null;
                }

                const entry = watches.get(ctx.market.symbol);
                if (!entry) return null;
                const step = stepWatch(entry.watch, lastDigit(ctx.market), ctx.market.last_quote ?? 0);
                if (step === 'enter') return fire(ctx.market.symbol, entry, 'entry pattern met');
                if (step === 'drop') {
                    watches.delete(ctx.market.symbol);
                    ctx.log(`${entry.signal.market_name}: signal dropped`);
                    if (!watches.size) {
                        phase = 'scanning';
                        note = 'All signals dropped — back to scanning';
                    }
                    return null;
                }
                note = `${entry.signal.market_name}: ${step}`;
                return null;
            },
            finishAfter: outcome => `Run complete. Net ${outcome.profit >= 0 ? '+' : ''}${outcome.profit.toFixed(2)}`,
            status: () => [phase === 'scanning' ? 'Scanning' : 'Waiting for entry', note],
        };
    },
};

// ---------- MultipleMatches ----------

const significance = (score: number, sample: number) => Math.sqrt((score * (1 - score)) / sample);

export const multipleMatches: TStrategy = {
    id: 'multiple-matches',
    label: 'MultipleMatches',
    group: 'Digits',
    summary:
        'Finds the market where the digits most likely to follow the current last digit cover more than the base rate by the minimum edge, then buys one Matches (or Differs) contract per chosen digit at the same moment.',
    fields: [
        { key: 'count', label: 'Digits per batch', type: 'select', options: rangeOptions(1, 10) },
        { key: 'direction', label: 'Direction', type: 'select', options: [
            { value: 'MATCH', label: 'Matches' },
            { value: 'DIFFER', label: 'Differs' },
        ] },
        { key: 'min_edge', label: 'Minimum edge over base (%)', type: 'number', min: 0, max: 10, step: 0.5 },
        { key: 'continuous', label: 'Continuous (keep trading)', type: 'toggle' },
    ],
    defaults: { count: 3, direction: 'MATCH', min_edge: 2, continuous: false },
    create: s => {
        let last_eval = 0;
        let note = 'Waiting for a setup…';
        return {
            symbols: VOLATILITY_10,
            onTick: ctx => {
                if (!ctx.can_trade || now() - last_eval < 1000) return null;
                last_eval = now();
                const count = Math.max(1, Math.min(10, Number(s.count)));
                const is_match = s.direction === 'MATCH';
                const baseline = is_match ? count / 10 : (10 - count) / 10;
                const edge = Number(s.min_edge) / 100;
                let best: { symbol: string; digits: number[]; score: number; sample: number; conditional: boolean } | null =
                    null;
                let best_any = 0;
                for (const symbol of VOLATILITY_10) {
                    const digits = ctx.markets.get(symbol)?.digits ?? [];
                    const n = digits.length;
                    if (n < 200) continue;
                    const last = digits[n - 1];
                    const all = Array(10).fill(0);
                    const after = Array(10).fill(0);
                    let occurrences = 0;
                    digits.forEach(d => all[d]++);
                    for (let i = 0; i < n - 1; i++) {
                        if (digits[i] === last) {
                            occurrences++;
                            after[digits[i + 1]]++;
                        }
                    }
                    const conditional = occurrences >= 50;
                    const sample = conditional ? occurrences : n;
                    const probs = (conditional ? after : all).map(c => c / sample);
                    const ranked = probs.map((p, d) => ({ d, p })).sort((a, b) => b.p - a.p);
                    const chosen = is_match ? ranked.slice(0, count) : ranked.slice(-count);
                    const covered = chosen.reduce((total, x) => total + x.p, 0);
                    const score = is_match ? covered : 1 - covered;
                    best_any = Math.max(best_any, score);
                    const significant = score - 1.64 * significance(score, sample) >= baseline;
                    if (score >= baseline + edge && significant && (!best || score > best.score)) {
                        best = { symbol, digits: chosen.map(x => x.d), score, sample, conditional };
                    }
                }
                if (!best) {
                    note = `Waiting for a ${is_match ? 'match' : 'differ'} setup ≥ ${pct(100 * baseline + Number(s.min_edge))} (best so far ${pct(100 * best_any)})`;
                    return null;
                }
                const contract = is_match ? 'DIGITMATCH' : 'DIGITDIFF';
                note = `${marketName(best.symbol)} — ${is_match ? 'match' : 'differ'} on ${best.digits.join(', ')} · ${pct(
                    100 * best.score
                )} (+${pct(100 * (best.score - baseline))} over base)`;
                return {
                    legs: best.digits.map(d => digitLeg(best.symbol, contract, 1, d)),
                    as_batch: true,
                    reason: note,
                };
            },
            finishAfter: outcome =>
                s.continuous ? false : `Batch complete. Net ${outcome.profit >= 0 ? '+' : ''}${outcome.profit.toFixed(2)}`,
            status: () => [note],
        };
    },
};

// ---------- Over5/Under4 ----------

export const over5Under4: TStrategy = {
    id: 'over5-under4-scan',
    label: 'Over5/Under4',
    group: 'Digits',
    summary:
        'On the 1-second markets, fires an Over 5 + Under 4 pair together when the trigger is met: a 7/8/9 frequency rule, a chosen digit, or a run of 4s and 5s. The pair counts as one trade for martingale.',
    fields: [
        { key: 'trigger', label: 'Trigger', type: 'select', options: [
            { value: 'percentage', label: '≥2 of 7/8/9 above threshold, then 5 lows → 1 high' },
            { value: '1digit', label: 'One digit' },
            { value: '2digits', label: 'Two 4/5 digits in a row' },
            { value: '3digits', label: 'Three 4/5 digits in a row' },
        ] },
        {
            key: 'high_threshold',
            label: 'High-digit threshold (%)',
            type: 'number',
            min: 8,
            max: 20,
            step: 0.5,
            visible: s => s.trigger === 'percentage',
        },
        {
            key: 'one_digit',
            label: 'Digit',
            type: 'select',
            options: [
                { value: 4, label: '4' },
                { value: 5, label: '5' },
            ],
            visible: s => s.trigger === '1digit',
        },
        { key: 'continuous', label: 'Continuous (keep trading)', type: 'toggle' },
    ],
    defaults: { trigger: 'percentage', high_threshold: 11, one_digit: 4, continuous: false },
    create: s => {
        let note = 'Watching the 1-second markets…';
        const triggered = (digits: number[]): string | null => {
            const n = digits.length;
            if (s.trigger === 'percentage') {
                if (n < 500) return null;
                const share = [7, 8, 9].map(d => digits.filter(x => x === d).length / n);
                if (share.filter(f => f > Number(s.high_threshold) / 100).length < 2) return null;
                for (let i = n - 6; i < n - 1; i++) if (digits[i] >= 7) return null;
                return digits[n - 1] >= 7 ? `7/8/9 at ${share.map(f => pct(f * 100)).join(' / ')}` : null;
            }
            if (s.trigger === '1digit') return digits[n - 1] === Number(s.one_digit) ? `a ${s.one_digit} printed` : null;
            const len = s.trigger === '3digits' ? 3 : 2;
            if (n < len) return null;
            const recent = digits.slice(-len);
            return recent.every(d => d === 4 || d === 5) ? `${recent.join(',')} printed` : null;
        };
        return {
            symbols: ONE_SECOND_8,
            onTick: ctx => {
                if (!ctx.can_trade) return null;
                const why = triggered(ctx.market.digits);
                if (!why) return null;
                note = `${marketName(ctx.market.symbol)}: ${why}`;
                return {
                    legs: [overUnderLeg(ctx.market.symbol, 'over', 5), overUnderLeg(ctx.market.symbol, 'under', 4)],
                    as_batch: true,
                    reason: note,
                };
            },
            finishAfter: outcome =>
                s.continuous ? false : `Pair complete. Net ${outcome.profit >= 0 ? '+' : ''}${outcome.profit.toFixed(2)}`,
            status: () => [note],
        };
    },
};

// ---------- AMatchesDiffers ----------

type TCompetitive = { symbol: string; target: number; trigger: number; gap: number; confidence: number; reason: string };

const competitiveSignal = (market: TMarket): TCompetitive | null => {
    const digits = market.digits;
    if (digits.length < 500) return null;
    const window = digits.slice(-500);
    const recent = digits.slice(-100);
    const stats = Array.from({ length: 10 }, (_, d) => ({
        d,
        p: (window.filter(x => x === d).length / window.length) * 100,
        recent: (recent.filter(x => x === d).length / recent.length) * 100,
    })).sort((a, b) => b.p - a.p);
    const [top, second] = stats;
    const gap = top.p - second.p;
    if (gap >= 0.3 || top.p < 9 || second.p < 9) return null;
    const top_gain = top.recent - top.p;
    const second_gain = second.recent - second.p;
    const [gaining, losing] = second_gain > top_gain ? [second, top] : [top, second];
    const confidence = gap >= 0.2 ? 75 : gap >= 0.1 ? 85 : 95;
    return {
        symbol: market.symbol,
        target: gaining.d,
        trigger: losing.d,
        gap,
        confidence,
        reason: `Gap ${gap.toFixed(2)}%, gaining ${gaining.d} (${pct(gaining.recent)}), losing ${losing.d} (${pct(losing.recent)})`,
    };
};

export const aMatchesDiffers: TStrategy = {
    id: 'amatches-differs',
    label: 'AMatchesDiffers',
    group: 'Digits',
    summary:
        'Looks for a market where the two most frequent digits are within 0.3% of each other. When the losing digit prints it buys Matches on the gaining digit — up to 4 tries in a 45-second window, stopping at the first win.',
    fields: [],
    defaults: {},
    create: () => {
        let active: (TCompetitive & { expires: number; attempts: number; burst: boolean; won: boolean }) | null = null;
        let note = 'Scanning for a competitive pair…';
        return {
            symbols: VOLATILITY_10,
            onTick: ctx => {
                const signal = competitiveSignal(ctx.market);
                const expired = active && (now() > active.expires || active.won || active.attempts >= 4);
                if (expired && !active?.burst) active = null;
                if (!active && signal && signal.confidence >= 75) {
                    active = { ...signal, expires: now() + 45000, attempts: 0, burst: false, won: false };
                    note = `${marketName(signal.symbol)}: ${signal.reason} — waiting for ${signal.trigger}`;
                    ctx.log(note);
                }
                if (!active || !ctx.can_trade || ctx.market.symbol !== active.symbol) return null;
                if (active.won || active.attempts >= 4) return null;
                if (!active.burst) {
                    if (now() > active.expires) return null;
                    if (lastDigit(ctx.market) !== active.trigger) return null;
                    active.burst = true;
                }
                active.attempts += 1;
                return {
                    legs: [digitLeg(active.symbol, 'DIGITMATCH', 1, active.target)],
                    reason: `Attempt ${active.attempts}/4: ${active.trigger} printed`,
                };
            },
            onSettled: outcome => {
                if (!active || !outcome.filled) return;
                if (outcome.is_win) active.won = true;
                if (active.won || active.attempts >= 4) {
                    note = active.won ? 'Signal won — scanning again' : '4 attempts used — scanning again';
                    active = null;
                }
            },
            status: () => [note, active ? `Attempts ${active.attempts}/4` : ''].filter(Boolean),
        };
    },
};

// ---------- Matches/Differs signal provider ----------

const providerSignal = (market: TMarket) => {
    const digits = market.digits;
    if (digits.length < 1000) return null;
    const share = (list: number[], d: number) => (list.filter(x => x === d).length / list.length) * 100;
    const last200 = digits.slice(-200);
    const last400 = digits.slice(-400);
    const last600 = digits.slice(-600);
    const ranked = Array.from({ length: 10 }, (_, d) => {
        const a = share(last200, d);
        const b = share(last400, d);
        const c = share(last600, d);
        return { d, p: share(digits, d), rising: a > b && b > c };
    }).sort((x, y) => y.p - x.p);
    const [top, second] = ranked;
    const gap = top.p - second.p;
    if (!(gap <= 3 && gap >= 0.1 && top.p >= 9 && second.p >= 8 && second.rising)) return null;
    const confidence = Math.round(50 * Math.max(0, (3 - gap) / 3) + 50 * Math.min(second.p / 12, 1));
    return { symbol: market.symbol, target: top.d, trigger: second.d, confidence, reason: `Gap ${gap.toFixed(1)}%, ${top.d} leading at ${pct(top.p)}` };
};

export const matchesSignalProvider: TStrategy = {
    id: 'matches-differs',
    label: 'Matches/Differs',
    group: 'Digits',
    signal_only: true,
    summary:
        'Matches Signal Provider: finds a market where the leading digit is closely chased by a rising second digit (70+ confidence) and points the Matches bot loaded in the Bot Builder at that market and digit. It does not trade by itself.',
    fields: [],
    defaults: {},
    create: () => {
        let cooldown_until = 0;
        let note = 'Analysing markets (needs 1000 ticks each)…';
        return {
            symbols: VOLATILITY_10,
            onTick: ctx => {
                if (now() < cooldown_until) return null;
                const signal = providerSignal(ctx.market);
                if (!signal || signal.confidence < 70) return null;
                cooldown_until = now() + 30000;
                note = `${marketName(signal.symbol)}: Matches ${signal.target} (${signal.confidence}%) — ${signal.reason}`;
                if (hasLoadedBot()) {
                    const market_ok = setWorkspaceMarket(signal.symbol);
                    const digit_ok = setBotNumber('Prediction', signal.target);
                    ctx.log(
                        `${note}. Bot ${market_ok ? 'switched to this market' : 'market unchanged'}${
                            digit_ok ? `, prediction set to ${signal.target}` : ''
                        }.`
                    );
                } else {
                    ctx.log(`${note}. Load a Matches bot to apply signals automatically.`);
                }
                return null;
            },
            status: () => [note],
        };
    },
};
