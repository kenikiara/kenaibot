jest.mock('@/external/bot-skeleton', () => ({ api_base: { api: null, is_authorized: false, account_info: {} } }));
jest.mock('@/components/shared/utils/config/config', () => ({
    isProduction: () => true,
    WS_SERVERS: { PRODUCTION: 'wss://example.test', STAGING: 'wss://example.test' },
}));

import { evenOddSignal, overUnderShares, riseFallStats } from '@/pages/ai-analysis/analysis';
import { lossesSurvivable, totalRisked } from '@/pages/risk-management/risk-management';
import { TMarket } from '@/pages/scanner/scanner-feed';
import { scanMarkets } from '../market-scan';

const market = (symbol: string, digits: number[], quotes: number[] = []): TMarket => ({
    symbol,
    name: symbol,
    decimals: 2,
    digits,
    quotes,
    last_quote: quotes[quotes.length - 1] ?? null,
    last_epoch: 0,
    is_seeded: true,
    pending: [],
});

/** 1000 digits where each digit appears `weights[d]` times per 100. */
const weighted = (weights: number[]) => {
    const block = weights.flatMap((w, d) => Array(w).fill(d));
    return Array.from({ length: 1000 }, (_, i) => block[i % block.length]);
};

describe('scanMarkets', () => {
    it('ignores markets with fewer than 400 ticks', () => {
        expect(scanMarkets([market('R_10', [1, 2, 3])], 'evenodd')).toEqual({ signals: [], scanned: 0 });
    });

    it('finds Under 7 when 7, 8 and 9 are all under 10%', () => {
        const digits = weighted([12, 12, 12, 12, 12, 12, 12, 6, 5, 5]);
        const { signals } = scanMarkets([market('1HZ50V', digits)], 'overunder');
        expect(signals[0].direction).toBe('Under 7');
        expect(signals[0].plan).toEqual({ bot: 'undersingle', barrier: 7 });
    });

    it('uses the recovery bot for Over 2 on a non-1s market', () => {
        const digits = weighted([5, 5, 5, 5, 13, 13, 13, 14, 14, 13]);
        const { signals } = scanMarkets([market('R_75', digits)], 'overunder');
        expect(signals[0].plan.bot).toBe('magical');
    });

    it('picks the leading parity for Even/Odd', () => {
        const digits = weighted([11, 9, 11, 9, 11, 9, 11, 9, 11, 9]);
        expect(scanMarkets([market('R_10', digits)], 'evenodd').signals[0].direction).toBe('Even');
    });
});

describe('AI Analysis helpers', () => {
    it('reports an even streak of 4+', () => {
        const signal = evenOddSignal([...Array(20).fill(1), 2, 4, 6, 8]);
        expect(signal.side).toBe('even');
        expect(signal.headline).toMatch(/EVEN streak of 4/);
    });

    it('computes over/under shares', () => {
        expect(overUnderShares([0, 5, 9, 4], 4, 5)).toEqual({ over_pct: 50, under_pct: 50 });
    });

    it('counts rises and falls, ignoring unchanged ticks', () => {
        const stats = riseFallStats([1, 2, 2, 3, 1]);
        expect(stats.moves).toBe(3);
        expect(stats.rise_pct).toBeCloseTo(66.67, 1);
        expect(stats.direction).toBe('fall');
    });
});

describe('Risk Management maths', () => {
    it('sums a martingale ladder', () => {
        expect(totalRisked(10, 2, 3)).toBe(70);
        expect(totalRisked(10, 1, 3)).toBe(30);
    });

    it('counts losses a balance can survive', () => {
        expect(lossesSurvivable(100, 10, 1)).toBe(10);
        expect(lossesSurvivable(100, 10, 2)).toBe(3);
    });
});
