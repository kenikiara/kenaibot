import { TStrategy } from '../engine/types';
import {
    DIGIT_OPTIONS,
    digitLeg,
    JUMP_5,
    lastDigit,
    marketName,
    marketOptions,
    ONE_SECOND_8,
    overUnderLeg,
    overUnderWins,
    rangeOptions,
    SIDE_OPTIONS,
    TRIGGER_OPTIONS,
    TSide,
} from './helpers';

/**
 * Strategies built around a "virtual gate": simulated trades on each tick
 * decide when the next real trade is placed.
 */

export const demoOver5: TStrategy = {
    id: 'demo-over5',
    label: 'DemoOver5',
    group: 'Digits',
    uses_market: true,
    summary:
        'Simulates your Over/Under trade on every tick and only trades for real after the set number of virtual losses (or wins). Optional recovery side after a real loss.',
    fields: [
        { key: 'direction', label: 'Direction', type: 'select', options: SIDE_OPTIONS },
        { key: 'barrier', label: 'Barrier', type: 'select', options: DIGIT_OPTIONS.slice(0, 9) },
        { key: 'virtual_trigger', label: 'Virtual entry trigger', type: 'select', options: TRIGGER_OPTIONS },
        {
            key: 'demo_count',
            label: 'Virtual count before entry (0 = trade at once)',
            type: 'number',
            min: 0,
            max: 50,
            step: 1,
        },
        { key: 'mode', label: 'Mode', type: 'select', options: [
            { value: 'normal', label: 'Normal (back to virtual after a win)' },
            { value: 'turbo', label: 'Turbo (keep trading after a win)' },
        ] },
        { key: 'recovery_enabled', label: 'Recovery market', type: 'toggle' },
        {
            key: 'recovery_direction',
            label: 'Recovery direction',
            type: 'select',
            options: SIDE_OPTIONS,
            visible: s => s.recovery_enabled,
        },
        {
            key: 'recovery_barrier',
            label: 'Recovery barrier',
            type: 'select',
            options: DIGIT_OPTIONS.slice(0, 9),
            visible: s => s.recovery_enabled,
        },
        {
            key: 'recovery_threshold',
            label: 'Recovery virtual count',
            type: 'number',
            min: 0,
            max: 50,
            step: 1,
            visible: s => s.recovery_enabled,
        },
    ],
    defaults: {
        direction: 'over',
        barrier: 5,
        virtual_trigger: 'losses',
        demo_count: 4,
        mode: 'normal',
        recovery_enabled: false,
        recovery_direction: 'over',
        recovery_barrier: 4,
        recovery_threshold: 3,
    },
    create: (s, money) => {
        let is_virtual = s.demo_count > 0;
        let virtual_count = 0;
        let in_recovery = false;
        const recovery = () => s.recovery_enabled && in_recovery;
        const side = (): TSide => (recovery() ? s.recovery_direction : s.direction);
        const barrier = (): number => Number(recovery() ? s.recovery_barrier : s.barrier);
        const threshold = (): number => Number(recovery() ? s.recovery_threshold : s.demo_count);

        return {
            symbols: [money.symbol],
            onTick: ctx => {
                if (!ctx.can_trade) return null;
                const digit = lastDigit(ctx.market);
                if (is_virtual) {
                    const is_win = overUnderWins(side(), barrier(), digit);
                    const counted = s.virtual_trigger === 'losses' ? !is_win : is_win;
                    if (counted) virtual_count += 1;
                    ctx.virtual({
                        symbol: ctx.market.symbol,
                        label: `${side() === 'over' ? 'Over' : 'Under'} ${barrier()}${recovery() ? ' [Recovery]' : ''}`,
                        digit,
                        is_win,
                        note: `${virtual_count}/${threshold()} virtual ${s.virtual_trigger}`,
                    });
                    if (virtual_count >= threshold()) {
                        is_virtual = false;
                        virtual_count = 0;
                    }
                    return null;
                }
                return {
                    legs: [overUnderLeg(ctx.market.symbol, side(), barrier(), 1, recovery() ? '[Recovery] ' : '')],
                    reason: recovery() ? 'Recovery entry' : 'Virtual gate passed',
                };
            },
            onSettled: outcome => {
                if (!outcome.filled) return;
                virtual_count = 0;
                if (outcome.is_win) {
                    in_recovery = false;
                    is_virtual = s.mode === 'turbo' ? false : s.demo_count > 0;
                    return;
                }
                if (s.recovery_enabled) {
                    in_recovery = true;
                    is_virtual = threshold() > 0;
                } else if (s.mode === 'turbo') {
                    is_virtual = s.demo_count > 0;
                }
            },
            status: () => [
                `${recovery() ? 'Recovery' : 'Main'}: ${side() === 'over' ? 'Over' : 'Under'} ${barrier()} on ${marketName(
                    money.symbol
                )}`,
                is_virtual
                    ? `Virtual mode — ${virtual_count}/${threshold()} virtual ${s.virtual_trigger}`
                    : 'Live — next tick trades',
            ],
        };
    },
};

export const fastOverUnder: TStrategy = {
    id: 'fast-over-under',
    label: 'Fast Over/Under',
    group: 'Digits',
    uses_market: true,
    summary:
        'Normal mode waits once for the entry digit, then trades every tick, switching to the recovery side after a loss. Virtual mode steps main → immediate → recovery, gating main and recovery with virtual losses.',
    fields: [
        { key: 'mode', label: 'Mode', type: 'select', options: [
            { value: 'normal', label: 'Normal' },
            { value: 'virtual', label: 'Virtual' },
        ] },
        {
            key: 'entry_point',
            label: 'Entry point digit',
            type: 'select',
            options: DIGIT_OPTIONS,
            visible: s => s.mode === 'normal',
        },
        { key: 'main_direction', label: 'Main direction', type: 'select', options: SIDE_OPTIONS },
        { key: 'main_barrier', label: 'Main barrier', type: 'select', options: DIGIT_OPTIONS },
        {
            key: 'main_virtual_losses',
            label: 'Main virtual losses',
            type: 'number',
            min: 1,
            max: 50,
            step: 1,
            visible: s => s.mode === 'virtual',
        },
        {
            key: 'immediate_direction',
            label: 'Immediate direction',
            type: 'select',
            options: SIDE_OPTIONS,
            visible: s => s.mode === 'virtual',
        },
        {
            key: 'immediate_barrier',
            label: 'Immediate barrier',
            type: 'select',
            options: DIGIT_OPTIONS,
            visible: s => s.mode === 'virtual',
        },
        { key: 'recovery_enabled', label: 'Recovery market', type: 'toggle', visible: s => s.mode === 'normal' },
        {
            key: 'recovery_direction',
            label: 'Recovery direction',
            type: 'select',
            options: SIDE_OPTIONS,
            visible: s => s.mode === 'virtual' || s.recovery_enabled,
        },
        {
            key: 'recovery_barrier',
            label: 'Recovery barrier',
            type: 'select',
            options: DIGIT_OPTIONS,
            visible: s => s.mode === 'virtual' || s.recovery_enabled,
        },
        {
            key: 'recovery_virtual_losses',
            label: 'Recovery virtual losses',
            type: 'number',
            min: 1,
            max: 50,
            step: 1,
            visible: s => s.mode === 'virtual',
        },
    ],
    defaults: {
        mode: 'normal',
        entry_point: 5,
        main_direction: 'under',
        main_barrier: 8,
        main_virtual_losses: 4,
        immediate_direction: 'over',
        immediate_barrier: 2,
        recovery_enabled: false,
        recovery_direction: 'over',
        recovery_barrier: 4,
        recovery_virtual_losses: 4,
    },
    create: (s, money) => {
        let entered = false;
        let in_recovery = false;
        let stage: 'main' | 'immediate' | 'recovery' = 'main';
        let main_losses = 0;
        let recovery_losses = 0;

        const contract = (which: 'main' | 'immediate' | 'recovery'): [TSide, number] => {
            if (which === 'immediate') return [s.immediate_direction, Number(s.immediate_barrier)];
            if (which === 'recovery') return [s.recovery_direction, Number(s.recovery_barrier)];
            return [s.main_direction, Number(s.main_barrier)];
        };

        return {
            symbols: [money.symbol],
            onTick: ctx => {
                if (!ctx.can_trade) return null;
                const digit = lastDigit(ctx.market);
                const symbol = ctx.market.symbol;

                if (s.mode === 'virtual') {
                    if (stage !== 'immediate') {
                        const [side, barrier] = contract(stage);
                        const is_win = overUnderWins(side, barrier, digit);
                        if (stage === 'main') main_losses = is_win ? 0 : main_losses + 1;
                        else recovery_losses = is_win ? 0 : recovery_losses + 1;
                        ctx.virtual({
                            symbol,
                            label: `${side === 'over' ? 'Over' : 'Under'} ${barrier} [${stage === 'main' ? 'Main' : 'Recovery'}]`,
                            digit,
                            is_win,
                        });
                    }
                    if (stage === 'main' && main_losses < Number(s.main_virtual_losses)) return null;
                    if (stage === 'recovery' && recovery_losses < Number(s.recovery_virtual_losses)) return null;
                    const [side, barrier] = contract(stage);
                    const prefix = stage === 'main' ? '' : stage === 'immediate' ? '[Immediate] ' : '[Recovery] ';
                    return { legs: [overUnderLeg(symbol, side, barrier, 1, prefix)], reason: `${stage} stage` };
                }

                if (!entered) {
                    if (digit !== Number(s.entry_point)) return null;
                    entered = true;
                    ctx.log(`Entry digit ${digit} printed — trading.`);
                }
                const use_recovery = s.recovery_enabled && in_recovery;
                const [side, barrier] = contract(use_recovery ? 'recovery' : 'main');
                return {
                    legs: [overUnderLeg(symbol, side, barrier, 1, use_recovery ? '[Recovery] ' : '')],
                    reason: use_recovery ? 'Recovery' : 'Main',
                };
            },
            onSettled: outcome => {
                if (!outcome.filled) return;
                if (outcome.is_win) {
                    in_recovery = false;
                    stage = 'main';
                    main_losses = 0;
                    recovery_losses = 0;
                    return;
                }
                if (s.mode === 'virtual') {
                    if (stage === 'main') stage = 'immediate';
                    else if (stage === 'immediate') {
                        stage = 'recovery';
                        recovery_losses = 0;
                    } else recovery_losses = 0;
                    main_losses = 0;
                } else if (s.recovery_enabled) {
                    in_recovery = true;
                }
            },
            status: () =>
                s.mode === 'virtual'
                    ? [
                          `Stage: ${stage}`,
                          stage === 'main'
                              ? `Main virtual losses ${main_losses}/${s.main_virtual_losses}`
                              : stage === 'recovery'
                                ? `Recovery virtual losses ${recovery_losses}/${s.recovery_virtual_losses}`
                                : 'Immediate trade next tick',
                      ]
                    : [
                          entered ? 'Entry reached — trading every tick' : `Waiting for digit ${s.entry_point}`,
                          s.recovery_enabled && in_recovery ? 'Recovery side active' : 'Main side active',
                      ],
        };
    },
};

export const demoEvenOdd: TStrategy = {
    id: 'demo-even-odd',
    label: 'DemoEvenOdd',
    group: 'Digits',
    uses_market: true,
    summary:
        'Waits once for the entry digit, then trades Even, Odd, or both — switching side every set number of trades.',
    fields: [
        { key: 'entry_direction', label: 'Direction', type: 'select', options: [
            { value: 'even', label: 'Even' },
            { value: 'odd', label: 'Odd' },
            { value: 'both', label: 'Both (alternate)' },
        ] },
        {
            key: 'first_trade',
            label: 'First trade',
            type: 'select',
            options: [
                { value: 'even', label: 'Even' },
                { value: 'odd', label: 'Odd' },
            ],
            visible: s => s.entry_direction === 'both',
        },
        {
            key: 'consecutive',
            label: 'Trades before switching',
            type: 'select',
            options: rangeOptions(1, 10),
            visible: s => s.entry_direction === 'both',
        },
        { key: 'entry_point', label: 'Entry point digit', type: 'select', options: DIGIT_OPTIONS },
        { key: 'duration', label: 'Duration (ticks)', type: 'select', options: rangeOptions(1, 10) },
    ],
    defaults: { entry_direction: 'even', first_trade: 'even', consecutive: 1, entry_point: 5, duration: 1 },
    create: (s, money) => {
        let entered = false;
        let side: 'even' | 'odd' = s.first_trade;
        let remaining = Number(s.consecutive);
        return {
            symbols: [money.symbol],
            onTick: ctx => {
                if (!ctx.can_trade) return null;
                if (!entered) {
                    if (lastDigit(ctx.market) !== Number(s.entry_point)) return null;
                    entered = true;
                }
                let trade: 'even' | 'odd' = s.entry_direction;
                if (s.entry_direction === 'both') {
                    if (remaining <= 0) {
                        side = side === 'even' ? 'odd' : 'even';
                        remaining = Number(s.consecutive);
                    }
                    remaining -= 1;
                    trade = side;
                }
                return {
                    legs: [digitLeg(ctx.market.symbol, trade === 'even' ? 'DIGITEVEN' : 'DIGITODD', Number(s.duration))],
                    reason: entered ? 'Trading' : 'Entry digit printed',
                };
            },
            status: () => [entered ? 'Entry reached — trading' : `Waiting for digit ${s.entry_point}`],
        };
    },
};

const MULTIMARKET_SYMBOLS = [...ONE_SECOND_8, ...JUMP_5];

export const multimarket: TStrategy = {
    id: 'multimarket',
    label: 'Multimarket',
    group: 'Digits',
    summary:
        'Runs a virtual Over/Under on every selected market. The first market to reach the virtual count (optionally confirmed by opposite results) gets the real trade. After a loss every market can switch to a recovery side.',
    fields: [
        { key: 'markets', label: 'Markets to scan', type: 'multi', options: marketOptions(MULTIMARKET_SYMBOLS) },
        { key: 'direction', label: 'Direction', type: 'select', options: SIDE_OPTIONS },
        { key: 'barrier', label: 'Barrier', type: 'select', options: DIGIT_OPTIONS.slice(0, 9) },
        { key: 'virtual_trigger', label: 'Trigger on', type: 'select', options: [
            { value: 'losses', label: 'Virtual losses' },
            { value: 'wins', label: 'Virtual wins' },
        ] },
        { key: 'demo_count', label: 'Count', type: 'number', min: 1, max: 50, step: 1 },
        { key: 'confirm_enabled', label: 'Confirm with opposite result', type: 'toggle' },
        {
            key: 'confirm_count',
            label: 'Confirmations',
            type: 'number',
            min: 1,
            max: 10,
            step: 1,
            visible: s => s.confirm_enabled,
        },
        { key: 'recovery_enabled', label: 'Recovery market', type: 'toggle' },
        {
            key: 'recovery_direction',
            label: 'Recovery direction',
            type: 'select',
            options: SIDE_OPTIONS,
            visible: s => s.recovery_enabled,
        },
        {
            key: 'recovery_barrier',
            label: 'Recovery barrier',
            type: 'select',
            options: DIGIT_OPTIONS.slice(0, 9),
            visible: s => s.recovery_enabled,
        },
        {
            key: 'recovery_trigger',
            label: 'Recovery trigger',
            type: 'select',
            options: TRIGGER_OPTIONS,
            visible: s => s.recovery_enabled,
        },
        {
            key: 'recovery_count',
            label: 'Recovery count',
            type: 'number',
            min: 1,
            max: 50,
            step: 1,
            visible: s => s.recovery_enabled,
        },
    ],
    defaults: {
        markets: MULTIMARKET_SYMBOLS,
        direction: 'over',
        barrier: 5,
        virtual_trigger: 'losses',
        demo_count: 2,
        confirm_enabled: false,
        confirm_count: 1,
        recovery_enabled: false,
        recovery_direction: 'over',
        recovery_barrier: 4,
        recovery_trigger: 'losses',
        recovery_count: 3,
    },
    create: s => {
        type TState = { count: number; stage: 1 | 2; confirm: number };
        const markets: string[] = s.markets?.length ? s.markets : MULTIMARKET_SYMBOLS;
        const states = new Map<string, TState>(markets.map(m => [m, { count: 0, stage: 1, confirm: 0 }]));
        let in_recovery = false;
        const resetAll = () => states.forEach(state => Object.assign(state, { count: 0, stage: 1, confirm: 0 }));

        return {
            symbols: markets,
            onTick: ctx => {
                if (!ctx.can_trade) return null;
                const symbol = ctx.market.symbol;
                const state = states.get(symbol);
                if (!state) return null;
                const recovering = s.recovery_enabled && in_recovery;
                const side: TSide = recovering ? s.recovery_direction : s.direction;
                const barrier = Number(recovering ? s.recovery_barrier : s.barrier);
                const trigger = recovering ? s.recovery_trigger : s.virtual_trigger;
                const threshold = Number(recovering ? s.recovery_count : s.demo_count);
                const digit = lastDigit(ctx.market);
                const is_win = overUnderWins(side, barrier, digit);
                const counted = trigger === 'losses' ? !is_win : is_win;
                const confirming = s.confirm_enabled && !recovering && Number(s.confirm_count) > 0;
                let fire = false;

                if (confirming && state.stage === 2) {
                    if (counted) state.confirm = 0;
                    else {
                        state.confirm += 1;
                        fire = state.confirm >= Number(s.confirm_count);
                    }
                } else {
                    state.count = counted ? state.count + 1 : 0;
                    if (threshold > 0 && state.count >= threshold) {
                        if (confirming) {
                            state.stage = 2;
                            state.confirm = 0;
                        } else fire = true;
                    }
                }
                ctx.virtual({
                    symbol,
                    label: `${side === 'over' ? 'Over' : 'Under'} ${barrier}`,
                    digit,
                    is_win,
                    note: state.stage === 2 ? `confirm ${state.confirm}/${s.confirm_count}` : `${state.count}/${threshold}`,
                });
                if (!fire) return null;
                Object.assign(state, { count: 0, stage: 1, confirm: 0 });
                return {
                    legs: [overUnderLeg(symbol, side, barrier, 1, recovering ? '[Recovery] ' : '')],
                    reason: `${marketName(symbol)} reached ${threshold} virtual ${trigger}`,
                };
            },
            onSettled: outcome => {
                if (!outcome.filled) return;
                if (outcome.is_win) in_recovery = false;
                else if (s.recovery_enabled) in_recovery = true;
                resetAll();
            },
            status: () => {
                const best = [...states.entries()].sort((a, b) => b[1].count - a[1].count)[0];
                return [
                    `Scanning ${markets.length} markets${s.recovery_enabled && in_recovery ? ' — recovery side' : ''}`,
                    best ? `Closest: ${marketName(best[0])} (${best[1].count})` : '',
                ].filter(Boolean);
            },
        };
    },
};
