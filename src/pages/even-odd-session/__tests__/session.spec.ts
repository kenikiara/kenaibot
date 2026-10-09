import { TMarket } from '../../scanner/scanner-feed';
import { readMarket, TEntryConfig } from '../entry-rules';
import { compareTradeCounts, nextStake, simulateSession, TSessionPlan } from '../../digit-session/session-math';

const plan: TSessionPlan = {
    trades: 10,
    stake: 1,
    stake_plan: 'flat',
    target: 3,
    stop_loss: 5,
    max_losing_streak: 0,
    payout: 1.95,
};

const market = (digits: number[]): TMarket => ({
    symbol: 'R_100',
    name: 'Volatility 100 Index',
    decimals: 2,
    digits,
    quotes: [],
    last_quote: null,
    last_epoch: 0,
    is_seeded: true,
    pending: [],
});

const entry: TEntryConfig = { rule: 'streak', streak: 3, window: 10, threshold: 0.7, fixed_side: 0 };

describe('nextStake', () => {
    it('keeps a flat stake while the loss budget allows', () => {
        expect(nextStake(plan, 0)).toBe(1);
        expect(nextStake(plan, -4.5)).toBe(0.5);
        expect(nextStake(plan, -4.8)).toBeNull();
    });

    it('sizes recovery stakes so one win reaches the target, capped by the budget', () => {
        const recovery = { ...plan, stake_plan: 'recovery' as const };
        expect(nextStake(recovery, 0)).toBeCloseTo(3.16, 2);
        expect(nextStake(recovery, -2)).toBe(3);
        expect(nextStake(recovery, 2.9)).toBe(1);
    });
});

describe('simulateSession', () => {
    it('is deterministic for a given seed', () => {
        expect(simulateSession(plan, undefined, 2000, 7)).toEqual(simulateSession(plan, undefined, 2000, 7));
    });

    it('loses on average because of the house edge', () => {
        expect(simulateSession({ ...plan, target: 1000, stop_loss: 1000 }).avg_net).toBeLessThan(0);
    });

    it('gives a one-trade session about a 50% chance of a small target', () => {
        const outcome = simulateSession({ ...plan, trades: 1, target: 0.5 });
        expect(outcome.p_target).toBeGreaterThan(0.47);
        expect(outcome.p_target).toBeLessThan(0.53);
    });

    it('raises the chance of hitting a big target with recovery stakes', () => {
        const flat = simulateSession(plan);
        const recovery = simulateSession({ ...plan, stake_plan: 'recovery' });
        expect(recovery.p_target).toBeGreaterThan(flat.p_target);
    });

    it('never reports a session as both stopped and on target', () => {
        const outcome = simulateSession({ ...plan, max_losing_streak: 3 });
        expect(outcome.p_target + outcome.p_stopped).toBeLessThanOrEqual(1);
    });
});

describe('compareTradeCounts', () => {
    it('recommends one of the candidate trade counts', () => {
        const { rows, best } = compareTradeCounts(plan, 1000);
        expect(rows.map(r => r.trades)).toContain(best);
    });
});

describe('readMarket', () => {
    it('fires the opposite side after a parity streak', () => {
        expect(readMarket(market([2, 1, 3, 5]), entry).side).toBe('DIGITEVEN');
        expect(readMarket(market([2, 1, 3]), entry).readiness).toBeCloseTo(2 / 3);
    });

    it('fires the lighter side on an imbalance', () => {
        const config = { ...entry, rule: 'imbalance' as const };
        const reading = readMarket(market([1, 3, 5, 7, 9, 1, 3, 2, 4, 6]), config);
        expect(reading.side).toBe('DIGITEVEN');
        expect(readMarket(market([1, 2, 3]), config).side).toBeNull();
    });

    it('always fires a fixed side', () => {
        expect(readMarket(market([5]), { ...entry, rule: 'fixed', fixed_side: 1 }).side).toBe('DIGITODD');
    });
});

describe('max_stake', () => {
    it('caps recovery stakes', () => {
        const capped = { ...plan, stake_plan: 'recovery' as const, max_stake: 2 };
        expect(nextStake(capped, 0)).toBe(2);
    });
});
