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
jest.mock('@/utils/bot-workspace', () => ({ loadStrategyXml: jest.fn(() => Promise.resolve()) }));
jest.mock('@/utils/store-bridge', () => ({ getRootStore: jest.fn() }));

import { scannerFeed, TMarket } from '@/pages/scanner/scanner-feed';
import { loadStrategyXml } from '@/utils/bot-workspace';
import { getRootStore } from '@/utils/store-bridge';
import { TMoneySettings, TRuntime } from '../engine/types';
import { osmanBot } from '../strategies/osman-bot';
import { buildOsmanBotXml, TOsmanBotParams } from '../strategies/osman-bot-xml';

const PARAMS: TOsmanBotParams = {
    symbol: '1HZ50V',
    is_over: true,
    prediction: 1,
    recovery_prediction: 4,
    recovery_ratio: 0.95,
    entry_digits: [5, 6],
    stake: 1,
    target_wins: 3,
    max_recovery: 3,
    take_profit: 10,
    stop_loss: 20,
};

const parse = (xml: string) => new DOMParser().parseFromString(xml, 'text/xml');

describe('buildOsmanBotXml', () => {
    it('builds well-formed Blockly XML for the setup', () => {
        const doc = parse(buildOsmanBotXml(PARAMS));
        expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
        const field = (name: string) => [...doc.getElementsByTagName('field')].filter(f => f.getAttribute('name') === name);
        expect(field('SYMBOL_LIST')[0].textContent).toBe('1HZ50V');
        expect(field('PURCHASE_LIST').map(f => f.textContent)).toEqual(['DIGITOVER', 'DIGITUNDER']);
        expect(field('DURATIONTYPE_LIST')[0].textContent).toBe('t');
        const types = [...doc.getElementsByTagName('block')].map(b => b.getAttribute('type'));
        ['trade_definition', 'before_purchase', 'after_purchase', 'last_digit', 'read_details', 'trade_again'].forEach(type =>
            expect(types).toContain(type)
        );
    });

    it('uses only declared variables and unique block ids', () => {
        const doc = parse(buildOsmanBotXml(PARAMS));
        const declared = new Set([...doc.getElementsByTagName('variable')].map(v => v.getAttribute('id')));
        const used = [...doc.getElementsByTagName('field')].filter(f => f.getAttribute('name') === 'VAR').map(f => f.getAttribute('id'));
        expect(used.length).toBeGreaterThan(0);
        used.forEach(id => expect(declared.has(id)).toBe(true));
        const ids = [...doc.querySelectorAll('block, shadow')].map(b => b.getAttribute('id'));
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('bakes in the entry digits, predictions and limits', () => {
        const doc = parse(buildOsmanBotXml({ ...PARAMS, is_over: false, prediction: 8, recovery_prediction: 5, entry_digits: [4, 7, 9] }));
        const setTo = (name: string) => {
            const block = [...doc.getElementsByTagName('block')].find(
                b => b.getAttribute('type') === 'variables_set' && b.querySelector(':scope > field[name="VAR"]')?.textContent === name
            );
            return block?.querySelector(':scope > value > block > field')?.textContent;
        };
        expect([setTo('EntryA'), setTo('EntryB'), setTo('EntryC')]).toEqual(['4', '7', '9']);
        expect(setTo('MainPrediction')).toBe('8');
        expect(setTo('RecoveryPrediction')).toBe('5');
        expect(setTo('IsOver')).toBe('FALSE');
        expect(setTo('TargetWins')).toBe('3');
        expect(setTo('StopLoss')).toBe('-20');
    });
});

describe('Osman Bot controller', () => {
    const MONEY: TMoneySettings = {
        symbol: 'R_100',
        stake: 1,
        martingale: 1,
        martingale_mode: 'normal',
        take_profit: 5,
        stop_loss_mode: 'amount',
        stop_loss: 50,
        max_losses: 4,
    };
    // 0 and 1 at 9.5%, red bar on 2, green bar on 3 → the Over setup is ready
    const COUNTS: Record<number, number> = { 0: 95, 1: 95, 2: 80, 3: 120, 4: 100, 5: 100, 6: 100, 7: 105, 8: 100, 9: 105 };
    const digits = [4, 0, 1, 2, 3, 5, 6, 7, 8, 9].flatMap(d => Array(COUNTS[d]).fill(d));
    const market: TMarket = {
        symbol: 'R_100',
        name: 'R_100',
        decimals: 2,
        digits,
        quotes: [],
        last_quote: 100,
        last_epoch: 0,
        is_seeded: true,
        pending: [],
    };

    const store = {
        run_panel: {
            is_running: false,
            onRunButtonClick: jest.fn(async () => {
                store.run_panel.is_running = true;
            }),
            onStopButtonClick: jest.fn(),
        },
        dashboard: { setActiveTab: jest.fn() },
        transactions: { statistics: { total_profit: 0 } },
    };
    const logs: string[] = [];
    const tick = (runtime: TRuntime) =>
        runtime.onTick({
            market,
            markets: new Map([['R_100', market]]),
            can_trade: true,
            money: MONEY,
            virtual: () => undefined,
            log: text => logs.push(text),
        });
    const flush = () => new Promise(resolve => setTimeout(resolve, 600));

    beforeEach(() => {
        (getRootStore as jest.Mock).mockReturnValue(store);
        jest.spyOn(scannerFeed, 'getPayout').mockResolvedValue(1.95);
    });

    it('loads and runs the bot for the best setup, then scans again until take profit', async () => {
        const runtime = osmanBot.create({ ...osmanBot.defaults, scope: 'single' }, MONEY);
        tick(runtime);
        await flush();
        expect(loadStrategyXml).toHaveBeenCalledTimes(1);
        const xml = (loadStrategyXml as jest.Mock).mock.calls[0][0] as string;
        expect(xml).toContain('<field name="SYMBOL_LIST">R_100</field>');
        expect(store.run_panel.onRunButtonClick).toHaveBeenCalledTimes(1);
        expect(runtime.status()[0]).toMatch(/Running Osman Bot: Over 1 on Volatility 100 Index — waits for digit 5\/6/);

        // the bot trades, then finishes its cycle with +2
        tick(runtime);
        store.transactions.statistics.total_profit = 2;
        store.run_panel.is_running = false;
        tick(runtime);
        expect(logs.join('\n')).toMatch(/Setup 1 on Volatility 100 Index finished: \+2\.00 · session \+2\.00/);
        expect(runtime.stopReason?.()).toBe(false);

        // after the cooldown the next setup is loaded; its cycle takes the session past take profit
        jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
        tick(runtime);
        await flush();
        expect(loadStrategyXml).toHaveBeenCalledTimes(2);
        tick(runtime);
        store.transactions.statistics.total_profit = 5.5;
        store.run_panel.is_running = false;
        tick(runtime);
        expect(runtime.stopReason?.()).toMatch(/Take profit reached: \+5\.50 over 2 setups/);
    });
});
