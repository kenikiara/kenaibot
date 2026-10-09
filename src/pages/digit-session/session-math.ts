/**
 * Session-level odds for digit contracts. Each trade has a fixed win chance set
 * by the RNG (50% for Even/Odd, 70% for Over 2, ...), so the only things a trader
 * controls are which contract, how many trades, how stakes are sized, and when
 * to stop. This simulates those choices to estimate the chance of reaching a
 * profit target before a stop.
 */

export const WIN_PROBABILITY = 0.5;
export const MIN_STAKE = 0.35;

export type TStakePlan = 'flat' | 'recovery';

export type TSessionPlan = {
    trades: number;
    stake: number;
    stake_plan: TStakePlan;
    target: number;
    stop_loss: number;
    /** 0 disables the losing-streak stop. */
    max_losing_streak: number;
    /** Largest single stake allowed (0 = no cap beyond the stop loss). */
    max_stake?: number;
    /** Total return per 1 staked, e.g. 1.95. */
    payout: number;
    /** Chance of winning one trade; defaults to 50% (Even/Odd). */
    win_probability?: number;
};

export type TSessionState = { net: number; trades_done: number; losing_streak: number };

export type TOutcome = {
    p_target: number;
    p_stopped: number;
    p_ahead: number;
    avg_net: number;
    avg_trades: number;
    /** 5th percentile result: a bad but realistic session. */
    bad_case: number;
};

export const START: TSessionState = { net: 0, trades_done: 0, losing_streak: 0 };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Stake for the next trade, or null when the loss budget can't cover a minimum stake.
 * Recovery ("bold play") stakes just enough that one win reaches the target, which
 * is the stake plan that maximises the chance of reaching a goal in a game with a
 * house edge, at the cost of bigger individual losses.
 */
export const nextStake = (plan: TSessionPlan, net: number): number | null => {
    const budget = round2(plan.stop_loss + net);
    let stake = plan.stake;
    if (plan.stake_plan === 'recovery') {
        const needed = (plan.target - net) / (plan.payout - 1);
        stake = Math.max(plan.stake, needed);
    }
    if (plan.max_stake) stake = Math.min(stake, Math.max(plan.max_stake, plan.stake));
    stake = round2(Math.min(stake, budget));
    return stake >= MIN_STAKE ? stake : null;
};

/** Small deterministic PRNG so the numbers on screen don't flicker between renders. */
export const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const simulateSession = (plan: TSessionPlan, from: TSessionState = START, runs = 10000, seed = 42): TOutcome => {
    const rand = mulberry32(seed);
    const p = plan.win_probability ?? WIN_PROBABILITY;
    const results: number[] = new Array(runs);
    let hits = 0;
    let stops = 0;
    let ahead = 0;
    let total_net = 0;
    let total_trades = 0;

    for (let r = 0; r < runs; r++) {
        let { net, trades_done: done, losing_streak: streak } = from;
        let stopped = false;
        while (done < plan.trades && net < plan.target) {
            const stake = nextStake(plan, net);
            if (stake === null) {
                stopped = true;
                break;
            }
            const won = rand() < p;
            net = round2(net + (won ? stake * (plan.payout - 1) : -stake));
            streak = won ? 0 : streak + 1;
            done++;
            if (net <= -plan.stop_loss || (plan.max_losing_streak > 0 && streak >= plan.max_losing_streak)) {
                stopped = true;
                break;
            }
        }
        if (net >= plan.target) hits++;
        else if (stopped) stops++;
        if (net > 0) ahead++;
        total_net += net;
        total_trades += done - from.trades_done;
        results[r] = net;
    }

    results.sort((a, b) => a - b);
    return {
        p_target: hits / runs,
        p_stopped: stops / runs,
        p_ahead: ahead / runs,
        avg_net: total_net / runs,
        avg_trades: total_trades / runs,
        bad_case: results[Math.floor(runs * 0.05)],
    };
};

export const TRADE_COUNTS = [1, 2, 3, 5, 8, 10, 15, 20, 30, 50];

export type TTradeCountRow = { trades: number; outcome: TOutcome };

/** Outcome for each candidate trade count, plus the count with the best chance of reaching the target. */
export const compareTradeCounts = (plan: TSessionPlan, runs = 4000) => {
    const rows: TTradeCountRow[] = TRADE_COUNTS.map(trades => ({
        trades,
        outcome: simulateSession({ ...plan, trades }, START, runs),
    }));
    // Highest chance of hitting the target; ties go to fewer trades (less house edge paid)
    const best = rows.reduce((a, b) => (b.outcome.p_target > a.outcome.p_target + 0.005 ? b : a));
    return { rows, best: best.trades };
};
