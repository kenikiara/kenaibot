jest.mock('@/external/bot-skeleton', () => ({
    api_base: { api: null, is_authorized: false, account_info: {} },
    load: jest.fn(),
    save_types: { UNSAVED: 'unsaved' },
    ApiHelpers: { instance: null },
}));
jest.mock('@/components/shared/utils/config/config', () => ({
    isProduction: () => true,
    WS_SERVERS: { PRODUCTION: 'wss://example.test', STAGING: 'wss://example.test' },
}));
jest.mock('@/utils/bot-workspace', () => ({
    hasLoadedBot: () => false,
    setBotNumber: jest.fn(),
    setWorkspaceMarket: jest.fn(),
}));

import { TMarket } from '@/pages/scanner/scanner-feed';
import { TLegResult } from '../engine/execute';
import { nextStake } from '../engine/session';
import { TMoneySettings, TOrder, TOutcome, TRuntime, TStrategy } from '../engine/types';
import { bestAccumulators } from '../strategies/accumulators';
import {
    onlyUpsDowns,
    over4,
    percentageEvenOdd,
    percentageOverUnder,
    rcEvenOdd,
    rcOver4Under5,
    rcRiseFall,
} from '../strategies/patterns';
import { aMatchesDiffers, matchesSignalProvider, multipleMatches, over5Under4 } from '../strategies/scanners';
import { demoEvenOdd, demoOver5, fastOverUnder, multimarket } from '../strategies/virtual-gate';
import { AUTO_STRATEGIES } from '../strategies';
import { osman } from '../strategies/osman';

const MONEY: TMoneySettings = {
    symbol: 'R_100',
    stake: 1,
    martingale: 2,
    martingale_mode: 'normal',
    take_profit: 100,
    stop_loss_mode: 'amount',
    stop_loss: 100,
    max_losses: 4,
};

const makeMarket = (symbol: string, digits: number[], quotes: number[] = []): TMarket => ({
    symbol,
    name: symbol,
    decimals: 2,
    digits,
    quotes,
    last_quote: quotes[quotes.length - 1] ?? 100,
    last_epoch: 0,
    is_seeded: true,
    pending: [],
});

/** Feeds `digits` one tick at a time to a strategy and returns the first order (and its tick index). */
const feed = (
    runtime: TRuntime,
    symbol: string,
    digits: number[],
    options: { history?: number[]; can_trade?: boolean } = {}
): { order: TOrder | null; index: number } => {
    const history = [...(options.history ?? [])];
    for (let i = 0; i < digits.length; i++) {
        history.push(digits[i]);
        const market = makeMarket(symbol, [...history]);
        const order = runtime.onTick({
            market,
            markets: new Map([[symbol, market]]),
            can_trade: options.can_trade ?? true,
            money: MONEY,
            virtual: () => undefined,
            log: () => undefined,
        });
        if (order) return { order, index: i };
    }
    return { order: null, index: -1 };
};

const outcome = (order: TOrder, is_win: boolean): TOutcome => {
    const results: TLegResult[] = order.legs.map(leg => ({
        leg,
        buy_price: 1,
        profit: is_win ? 0.9 : -1,
        is_win,
    }));
    return { order, results, profit: results.reduce((t, r) => t + r.profit, 0), is_win, filled: true };
};

const create = (strategy: TStrategy, settings: Record<string, unknown> = {}) =>
    strategy.create({ ...strategy.defaults, ...settings }, MONEY);

describe('nextStake', () => {
    it('multiplies after a loss and resets after a win in normal mode', () => {
        const split = { step: 0 };
        expect(nextStake(1, MONEY, false, split)).toBe(2);
        expect(nextStake(2, MONEY, false, split)).toBe(4);
        expect(nextStake(4, MONEY, true, split)).toBe(1);
    });

    it('cycles 1x, 2x, 3x of the base stake in split mode', () => {
        const money = { ...MONEY, martingale_mode: 'split' as const };
        const split = { step: 0 };
        expect(nextStake(1, money, false, split)).toBe(2);
        expect(nextStake(2, money, false, split)).toBe(3);
        expect(nextStake(3, money, false, split)).toBe(1);
        expect(nextStake(1, money, false, split)).toBe(2);
        expect(nextStake(2, money, true, split)).toBe(1);
    });
});

describe('registry', () => {
    it('lists all 18 strategies with unique ids and valid defaults', () => {
        expect(AUTO_STRATEGIES).toHaveLength(18);
        expect(new Set(AUTO_STRATEGIES.map(s => s.id)).size).toBe(18);
        AUTO_STRATEGIES.forEach(strategy => {
            strategy.fields.forEach(field => expect(strategy.defaults).toHaveProperty(field.key));
            const runtime = create(strategy);
            expect(runtime.symbols.length).toBeGreaterThan(0);
            expect(Array.isArray(runtime.status())).toBe(true);
        });
    });
});

describe('DemoOver5', () => {
    it('trades only after the set number of virtual losses, then returns to virtual after a win', () => {
        const runtime = create(demoOver5, { direction: 'over', barrier: 5, demo_count: 2 });
        // 1 and 3 lose for Over 5 → gate opens on the next tick
        const first = feed(runtime, 'R_100', [1, 3, 7]);
        expect(first.index).toBe(2);
        expect(first.order?.legs[0]).toMatchObject({ contract_type: 'DIGITOVER', barrier: 5 });
        runtime.onSettled?.(outcome(first.order!, true), MONEY);
        expect(feed(runtime, 'R_100', [9]).order).toBeNull();
    });

    it('switches to the recovery side after a real loss', () => {
        const runtime = create(demoOver5, {
            demo_count: 0,
            recovery_enabled: true,
            recovery_direction: 'under',
            recovery_barrier: 6,
            recovery_threshold: 0,
        });
        const first = feed(runtime, 'R_100', [2]);
        runtime.onSettled?.(outcome(first.order!, false), MONEY);
        const next = feed(runtime, 'R_100', [2]);
        expect(next.order?.legs[0]).toMatchObject({ contract_type: 'DIGITUNDER', barrier: 6 });
    });
});

describe('Fast Over/Under', () => {
    it('waits once for the entry digit, then trades every tick', () => {
        const runtime = create(fastOverUnder, { entry_point: 5, main_direction: 'under', main_barrier: 8 });
        const first = feed(runtime, 'R_100', [1, 2, 5]);
        expect(first.index).toBe(2);
        expect(first.order?.legs[0]).toMatchObject({ contract_type: 'DIGITUNDER', barrier: 8 });
        runtime.onSettled?.(outcome(first.order!, true), MONEY);
        expect(feed(runtime, 'R_100', [3]).index).toBe(0);
    });

    it('in virtual mode steps main → immediate → recovery on losses', () => {
        const runtime = create(fastOverUnder, {
            mode: 'virtual',
            main_direction: 'over',
            main_barrier: 5,
            main_virtual_losses: 2,
            immediate_direction: 'over',
            immediate_barrier: 2,
            recovery_direction: 'under',
            recovery_barrier: 7,
            recovery_virtual_losses: 1,
        });
        const main = feed(runtime, 'R_100', [1, 2]);
        expect(main.order?.legs[0]).toMatchObject({ contract_type: 'DIGITOVER', barrier: 5 });
        runtime.onSettled?.(outcome(main.order!, false), MONEY);
        const immediate = feed(runtime, 'R_100', [4]);
        expect(immediate.order?.legs[0]).toMatchObject({ contract_type: 'DIGITOVER', barrier: 2 });
        runtime.onSettled?.(outcome(immediate.order!, false), MONEY);
        const recovery = feed(runtime, 'R_100', [9]);
        expect(recovery.order?.legs[0]).toMatchObject({ contract_type: 'DIGITUNDER', barrier: 7 });
    });
});

describe('DemoEvenOdd', () => {
    it('alternates sides every N trades in "both" mode after the entry digit', () => {
        const runtime = create(demoEvenOdd, { entry_direction: 'both', first_trade: 'odd', consecutive: 2, entry_point: 0 });
        const sides: string[] = [];
        let order = feed(runtime, 'R_100', [3, 0]).order;
        for (let i = 0; i < 5 && order; i++) {
            sides.push(order.legs[0].contract_type);
            order = feed(runtime, 'R_100', [1]).order;
        }
        expect(sides).toEqual(['DIGITODD', 'DIGITODD', 'DIGITEVEN', 'DIGITEVEN', 'DIGITODD']);
    });
});

describe('Multimarket', () => {
    it('trades the market that reaches the virtual loss count first', () => {
        const runtime = create(multimarket, { markets: ['1HZ10V'], direction: 'over', barrier: 5, demo_count: 3 });
        const result = feed(runtime, '1HZ10V', [1, 2, 3]);
        expect(result.index).toBe(2);
        expect(result.order?.legs[0]).toMatchObject({ symbol: '1HZ10V', contract_type: 'DIGITOVER', barrier: 5 });
    });

    it('needs the confirmation run when confirm is enabled', () => {
        const runtime = create(multimarket, {
            markets: ['1HZ10V'],
            demo_count: 2,
            confirm_enabled: true,
            confirm_count: 2,
        });
        // two losses arm stage 2, then two wins (non-trigger results) confirm
        const result = feed(runtime, '1HZ10V', [1, 2, 8, 9]);
        expect(result.index).toBe(3);
    });
});

describe('RC strategies', () => {
    it('RC Even/Odd trades once per run of the set length', () => {
        const runtime = create(rcEvenOdd, { tracking: 'single', consecutive: 3, strategy: 'CONTINUING' });
        const first = feed(runtime, 'R_100', [1, 2, 4, 6]);
        expect(first.order?.legs[0].contract_type).toBe('DIGITEVEN');
        expect(feed(runtime, 'R_100', [8], { history: [1, 2, 4, 6] }).order).toBeNull();
    });

    it('RC Even/Odd reversing buys the opposite parity', () => {
        const runtime = create(rcEvenOdd, { tracking: 'single', consecutive: 2, strategy: 'REVERSING' });
        expect(feed(runtime, 'R_100', [2, 1, 3]).order?.legs[0].contract_type).toBe('DIGITEVEN');
    });

    it('RC Even/Odd re-trades straight away after a loss when immediate recovery is on', () => {
        const runtime = create(rcEvenOdd, { tracking: 'single', consecutive: 2, immediate_recovery: true, recovery_count: 1 });
        const first = feed(runtime, 'R_100', [1, 2, 4]);
        runtime.onSettled?.(outcome(first.order!, false), MONEY);
        expect(feed(runtime, 'R_100', [7]).order?.reason).toMatch(/Immediate recovery/);
    });

    it('RC Over4/Under5 maps high runs to Over 4 and low runs to Under 5', () => {
        const high = create(rcOver4Under5, { tracking: 'single', over4_count: 2, under5_count: 2 });
        expect(feed(high, 'R_100', [1, 7, 8]).order?.legs[0]).toMatchObject({ contract_type: 'DIGITOVER', barrier: 4 });
        const low = create(rcOver4Under5, { tracking: 'single', over4_count: 2, under5_count: 2, strategy: 'REVERSING' });
        expect(feed(low, 'R_100', [9, 0, 3]).order?.legs[0]).toMatchObject({ contract_type: 'DIGITOVER', barrier: 4 });
    });

    it('RC Rise/Fall trades CALL after a run of rising ticks', () => {
        const runtime = create(rcRiseFall, { tracking: 'single', consecutive: 3 });
        const market = makeMarket('R_100', [1, 2, 3, 4, 5], [10, 9, 10, 11, 12]);
        const order = runtime.onTick({
            market,
            markets: new Map([['R_100', market]]),
            can_trade: true,
            money: MONEY,
            virtual: () => undefined,
            log: () => undefined,
        });
        expect(order?.legs[0].contract_type).toBe('CALL');
    });
});

describe('percentage strategies', () => {
    it('%Even/Odd trades the side at or above the threshold', () => {
        const runtime = create(percentageEvenOdd, { window: 4, threshold: 75 });
        expect(feed(runtime, 'R_10', [2, 4, 6, 1]).order?.legs[0].contract_type).toBe('DIGITEVEN');
    });

    it('%Over/Under takes the bet that beats its threshold by the most', () => {
        const runtime = create(percentageOverUnder, { risk_sets: ['low'], window: 50 });
        // all 9s: Over 1 / Over 2 win 100% (thresholds 80% / 70%) → Over 2 has the larger margin
        const result = feed(runtime, 'R_100', [9], { history: Array(49).fill(9) });
        expect(result.order?.legs[0]).toMatchObject({ contract_type: 'DIGITOVER', barrier: 2 });
    });
});

describe('pattern triggers', () => {
    it('Over4 fires after 4 low digits then a high one', () => {
        const runtime = create(over4);
        const result = feed(runtime, '1HZ10V', [1, 2, 3, 4, 7]);
        expect(result.index).toBe(4);
        expect(result.order?.legs[0]).toMatchObject({ contract_type: 'DIGITOVER', barrier: 4 });
    });

    it('Over5/Under4 fires a hedged pair on its digit trigger', () => {
        const runtime = create(over5Under4, { trigger: '2digits' });
        const result = feed(runtime, '1HZ50V', [1, 4, 5]);
        expect(result.order?.legs.map(leg => leg.label)).toEqual(['Over 5', 'Under 4']);
        expect(result.order?.as_batch).toBe(true);
    });

    it('OnlyUps/OnlyDowns buys Only Ups in a strong uptrend', () => {
        const runtime = create(onlyUpsDowns);
        const quotes = Array.from({ length: 101 }, (_, i) => 100 + (i % 4 === 0 ? -0.1 : i * 0.01));
        const market = makeMarket('R_50', [1], quotes);
        const order = runtime.onTick({
            market,
            markets: new Map([['R_50', market]]),
            can_trade: true,
            money: MONEY,
            virtual: () => undefined,
            log: () => undefined,
        });
        expect(order?.legs[0]).toMatchObject({ contract_type: 'RUNHIGH', duration: 2 });
    });
});

describe('matches strategies', () => {
    it('MultipleMatches buys one leg per chosen digit when the edge is significant', () => {
        const runtime = create(multipleMatches, { count: 2, direction: 'MATCH', min_edge: 2 });
        const digits = Array.from({ length: 1000 }, (_, i) => (i % 2 === 0 ? 3 : 7));
        const market = makeMarket('R_10', digits);
        const order = runtime.onTick({
            market,
            markets: new Map([['R_10', market]]),
            can_trade: true,
            money: MONEY,
            virtual: () => undefined,
            log: () => undefined,
        });
        // After a 7 the next digit has always been 3, so 3 leads the batch (the second digit is a tie-break)
        expect(order?.legs).toHaveLength(2);
        expect(order?.legs[0]).toMatchObject({ contract_type: 'DIGITMATCH', barrier: 3 });
        expect(order?.as_batch).toBe(true);
    });

    it('AMatchesDiffers enters on the trigger digit and keeps trying until a win (max 4)', () => {
        const runtime = create(aMatchesDiffers);
        // 0 and 1 each ~10.2% of the last 500, every other digit lower
        const base = Array.from({ length: 500 }, (_, i) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1][i % 12]);
        const tick = (digits: number[]) => {
            const market = makeMarket('R_25', digits);
            return runtime.onTick({
                market,
                markets: new Map([['R_25', market]]),
                can_trade: true,
                money: MONEY,
                virtual: () => undefined,
                log: () => undefined,
            });
        };
        tick(base);
        const status = runtime.status().join(' ');
        const trigger = Number(/waiting for (\d)/.exec(status)?.[1]);
        expect([0, 1]).toContain(trigger);
        const first = tick([...base, trigger]);
        expect(first?.legs[0].contract_type).toBe('DIGITMATCH');
        runtime.onSettled?.(outcome(first!, false), MONEY);
        const second = tick([...base, trigger, 5]);
        expect(second?.reason).toMatch(/Attempt 2\/4/);
    });

    it('Matches/Differs provider never places trades', () => {
        const runtime = create(matchesSignalProvider);
        expect(feed(runtime, 'R_100', Array(20).fill(1), { history: Array(1000).fill(2) }).order).toBeNull();
    });
});

describe('BestAccumulators', () => {
    it('buys a 5% accumulator with a take profit when a market is calm', () => {
        const runtime = create(bestAccumulators, { min_score: 50 });
        const quotes = Array.from({ length: 150 }, (_, i) => 1000 + Math.sin(i / 3) * 0.05);
        const market = makeMarket('R_10', [1], quotes);
        const order = runtime.onTick({
            market,
            markets: new Map([['R_10', market]]),
            can_trade: true,
            money: MONEY,
            virtual: () => undefined,
            log: () => undefined,
        });
        expect(order?.legs[0]).toMatchObject({ contract_type: 'ACCU', growth_rate: 0.05 });
        expect(order?.legs[0].take_profit).toBeGreaterThan(0);
        expect(order?.shouldSell).toBeDefined();
    });
});

describe('Osman', () => {
    /** 1000 digits with these counts, digit 4 first so the window can slide without touching the tested digits. */
    const history = (counts: Record<number, number>) => {
        const order = [4, 0, 1, 2, 3, 5, 6, 7, 8, 9];
        return order.flatMap(d => Array(counts[d]).fill(d));
    };
    // 0 and 1 at 9.5%, red bar on 2, green bar on 3; 9 at 10.5% so Under is off
    const OVER_READY = { 0: 95, 1: 95, 2: 80, 3: 120, 4: 100, 5: 100, 6: 100, 7: 105, 8: 100, 9: 105 };
    // 8 and 9 at 9.5%, red bar on 2, green bar on 3; 1 at 10.5% so Over is off
    const UNDER_READY = { 0: 100, 1: 105, 2: 80, 3: 120, 4: 100, 5: 100, 6: 100, 7: 105, 8: 95, 9: 95 };
    const single = { scope: 'single' };

    it('buys Over 1 when 0 and 1 are under 10.5% and the last digit is 5 or 6', () => {
        const runtime = create(osman, single);
        const { order, index } = feed(runtime, 'R_100', [2, 8, 5], { history: history(OVER_READY) });
        expect(index).toBe(2);
        expect(order?.legs[0]).toMatchObject({ contract_type: 'DIGITOVER', barrier: 1 });
    });

    it('buys Under 8 when 8 and 9 are under 10.5% and the last digit is 4, 7 or 9', () => {
        const runtime = create(osman, single);
        const { order, index } = feed(runtime, 'R_100', [5, 7], { history: history(UNDER_READY) });
        expect(index).toBe(1);
        expect(order?.legs[0]).toMatchObject({ contract_type: 'DIGITUNDER', barrier: 8 });
    });

    it('waits while a checked digit holds the red or green bar, and marks the failed condition', () => {
        // 0 is now the red bar (lowest)
        const runtime = create(osman, single);
        const counts = { ...OVER_READY, 0: 70, 2: 105, 7: 110 };
        expect(feed(runtime, 'R_100', [5, 6], { history: history(counts) }).order).toBeNull();
        expect(runtime.status().join(' ')).toMatch(/✗ 0 has the red bar/);
        // 5 is now the green bar
        const runtime2 = create(osman, single);
        const counts2 = { ...OVER_READY, 5: 125, 3: 95 };
        expect(feed(runtime2, 'R_100', [6, 5], { history: history(counts2) }).order).toBeNull();
    });

    it('respects the side setting', () => {
        const runtime = create(osman, { ...single, side: 'under' });
        expect(feed(runtime, 'R_100', [5, 6], { history: history(OVER_READY) }).order).toBeNull();
    });

    it('trades only the market with the highest win share', () => {
        const runtime = create(osman);
        // R_25: 0 and 1 at 9.0% → Over 1 wins 82%; R_10: 9.5% each → 81%
        const better = history({ ...OVER_READY, 0: 90, 1: 90, 7: 110, 9: 110 });
        const markets = new Map([
            ['R_10', makeMarket('R_10', [...history(OVER_READY), 5])],
            ['R_25', makeMarket('R_25', [...better, 6])],
        ]);
        const tick = (symbol: string) =>
            runtime.onTick({
                market: markets.get(symbol)!,
                markets,
                can_trade: true,
                money: MONEY,
                virtual: () => undefined,
                log: () => undefined,
            });
        expect(tick('R_10')).toBeNull();
        expect(tick('R_25')?.legs[0]).toMatchObject({ symbol: 'R_25', contract_type: 'DIGITOVER', barrier: 1 });
        expect(runtime.status().join(' ')).toMatch(/Also ready: Over 1 on Volatility 10 Index/);
    });

    it('runs a setup 3 times, then scans for the next one', () => {
        const runtime = create(osman, single);
        const settle = (is_win: boolean) => {
            const { order } = feed(runtime, 'R_100', [5], { history: history(OVER_READY) });
            const result = outcome(order!, is_win);
            runtime.onSettled?.(result, MONEY);
            return runtime.finishAfter?.(result);
        };
        expect(settle(true)).toBe(false);
        expect(runtime.status()[0]).toMatch(/run 2\/3/);
        expect(settle(false)).toBe(false);
        expect(settle(true)).toBe(false);
        expect(runtime.status()[0]).toMatch(/Running|Scanning/);
        feed(runtime, 'R_100', [2], { history: history(OVER_READY) });
        expect(runtime.status()[0]).toMatch(/Scanning 1 market · setups completed: 1/);
    });

    it('stops after the runs when set to stop', () => {
        const runtime = create(osman, { ...single, after_runs: 'stop' });
        const { order } = feed(runtime, 'R_100', [5], { history: history(OVER_READY) });
        const settle = () => {
            const result = outcome(order!, true);
            runtime.onSettled?.(result, MONEY);
            return runtime.finishAfter?.(result);
        };
        expect(settle()).toBe(false);
        expect(settle()).toBe(false);
        expect(settle()).toMatch(/3 runs done/);
    });
});
