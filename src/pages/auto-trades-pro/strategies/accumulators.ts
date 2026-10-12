import { scannerFeed } from '@/pages/scanner/scanner-feed';
import { TStrategy } from '../engine/types';
import { marketName, VOLATILITY_10 } from './helpers';

/**
 * BestAccumulators: scores how calm each market is relative to the
 * accumulator barriers, buys a 5% accumulator on the strongest market and
 * sells early when the price drifts towards a barrier.
 */

const BARRIER_DISTANCE = 0.0013;

/** Mean absolute tick-to-tick change, as a fraction of price. */
const meanMove = (prices: number[]) => {
    if (prices.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < prices.length; i++) total += Math.abs(prices[i] - prices[i - 1]) / prices[i - 1];
    return total / (prices.length - 1);
};

type TSafety = { score: number; survival: number; recommendation: string };

const barrierSafety = (prices: number[], price: number): TSafety => {
    if (prices.length < 20) return { score: 0, survival: 0, recommendation: 'WAIT' };
    const upper = price * (1 + BARRIER_DISTANCE);
    const lower = price * (1 - BARRIER_DISTANCE);
    const recent = prices.slice(-20);
    const volatility = meanMove(recent);
    const range = (Math.max(...recent) - Math.min(...recent)) / price;
    const distance = Math.min(Math.abs(upper - Math.max(...recent)) / price, Math.abs(lower - Math.min(...recent)) / price);

    let survival = 26;
    if (volatility > 0.03) survival *= 0.7;
    else if (volatility < 0.015) survival *= 1.4;
    if (range > 0.002) survival *= 0.8;
    else if (range < 0.001) survival *= 1.3;
    if (distance < 5e-4) survival *= 0.6;
    else if (distance > 0.0015) survival *= 1.2;

    let score = 50;
    score += volatility < 0.01 ? 30 : volatility < 0.02 ? 20 : volatility < 0.03 ? 10 : -10;
    score += range < 5e-4 ? 25 : range < 0.001 ? 15 : range < 0.002 ? 5 : -15;
    score += distance > 0.002 ? 25 : distance > 0.001 ? 15 : distance > 5e-4 ? 5 : -20;
    score = Math.max(0, Math.min(100, score));
    const recommendation = score >= 85 ? 'EXCELLENT' : score >= 70 ? 'GOOD' : score >= 55 ? 'MODERATE' : score >= 35 ? 'RISKY' : 'AVOID';
    return { score, survival: Math.round(survival), recommendation };
};

/** Ticks the price stayed inside the barrier band from past starting points (max 60). */
const historicSurvival = (prices: number[]) => {
    if (prices.length < 100) return [];
    const out: number[] = [];
    for (let start = 0; start < prices.length - 60; start += 5) {
        const upper = prices[start] * (1 + BARRIER_DISTANCE);
        const lower = prices[start] * (1 - BARRIER_DISTANCE);
        let ticks = 0;
        let broke = false;
        for (let i = start + 1; i < Math.min(start + 61, prices.length); i++) {
            ticks++;
            if (prices[i] >= upper || prices[i] <= lower) {
                out.push(ticks);
                broke = true;
                break;
            }
        }
        if (!broke && ticks === 60) out.push(60);
    }
    return out;
};

export type TAccuSignal = {
    symbol: string;
    strength: 'STRONG' | 'MEDIUM' | 'WEAK' | 'NONE';
    score: number;
    reason: string;
    range_pct: number;
    volatility: number;
    breakout_distance: number;
    safety: TSafety;
};

export const accumulatorSignal = (symbol: string, prices: number[]): TAccuSignal | null => {
    if (prices.length < 30) return null;
    const window = prices.slice(-30);
    const price = window[window.length - 1];
    const high = Math.max(...window);
    const low = Math.min(...window);
    const range_pct = ((high - low) / low) * 100;
    const early_vol = meanMove(window.slice(0, 15));
    const late_vol = meanMove(window.slice(15));
    const vol_ratio = early_vol > 0 ? late_vol / early_vol : 1;
    const mean = (list: number[]) => list.reduce((t, x) => t + x, 0) / list.length;
    const drift = 100 * Math.abs((mean(window.slice(15)) - mean(window.slice(0, 15))) / mean(window.slice(0, 15)));
    const breakout_floor = 1.005 * low;
    const breakout_distance = Math.min(
        Math.abs(((price - breakout_floor) / breakout_floor) * 100),
        Math.abs(((0.995 * high - price) / price) * 100)
    );
    let calm = 0;
    for (let i = 1; i < window.length; i++) if (100 * Math.abs((window[i] - window[i - 1]) / window[i - 1]) < 0.3) calm++;
    const stability = calm / (window.length - 1);

    let score = 0;
    const reasons: string[] = [];
    if (range_pct < 0.5) {
        score += 35;
        reasons.push('ultra-tight range');
    } else if (range_pct < 1) {
        score += 25;
        reasons.push('tight range');
    } else if (range_pct < 1.5) score += 15;
    if (vol_ratio < 0.7) score += 25;
    else if (vol_ratio < 0.85) score += 15;
    if (drift < 0.3) score += 20;
    else if (drift < 0.6) score += 10;
    if (breakout_distance > 2) score += 15;
    else if (breakout_distance > 1) score += 8;
    if (stability > 0.7) score += 15;
    else if (stability > 0.5) score += 8;

    const last5 = window.slice(-5);
    for (let i = 1; i < last5.length; i++) {
        if (100 * Math.abs((last5[i] - last5[i - 1]) / last5[i - 1]) > 0.5) {
            score -= 20;
            reasons.push('recent strong move');
            break;
        }
    }
    const position = ((price - low) / (high - low || 1)) * 100;
    if (position < 10 || position > 90) score -= 15;

    const safety = barrierSafety(window, price);
    score += safety.score >= 85 ? 30 : safety.score >= 70 ? 20 : safety.score >= 55 ? 5 : safety.score >= 35 ? -20 : -50;
    reasons.push(`barrier safety ${safety.score}/100`);

    const history = historicSurvival(prices);
    if (history.length > 10) {
        const average = Math.round(history.slice(-10).reduce((t, x) => t + x, 0) / 10);
        if (average > 25) score += 15;
        else if (average < 15) score -= 15;
        reasons.push(`historic survival ${average} ticks`);
    }

    const crowding = range_pct / (200 * BARRIER_DISTANCE);
    if (crowding > 0.6) score -= 25;
    if (crowding > 0.5 && vol_ratio > 1) score -= 30;

    const strength = score >= 75 ? 'STRONG' : score >= 55 ? 'MEDIUM' : score >= 35 ? 'WEAK' : 'NONE';
    return {
        symbol,
        strength,
        score: Math.max(0, Math.min(100, Math.round(score))),
        reason: `${range_pct.toFixed(2)}% range · ${reasons.join(', ')}`,
        range_pct,
        volatility: meanMove(window.slice(-20)),
        breakout_distance,
        safety,
    };
};

/** Take-profit as a % of stake: 5% by default, more for calmer, safer setups. */
const takeProfitPct = (signal: TAccuSignal) => {
    let tp = 5;
    if (signal.score >= 75 && signal.strength === 'STRONG' && signal.range_pct < 1 && signal.breakout_distance > 1 && signal.volatility < 0.03) tp = 8;
    if (signal.score >= 80 && signal.strength === 'STRONG' && signal.range_pct < 0.7 && signal.breakout_distance > 1.3 && signal.volatility < 0.025) tp = 10;
    return tp;
};

/** Sell early when the price is close to the band or moving fast towards it. */
const exitReason = (entry: number, spot: number, profit: number, recent: number[]): string | false => {
    const to_upper = (Math.abs(spot - 1.015 * entry) / entry) * 100;
    const to_lower = (Math.abs(spot - 0.985 * entry) / entry) * 100;
    const nearest = Math.min(to_upper, to_lower);
    const heading_up = spot > entry && to_upper < to_lower;
    const heading_down = spot < entry && to_lower < to_upper;
    let toward = 0;
    let momentum = 0;
    if (recent.length >= 3) {
        const changes: number[] = [];
        for (let i = 1; i < recent.length; i++) {
            const change = ((recent[i] - recent[i - 1]) / recent[i - 1]) * 100;
            changes.push(change);
            if ((heading_up && change > 0) || (heading_down && change < 0)) toward++;
        }
        momentum = changes.reduce((t, x) => t + x, 0) / changes.length;
    }
    const volatility = meanMove(recent);
    if (nearest <= 0.8) return `only ${nearest.toFixed(2)}% from the barrier`;
    if (nearest <= 1.2 && toward >= 2) return `${nearest.toFixed(2)}% from the barrier with momentum`;
    if (nearest <= 1.5 && volatility > 0.05) return 'high volatility near the barrier';
    if (nearest <= 2 && Math.abs(momentum) > 0.15) return 'strong momentum towards the barrier';
    if (profit > 0 && nearest <= 1.8 && toward >= 1) return 'securing profit before barrier risk';
    return false;
};

export const bestAccumulators: TStrategy = {
    id: 'best-accumulators',
    label: 'BestAccumulators',
    group: 'Advanced',
    summary:
        'Scores every volatility market for calm, range-bound conditions. On a strong signal it buys a 5% growth accumulator with a take profit of 5–10% of stake, and sells early when the price drifts towards a barrier.',
    fields: [{ key: 'min_score', label: 'Minimum signal score', type: 'number', min: 50, max: 100, step: 1 }],
    defaults: { min_score: 75 },
    create: s => {
        const signals = new Map<string, TAccuSignal>();
        let note = 'Collecting prices (30+ ticks per market)…';
        return {
            symbols: VOLATILITY_10,
            onTick: ctx => {
                const signal = accumulatorSignal(ctx.market.symbol, ctx.market.quotes);
                if (signal) signals.set(ctx.market.symbol, signal);
                const best = [...signals.values()].sort((a, b) => b.score - a.score)[0];
                if (best) note = `Best: ${marketName(best.symbol)} — ${best.strength} ${best.score}/100 (${best.reason})`;
                if (!ctx.can_trade || !best || ctx.market.symbol !== best.symbol) return null;
                if (best.strength !== 'STRONG' || best.score < Number(s.min_score)) return null;
                const tp_pct = takeProfitPct(best);
                const symbol = best.symbol;
                return {
                    legs: [
                        {
                            symbol,
                            contract_type: 'ACCU',
                            growth_rate: 0.05,
                            take_profit: Math.max(0.01, (ctx.money.stake * tp_pct) / 100),
                            label: `Accumulator 5% (TP ${tp_pct}%)`,
                        },
                    ],
                    reason: `${marketName(symbol)}: ${best.score}/100`,
                    shouldSell: contract => {
                        const entry = Number(contract.entry_spot ?? contract.entry_tick);
                        const spot = Number(contract.current_spot ?? contract.current_spot_display_value);
                        if (!Number.isFinite(entry) || !Number.isFinite(spot) || entry <= 0) return false;
                        const recent = (scannerFeed.markets.get(symbol)?.quotes ?? []).slice(-5);
                        return exitReason(entry, spot, Number(contract.profit) || 0, recent);
                    },
                };
            },
            status: () => [note],
        };
    },
};
