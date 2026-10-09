jest.mock('@/external/bot-skeleton', () => ({ api_base: { api: null, is_authorized: false, account_info: {} } }));
jest.mock('@/components/shared/utils/config/config', () => ({
    isProduction: () => true,
    WS_SERVERS: { PRODUCTION: 'wss://example.test', STAGING: 'wss://example.test' },
}));

import { worstCaseLoss } from '../auto-trader';
import { defaultParams, STRATEGIES } from '../strategies';
import { TMarket } from '../../scanner/scanner-feed';

const market = (digits: number[], quotes: number[] = []): TMarket => ({
    symbol: 'R_100',
    name: 'Volatility 100 Index',
    decimals: 2,
    digits,
    quotes,
    last_quote: quotes[quotes.length - 1] ?? null,
    last_epoch: 0,
    is_seeded: true,
    pending: [],
});

const get = (key: string) => STRATEGIES.find(s => s.key === key)!;

describe('parity_reversal', () => {
    const s = get('parity_reversal');
    const params = { ...defaultParams(s), streak: 3 };

    it('buys the opposite parity after a streak', () => {
        expect(s.decide(market([2, 1, 3, 5]), params)?.contract_type).toBe('DIGITEVEN');
        expect(s.decide(market([1, 2, 4, 6]), params)?.contract_type).toBe('DIGITODD');
    });

    it('waits when there is no streak or not enough data', () => {
        expect(s.decide(market([1, 2, 3]), params)).toBeNull();
        expect(s.decide(market([1, 3]), params)).toBeNull();
    });
});

describe('cold_side', () => {
    const s = get('cold_side');

    it('buys Over after the side lost N times', () => {
        const params = { ...defaultParams(s), direction: 1, barrier: 2, streak: 2 };
        expect(s.decide(market([9, 0, 2]), params)).toEqual({ contract_type: 'DIGITOVER', barrier: 2, duration: 1 });
        expect(s.decide(market([0, 3]), params)).toBeNull();
    });

    it('supports Under', () => {
        const params = { ...defaultParams(s), direction: 0, barrier: 7, streak: 1 };
        expect(s.decide(market([9]), params)?.contract_type).toBe('DIGITUNDER');
        expect(s.decide(market([3]), params)).toBeNull();
    });
});

describe('differs_last', () => {
    it('predicts the last digit will not repeat', () => {
        const s = get('differs_last');
        expect(s.decide(market([4, 7]), defaultParams(s))).toEqual({
            contract_type: 'DIGITDIFF',
            barrier: 7,
            duration: 1,
        });
    });
});

describe('momentum', () => {
    const s = get('momentum');
    const params = { ...defaultParams(s), streak: 3 };

    it('follows a run of rising or falling ticks', () => {
        expect(s.decide(market([], [1, 2, 3, 4]), params)?.contract_type).toBe('CALL');
        expect(s.decide(market([], [4, 3, 2, 1]), params)?.contract_type).toBe('PUT');
    });

    it('waits on mixed or flat moves', () => {
        expect(s.decide(market([], [1, 2, 1, 2]), params)).toBeNull();
        expect(s.decide(market([], [1, 1, 1, 1]), params)).toBeNull();
    });
});

describe('worstCaseLoss', () => {
    it('sums every stake in a fully losing martingale run', () => {
        expect(worstCaseLoss(1, 2, 3)).toBe(15);
        expect(worstCaseLoss(1, 1, 3)).toBe(1);
    });
});
