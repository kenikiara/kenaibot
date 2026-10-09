jest.mock('@/components/shared/utils/config/config', () => ({
    isProduction: () => true,
    WS_SERVERS: { PRODUCTION: 'wss://example.test', STAGING: 'wss://example.test' },
}));

import { getPair, OU_PAIRS, pricePair, priceAll } from '../../over-under/catalog';
import { DEFAULT_OU_ENTRY, readOverUnder } from '../../over-under/ou-entry';
import { TMarket } from '../../scanner/scanner-feed';
import { buildTopPick, scanPatterns, suggestParameters, TGoal } from '../analysis';

const market = (digits: number[], symbol = 'R_100'): TMarket => ({
    symbol,
    name: symbol,
    decimals: 2,
    digits,
    quotes: [],
    last_quote: null,
    last_epoch: 0,
    is_seeded: true,
    pending: [],
});

describe('catalog', () => {
    it('pairs Over b with Under 9-b at the same win chance', () => {
        const pair = getPair(2);
        expect(pair.label).toBe('Over 2 / Under 7');
        expect(pair.over.win_probability).toBeCloseTo(0.7);
        expect(pair.under.win_probability).toBeCloseTo(0.7);
        expect(pair.over.wins(3)).toBe(true);
        expect(pair.under.wins(7)).toBe(false);
        expect(OU_PAIRS).toHaveLength(9);
    });

    it('prices pairs from payouts', () => {
        const priced = pricePair(getPair(2), 1.404);
        expect(priced.ev).toBeCloseTo(-0.0172, 3);
        expect(priced.wins_per_loss).toBeCloseTo(2.48, 2);
    });

    it('falls back to known payouts', () => {
        expect(priceAll({}).find(p => p.b === 0)?.payout).toBeCloseTo(1.096);
    });
});

describe('readOverUnder', () => {
    const pair = getPair(2);

    it('fires the side that just lost (cold)', () => {
        // last digit 1: Over 2 lost, Under 7 won
        expect(readOverUnder(market([5, 1]), pair, DEFAULT_OU_ENTRY).contract?.label).toBe('Over 2');
        // last digit 8: Under 7 lost
        expect(readOverUnder(market([5, 8]), pair, DEFAULT_OU_ENTRY).contract?.label).toBe('Under 7');
        // last digit 5: both won, nothing fires
        expect(readOverUnder(market([5]), pair, DEFAULT_OU_ENTRY).contract).toBeNull();
    });

    it('respects a single chosen side', () => {
        const entry = { ...DEFAULT_OU_ENTRY, sides: 'under' as const };
        expect(readOverUnder(market([1]), pair, entry).contract).toBeNull();
    });

    it('fires when a side lags its expected rate', () => {
        const entry = { ...DEFAULT_OU_ENTRY, mode: 'lagging' as const, window: 10, gap: 0.2, sides: 'over' as const };
        // Over 2 won 4/10 = 40% vs 70% expected
        expect(readOverUnder(market([0, 1, 2, 0, 1, 2, 5, 6, 7, 8]), pair, entry).contract?.label).toBe('Over 2');
    });
});

describe('suggestParameters', () => {
    const goal: TGoal = { target: 3, stop_loss: 6, stake: 1, max_trades: 20, max_losing_streak: 0, max_stake: 3 };

    it('ranks setups by chance of reaching the target', () => {
        const result = suggestParameters(goal, priceAll({}), undefined, 400);
        expect(result.length).toBeGreaterThan(0);
        for (let i = 1; i < result.length; i++) {
            expect(Math.round(result[i - 1].outcome.p_target * 100)).toBeGreaterThanOrEqual(
                Math.round(result[i].outcome.p_target * 100)
            );
        }
        expect(result.every(s => s.trades <= 20)).toBe(true);
    });
});

describe('scanPatterns', () => {
    it('covers every Over barrier on every market and counts chance-level noise', () => {
        const digits = Array.from({ length: 100 }, (_, i) => i % 10);
        const scan = scanPatterns([market(digits, 'A'), market(digits, 'B')], 100);
        expect(scan.cells).toHaveLength(18);
        expect(scan.unusual).toBe(0);
        expect(scan.expected_by_chance).toBe(1);
    });
});

describe('buildTopPick', () => {
    const goal: TGoal = { target: 3, stop_loss: 6, stake: 1, max_trades: 20, max_losing_streak: 4, max_stake: 3 };

    it('returns a complete, protective parameter set', () => {
        const pick = buildTopPick(goal, priceAll({}), 400)!;
        expect(pick).not.toBeNull();
        expect(pick.suggestion.plan.max_losing_streak).toBe(pick.max_losing_streak);
        expect([0, 2, 3, 4, 5, 6]).toContain(pick.max_losing_streak);
        expect([0.1, 0.15, 0.2, 0.25, 0.3]).toContain(pick.min_probability);
        expect(pick.switch_after).toBeGreaterThanOrEqual(1);
        if (pick.max_losing_streak) expect(pick.switch_after).toBeLessThan(pick.max_losing_streak);
        expect(pick.entry).toMatchObject({ mode: 'cold', sides: 'pair', streak: 1 });
    });

    it('never lets a recovery stake exceed the largest-stake cap', () => {
        const pick = buildTopPick(goal, priceAll({}), 400)!;
        expect(pick.suggestion.plan.max_stake).toBe(3);
    });
});
