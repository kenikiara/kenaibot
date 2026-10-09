import {
    nextStake,
    simulateSession,
    START,
    TOutcome,
    TRADE_COUNTS,
    TSessionPlan,
    TSessionState,
    TStakePlan,
} from '../digit-session/session-math';
import { TMarket } from '../scanner/scanner-feed';
import { OU_PAIRS, readContract, TPricedPair } from '../over-under/catalog';
import { DEFAULT_OU_ENTRY, TOUEntry } from '../over-under/ou-entry';

/**
 * Million Bot's two analyses:
 *  1. Patterns: how far each Over barrier on each market is from its expected hit rate.
 *  2. Parameters: which pair, stake plan and trade count give the best chance of
 *     reaching the goal, by simulating every combination.
 */

export type TGoal = {
    target: number;
    stop_loss: number;
    stake: number;
    max_trades: number;
    max_losing_streak: number;
    /** Largest single stake the recovery plan may use. */
    max_stake: number;
};

export type TSuggestion = {
    key: string;
    pair: TPricedPair;
    stake_plan: TStakePlan;
    trades: number;
    plan: TSessionPlan;
    outcome: TOutcome;
};

export const planFor = (goal: TGoal, pair: TPricedPair, stake_plan: TStakePlan, trades: number): TSessionPlan => ({
    trades,
    stake: goal.stake,
    stake_plan,
    target: goal.target,
    stop_loss: goal.stop_loss,
    max_losing_streak: goal.max_losing_streak,
    max_stake: goal.max_stake,
    payout: pair.payout,
    win_probability: pair.win_probability,
});

/** Every pair × stake plan × trade count, best chance of reaching the target first. */
export const suggestParameters = (
    goal: TGoal,
    pairs: TPricedPair[],
    from: TSessionState = START,
    runs = 1200
): TSuggestion[] => {
    const counts = [...new Set([...TRADE_COUNTS.filter(n => n < goal.max_trades), goal.max_trades])].filter(
        n => n > from.trades_done
    );
    const out: TSuggestion[] = [];
    pairs.forEach(pair => {
        (['flat', 'recovery'] as TStakePlan[]).forEach(stake_plan => {
            counts.forEach(trades => {
                const plan = planFor(goal, pair, stake_plan, trades);
                if (nextStake(plan, from.net) === null) return;
                out.push({
                    key: `${pair.key}-${stake_plan}-${trades}`,
                    pair,
                    stake_plan,
                    trades,
                    plan,
                    outcome: simulateSession(plan, from, runs),
                });
            });
        });
    });
    // Best chance of the goal; among near-ties prefer the better average result, then fewer trades
    return out.sort(
        (a, b) =>
            Math.round(b.outcome.p_target * 100) - Math.round(a.outcome.p_target * 100) ||
            b.outcome.avg_net - a.outcome.avg_net ||
            a.trades - b.trades
    );
};

export type TPatternCell = {
    symbol: string;
    market_name: string;
    b: number;
    rate: number;
    expected: number;
    z: number;
};

export type TPatternScan = {
    cells: TPatternCell[];
    /** Cells beyond ±2 standard deviations. */
    unusual: number;
    /** How many cells would be beyond ±2 by pure chance. */
    expected_by_chance: number;
    strongest: TPatternCell[];
    ticks: number;
};

/** Over 0..8 on every market; Under b is the mirror of Over (b - 1), so this covers all 18 contracts. */
export const scanPatterns = (markets: TMarket[], window: number): TPatternScan => {
    const cells: TPatternCell[] = [];
    let ticks = 0;
    markets.forEach(m => {
        ticks += Math.min(m.digits.length, window);
        OU_PAIRS.forEach(pair => {
            const r = readContract(m, pair.over, window);
            if (!r.sample) return;
            cells.push({
                symbol: m.symbol,
                market_name: m.name,
                b: pair.b,
                rate: r.rate,
                expected: pair.over.win_probability,
                z: r.z,
            });
        });
    });
    const unusual = cells.filter(c => Math.abs(c.z) >= 2).length;
    return {
        cells,
        unusual,
        expected_by_chance: Math.round(cells.length * 0.0455),
        strongest: [...cells].sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 5),
        ticks,
    };
};

export type TTopPick = {
    suggestion: TSuggestion;
    /** Outcome with the protective stops below switched on. */
    outcome: TOutcome;
    max_losing_streak: number;
    min_probability: number;
    switch_after: number;
    rotate_entry: boolean;
    payout_factor: number;
    entry: TOUEntry;
};

const STREAK_STOPS = [2, 3, 4, 5, 6];

/**
 * The single setup with the highest chance of reaching the goal, plus a full set
 * of bot parameters. The losing-streak stop is the tightest one that costs at
 * most 3 points of probability, so the pick stays protective rather than reckless.
 */
export const buildTopPick = (goal: TGoal, pairs: TPricedPair[], runs = 1200): TTopPick | null => {
    const [best] = suggestParameters({ ...goal, max_losing_streak: 0 }, pairs, START, runs);
    if (!best) return null;

    const base = best.outcome.p_target;
    let max_losing_streak = 0;
    let outcome = best.outcome;
    for (const streak of STREAK_STOPS) {
        const candidate = simulateSession({ ...best.plan, max_losing_streak: streak }, START, runs * 2);
        if (candidate.p_target >= base - 0.03) {
            max_losing_streak = streak;
            outcome = candidate;
            break;
        }
    }

    const plan = { ...best.plan, max_losing_streak };
    return {
        suggestion: { ...best, plan, outcome },
        outcome,
        max_losing_streak,
        // Bail out once the goal has become a long shot: about a third of the starting chance
        min_probability: Math.min(
            0.3,
            Math.max(0.1, Number((Math.round((outcome.p_target * 0.35) / 0.05) * 0.05).toFixed(2)))
        ),
        switch_after: max_losing_streak === 0 ? 2 : Math.max(1, Math.min(2, max_losing_streak - 1)),
        rotate_entry: true,
        payout_factor: 0.98,
        // Trade either side of the pair, right after it loses once: frequent entries on every market
        entry: { ...DEFAULT_OU_ENTRY, mode: 'cold', sides: 'pair', streak: 1 },
    };
};
