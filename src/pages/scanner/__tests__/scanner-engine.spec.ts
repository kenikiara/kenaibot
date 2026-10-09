import {
    backtestStreakRule,
    breakEvenRate,
    classifyZ,
    computeWindowStats,
    expectedReturn,
    getLastDigit,
    getSides,
    pipStepToDecimals,
    zScore,
} from '../scanner-engine';

describe('getLastDigit', () => {
    it('pads trailing zeros to pip size before reading the digit', () => {
        expect(getLastDigit(1234.5, 2)).toBe(0);
        expect(getLastDigit(1234, 2)).toBe(0);
        expect(getLastDigit(81.6528, 4)).toBe(8);
        expect(getLastDigit(624.93, 2)).toBe(3);
    });
});

describe('pipStepToDecimals', () => {
    it('converts active_symbols pip steps to decimal places', () => {
        expect(pipStepToDecimals(0.01)).toBe(2);
        expect(pipStepToDecimals(0.001)).toBe(3);
        expect(pipStepToDecimals(0.0001)).toBe(4);
        expect(pipStepToDecimals(3)).toBe(3);
        expect(pipStepToDecimals(undefined)).toBe(2);
    });
});

describe('getSides', () => {
    it('returns even and odd at 50%', () => {
        const sides = getSides('even_odd', 5);
        expect(sides.map(s => s.contract_type)).toEqual(['DIGITEVEN', 'DIGITODD']);
        expect(sides[0].wins(4)).toBe(true);
        expect(sides[1].wins(4)).toBe(false);
    });

    it('builds over/under around the barrier with correct expectations', () => {
        const [over, under] = getSides('over_under', 5);
        expect(over.label).toBe('Over 5');
        expect(over.expected).toBeCloseTo(0.4);
        expect(over.wins(5)).toBe(false);
        expect(over.wins(6)).toBe(true);
        expect(under.expected).toBeCloseTo(0.5);
        expect(under.wins(5)).toBe(false);
        expect(under.wins(4)).toBe(true);
    });

    it('omits contracts that cannot exist at the edges', () => {
        expect(getSides('over_under', 0).map(s => s.label)).toEqual(['Over 0']);
        expect(getSides('over_under', 9).map(s => s.label)).toEqual(['Under 9']);
    });
});

describe('zScore / classifyZ', () => {
    it('is zero when the observed rate matches expectation', () => {
        expect(zScore(50, 100, 0.5)).toBe(0);
    });

    it('scales with sample size', () => {
        expect(zScore(60, 100, 0.5)).toBeCloseTo(2);
        expect(zScore(600, 1000, 0.5)).toBeCloseTo(6.32, 1);
    });

    it('labels significance bands', () => {
        expect(classifyZ(1.5)).toBe('normal');
        expect(classifyZ(-2.4)).toBe('unusual');
        expect(classifyZ(3.1)).toBe('rare');
    });
});

describe('computeWindowStats', () => {
    const sides = getSides('even_odd', 5);

    it('only looks at the requested window', () => {
        const digits = [1, 1, 1, 1, 2, 4, 6, 8];
        const stats = computeWindowStats(digits, 4, sides);
        expect(stats.sample_size).toBe(4);
        expect(stats.sides[0].rate).toBe(1);
        expect(stats.digit_counts[1]).toBe(0);
    });

    it('tracks current and longest runs', () => {
        const digits = [1, 3, 5, 2, 7, 9, 4, 6];
        const [even, odd] = computeWindowStats(digits, 100, sides).sides;
        expect(even.win_streak).toBe(2);
        expect(even.loss_streak).toBe(0);
        expect(even.longest_loss_streak).toBe(3);
        expect(odd.loss_streak).toBe(2);
    });

    it('picks the side furthest from expectation as leader', () => {
        const [over, under] = getSides('over_under', 5);
        const stats = computeWindowStats([9, 9, 9, 9, 9, 0, 0, 0, 0, 0], 10, [over, under]);
        // Over 5 hit 50% vs 40% expected; Under 5 hit 50% vs 50% expected
        expect(stats.leader?.side.key).toBe(over.key);
    });
});

describe('backtestStreakRule', () => {
    const [even] = getSides('even_odd', 5);

    it('buys after the trigger run and scores the next tick', () => {
        // two odds then even (win), two odds then two more odds (both triggered, both lose)
        const digits = [1, 3, 2, 5, 7, 9, 1];
        const result = backtestStreakRule(digits, even, 2, 1.95);
        expect(result.trades).toBe(3);
        expect(result.wins).toBe(1);
        expect(result.net).toBeCloseTo(1.95 - 3);
    });

    it('reports no trades when the trigger never fires', () => {
        expect(backtestStreakRule([2, 4, 6], even, 1, 1.95).trades).toBe(0);
    });
});

describe('payout math', () => {
    it('computes break-even and expected return', () => {
        expect(breakEvenRate(1.95)).toBeCloseTo(0.5128, 3);
        expect(expectedReturn(1.95, 0.5)).toBeCloseTo(-0.025);
        expect(expectedReturn(2.43, 0.4)).toBeCloseTo(-0.028);
    });
});
