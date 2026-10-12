import { scannerFeed, TMarket } from '@/pages/scanner/scanner-feed';
import { isTradingReady } from '@/pages/trading/trade-service';
import { placeLeg, sellContract, TLeg, TLegResult } from './execute';
import { TMoneySettings, TOrder, TOutcome, TRuntime, TSettingsValues, TStrategy, TVirtualEntry } from './types';

/**
 * Runs one Auto Trades strategy: feeds it ticks, places the orders it asks
 * for, applies the shared money rules (martingale, take profit, stop loss)
 * and keeps a log. A module singleton, so it keeps running while the user
 * looks at other tabs.
 */

export type TSessionStatus = 'idle' | 'running' | 'paused';

export type TLogEntry = {
    id: number;
    time: string;
    kind: 'trade' | 'virtual' | 'info' | 'warn';
    text: string;
    profit?: number;
    is_win?: boolean;
};

export type TReporter = {
    onBought?: (leg: TLeg, buy: any) => void;
    onSettled?: (result: TLegResult) => void;
};

const MAX_LOG = 120;
const MIN_STAKE = 0.35;
const SPLIT_STEPS = [1, 2, 3];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Next stake after a result. Normal: multiply after a loss, reset after a win. Split: cycle 1×, 2×, 3× of the base on losses. */
export const nextStake = (
    current: number,
    money: TMoneySettings,
    is_win: boolean,
    split: { step: number }
): number => {
    const base = money.stake > 0 ? money.stake : MIN_STAKE;
    if (money.martingale_mode === 'split') {
        split.step = is_win ? 0 : (split.step + 1) % SPLIT_STEPS.length;
        return round2(base * SPLIT_STEPS[split.step]);
    }
    split.step = 0;
    if (is_win) return base;
    return money.martingale > 1 ? round2(current * money.martingale) : current;
};

class AutoSession {
    status: TSessionStatus = 'idle';
    strategy: TStrategy | null = null;
    net = 0;
    wins = 0;
    losses = 0;
    runs = 0;
    consecutive_losses = 0;
    current_stake = 0;
    is_busy = false;
    stop_reason = '';
    log: TLogEntry[] = [];
    version = 0;

    private runtime: TRuntime | null = null;
    private money: TMoneySettings | null = null;
    private split = { step: 0 };
    private unsubscribe_tick: (() => void) | null = null;
    private listeners = new Set<() => void>();
    private reporter: TReporter = {};
    private log_id = 0;

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    getVersion = () => this.version;

    setReporter(reporter: TReporter) {
        this.reporter = reporter;
    }

    get statusLines(): string[] {
        return this.runtime?.status() ?? [];
    }

    get isActive() {
        return this.status !== 'idle';
    }

    start(strategy: TStrategy, settings: TSettingsValues, money: TMoneySettings): string | null {
        if (this.status !== 'idle') return 'A strategy is already running.';
        if (!strategy.signal_only && !isTradingReady()) return 'Log in to start auto trading.';
        if (money.stake < MIN_STAKE) return `Minimum stake is ${MIN_STAKE.toFixed(2)}.`;
        if (money.take_profit <= 0) return 'Take profit must be greater than 0.';
        if (money.stop_loss_mode === 'amount' && money.stop_loss <= 0) return 'Stop loss must be greater than 0.';
        if (money.stop_loss_mode === 'losses' && money.max_losses < 1) return 'Max losses must be at least 1.';

        this.strategy = strategy;
        this.money = money;
        this.runtime = strategy.create(settings, money);
        this.net = 0;
        this.wins = 0;
        this.losses = 0;
        this.runs = 0;
        this.consecutive_losses = 0;
        this.current_stake = money.stake;
        this.split = { step: 0 };
        this.is_busy = false;
        this.stop_reason = '';
        this.log = [];
        this.status = 'running';
        this.addLog('info', `${strategy.label} started.`);

        scannerFeed.start();
        this.unsubscribe_tick = scannerFeed.onTick(market => this.onTick(market));
        this.emit();
        return null;
    }

    pause() {
        if (this.status !== 'running') return;
        this.status = 'paused';
        this.addLog('info', 'Paused.');
        this.emit();
    }

    resume() {
        if (this.status !== 'paused') return;
        this.status = 'running';
        this.addLog('info', 'Resumed.');
        this.emit();
    }

    stop(reason = 'Stopped by you.') {
        if (this.status === 'idle') return;
        this.unsubscribe_tick?.();
        this.unsubscribe_tick = null;
        this.status = 'idle';
        this.stop_reason = reason;
        this.addLog('info', reason);
        this.emit();
    }

    private limitReason(): string | null {
        const money = this.money;
        if (!money) return null;
        if (this.net >= money.take_profit) return `Take profit reached: +${this.net.toFixed(2)}.`;
        if (money.stop_loss_mode === 'amount') {
            if (-this.net >= money.stop_loss) return `Stop loss reached: ${this.net.toFixed(2)}.`;
        } else if (this.consecutive_losses >= money.max_losses) {
            return `Max losses reached: ${this.consecutive_losses} in a row.`;
        }
        return null;
    }

    private onTick(market: TMarket) {
        const { runtime, money } = this;
        if (!runtime || !money || this.status === 'idle') return;
        if (!runtime.symbols.includes(market.symbol)) return;

        const can_trade = this.status === 'running' && !this.is_busy;
        let order: TOrder | null = null;
        try {
            order = runtime.onTick({
                market,
                markets: scannerFeed.markets,
                can_trade,
                money,
                virtual: entry => this.addVirtual(entry),
                log: text => this.addLog('info', text),
            });
        } catch (error) {
            this.addLog('warn', `Strategy error: ${(error as Error).message}`);
            return;
        }
        if (order && can_trade) this.execute(order);
    }

    private async execute(order: TOrder) {
        const money = this.money;
        if (!money) return;
        const limit = this.limitReason();
        if (limit) {
            this.stop(limit);
            return;
        }
        if (!isTradingReady()) {
            this.stop('Disconnected or logged out.');
            return;
        }

        this.is_busy = true;
        const stake = Math.max(MIN_STAKE, round2(this.current_stake));
        this.addLog('info', `${order.reason} → ${order.legs.map(leg => leg.label).join(' + ')} at ${stake.toFixed(2)}`);
        this.emit();

        const results = await Promise.all(
            order.legs.map(leg =>
                placeLeg(leg, stake, {
                    onBought: (bought_leg, buy) => this.reporter.onBought?.(bought_leg, buy),
                    onUpdate: (open_leg, contract) => {
                        if (!order.shouldSell || contract.is_sold || !contract.is_valid_to_sell) return;
                        const sell_reason = order.shouldSell(contract);
                        if (sell_reason) {
                            this.addLog('info', `Selling ${open_leg.label}: ${sell_reason}`);
                            sellContract(contract.contract_id).catch(() => undefined);
                        }
                    },
                })
            )
        );

        const filled = results.filter(result => !result.error);
        results
            .filter(result => result.error)
            .forEach(result => this.addLog('warn', `${result.leg.label} was not bought: ${result.error}`));
        filled.forEach(result => this.reporter.onSettled?.(result));

        const profit = round2(filled.reduce((total, result) => total + result.profit, 0));
        const is_win = order.as_batch || order.legs.length > 1 ? profit > 0 : Boolean(filled[0]?.is_win);
        const outcome: TOutcome = { order, results, profit, is_win, filled: filled.length > 0 };

        if (outcome.filled) {
            this.runs += 1;
            this.net = round2(this.net + profit);
            if (is_win) {
                this.wins += 1;
                this.consecutive_losses = 0;
            } else {
                this.losses += 1;
                this.consecutive_losses += 1;
            }
            this.current_stake = nextStake(this.current_stake, money, is_win, this.split);
            filled.forEach(result =>
                this.addLog(
                    'trade',
                    `${result.leg.label} on ${result.leg.symbol}: ${result.is_win ? 'WIN' : 'LOSS'} ${
                        result.profit >= 0 ? '+' : ''
                    }${result.profit.toFixed(2)}`,
                    result.profit,
                    result.is_win
                )
            );
        }

        try {
            this.runtime?.onSettled?.(outcome, money);
        } catch (error) {
            this.addLog('warn', `Strategy error: ${(error as Error).message}`);
        }
        this.is_busy = false;

        if (!outcome.filled && results.every(result => result.error)) {
            this.stop(`Trade failed: ${results[0]?.error ?? 'unknown error'}`);
            return;
        }
        const finish = this.runtime?.finishAfter?.(outcome);
        const limit_after = this.limitReason();
        if (limit_after) this.stop(limit_after);
        else if (finish) this.stop(finish);
        else this.emit();
    }

    private addVirtual(entry: TVirtualEntry) {
        this.addLog(
            'virtual',
            `Virtual ${entry.label} on ${entry.symbol} (digit ${entry.digit}): ${entry.is_win ? 'win' : 'loss'}${
                entry.note ? ` · ${entry.note}` : ''
            }`,
            undefined,
            entry.is_win
        );
    }

    private addLog(kind: TLogEntry['kind'], text: string, profit?: number, is_win?: boolean) {
        this.log_id += 1;
        this.log = [
            { id: this.log_id, time: new Date().toLocaleTimeString(), kind, text, profit, is_win },
            ...this.log,
        ].slice(0, MAX_LOG);
        this.emit();
    }

    private emit() {
        this.version += 1;
        this.listeners.forEach(listener => listener());
    }
}

export const autoSession = new AutoSession();
