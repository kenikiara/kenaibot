import { TMarket } from '@/pages/scanner/scanner-feed';
import { TLeg, TLegResult } from './execute';

export type TMartingaleMode = 'normal' | 'split';
export type TStopLossMode = 'amount' | 'losses';

/** The shared Trade Settings card. */
export type TMoneySettings = {
    symbol: string;
    stake: number;
    martingale: number;
    martingale_mode: TMartingaleMode;
    take_profit: number;
    stop_loss_mode: TStopLossMode;
    stop_loss: number;
    max_losses: number;
};

export type TFieldOption = { value: string | number; label: string };

export type TField = {
    key: string;
    label: string;
    type: 'select' | 'number' | 'toggle' | 'multi';
    options?: TFieldOption[];
    min?: number;
    max?: number;
    step?: number;
    /** Only shown when this returns true for the current settings. */
    visible?: (settings: TSettingsValues) => boolean;
    help?: string;
};

export type TSettingsValues = Record<string, any>;

/** One order: one or more contracts bought at the same moment with the current stake each. */
export type TOrder = {
    legs: TLeg[];
    reason: string;
    /** Treat the legs as one trade for win/loss and martingale (batches, hedged pairs). */
    as_batch?: boolean;
    /** Contract updates while open; return true to sell early (accumulators). */
    shouldSell?: (contract: any) => string | false;
};

export type TOutcome = {
    order: TOrder;
    results: TLegResult[];
    profit: number;
    is_win: boolean;
    /** At least one leg was bought. */
    filled: boolean;
};

export type TVirtualEntry = {
    symbol: string;
    label: string;
    digit: number;
    is_win: boolean;
    note?: string;
};

export type TTickContext = {
    /** Market that just ticked. */
    market: TMarket;
    /** Every market streaming on the shared feed. */
    markets: Map<string, TMarket>;
    /** False while a contract is open, the session is paused or a limit has been hit. */
    can_trade: boolean;
    money: TMoneySettings;
    /** Record a virtual (simulated, unpaid) trade for the virtual log. */
    virtual: (entry: TVirtualEntry) => void;
    /** Add a line to the strategy's activity log. */
    log: (text: string) => void;
};

export type TRuntime = {
    /** Markets this strategy listens to; ticks from other markets are ignored. */
    symbols: string[];
    onTick: (ctx: TTickContext) => TOrder | null;
    onSettled?: (outcome: TOutcome, money: TMoneySettings) => void;
    /** Short status lines shown under the settings while running. */
    status: () => string[];
    /** Stop after this outcome (one-shot strategies). Returns the reason, or false to continue. */
    finishAfter?: (outcome: TOutcome) => string | false;
};

export type TStrategyGroup = 'Digits' | 'Ups/Downs' | 'Advanced';

export type TStrategy = {
    id: string;
    label: string;
    group: TStrategyGroup;
    summary: string;
    /** Uses the Market selector in Trade Settings. */
    uses_market?: boolean;
    /** Never buys contracts itself (sets up the loaded bot instead). */
    signal_only?: boolean;
    fields: TField[];
    defaults: TSettingsValues;
    create: (settings: TSettingsValues, money: TMoneySettings) => TRuntime;
};
