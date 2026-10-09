import { scannerFeed, TMarket } from '../scanner/scanner-feed';
import { STRATEGIES, TStrategy } from './strategies';
import { buyContract, isTradingReady, TTradeResult } from './trade-service';

/**
 * Runs one strategy on one market: one contract at a time, with a hard stop
 * loss, take profit and a capped martingale. A module singleton so it keeps
 * running while the user looks at other tabs.
 */

export type TAutoConfig = {
    strategy_key: string;
    params: Record<string, number>;
    symbol: string;
    stake: number;
    martingale: number;
    max_steps: number;
    take_profit: number;
    stop_loss: number;
};

export type TAutoState = {
    is_running: boolean;
    is_buying: boolean;
    trades: number;
    wins: number;
    losses: number;
    net: number;
    next_stake: number;
    step: number;
    stop_reason: string;
    log: TTradeResult[];
};

const MAX_LOG = 50;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Total lost if every martingale step loses, starting from `stake`. */
export const worstCaseLoss = (stake: number, multiplier: number, max_steps: number) => {
    let total = 0;
    let s = stake;
    for (let i = 0; i <= (multiplier > 1 ? max_steps : 0); i++) {
        total += s;
        s *= multiplier;
    }
    return round2(total);
};

class AutoTrader {
    state: TAutoState = this.initialState(0);
    config: TAutoConfig | null = null;
    version = 0;

    private listeners = new Set<() => void>();
    private unsubscribe_tick: (() => void) | null = null;

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    getVersion = () => this.version;

    get strategy(): TStrategy | undefined {
        return STRATEGIES.find(s => s.key === this.config?.strategy_key);
    }

    start(config: TAutoConfig) {
        if (this.state.is_running) return;
        if (!isTradingReady()) {
            this.update({ stop_reason: 'Log in to start auto trading.' });
            return;
        }
        this.config = config;
        this.state = { ...this.initialState(config.stake), is_running: true };
        scannerFeed.start();
        this.unsubscribe_tick = scannerFeed.onTick(market => this.onTick(market));
        this.emit();
    }

    stop(reason = 'Stopped by you.') {
        this.unsubscribe_tick?.();
        this.unsubscribe_tick = null;
        this.update({ is_running: false, stop_reason: reason });
    }

    reset() {
        if (this.state.is_running) return;
        this.state = this.initialState(this.config?.stake ?? 0);
        this.emit();
    }

    private initialState(stake: number): TAutoState {
        return {
            is_running: false,
            is_buying: false,
            trades: 0,
            wins: 0,
            losses: 0,
            net: 0,
            next_stake: stake,
            step: 0,
            stop_reason: '',
            log: [],
        };
    }

    private async onTick(market: TMarket) {
        const { config, strategy } = this;
        if (!config || !strategy || market.symbol !== config.symbol) return;
        if (!this.state.is_running || this.state.is_buying) return;

        const decision = strategy.decide(market, config.params);
        if (!decision) return;

        const stake = round2(this.state.next_stake);
        // Never place a trade that could take the session past the stop loss
        if (this.state.net - stake < -config.stop_loss) {
            this.stop(`Next stake (${stake.toFixed(2)}) would exceed your stop loss.`);
            return;
        }
        if (!isTradingReady()) {
            this.stop('Disconnected or logged out.');
            return;
        }

        this.update({ is_buying: true });
        try {
            const result = await buyContract({ symbol: market.symbol, stake, ...decision });
            this.record(result, config);
        } catch (error) {
            this.stop(`Trade failed: ${(error as Error).message}`);
        } finally {
            this.update({ is_buying: false });
        }
    }

    private record(result: TTradeResult, config: TAutoConfig) {
        const s = this.state;
        const net = round2(s.net + result.profit);
        const can_step = !result.is_win && config.martingale > 1 && s.step < config.max_steps;
        const next = {
            trades: s.trades + 1,
            wins: s.wins + (result.is_win ? 1 : 0),
            losses: s.losses + (result.is_win ? 0 : 1),
            net,
            step: can_step ? s.step + 1 : 0,
            next_stake: can_step ? round2(s.next_stake * config.martingale) : config.stake,
            log: [result, ...s.log].slice(0, MAX_LOG),
        };
        this.update(next);

        if (net >= config.take_profit) this.stop(`Take profit reached (+${net.toFixed(2)}).`);
        else if (net <= -config.stop_loss) this.stop(`Stop loss reached (${net.toFixed(2)}).`);
    }

    private update(patch: Partial<TAutoState>) {
        this.state = { ...this.state, ...patch };
        this.emit();
    }

    private emit() {
        this.version++;
        this.listeners.forEach(listener => listener());
    }
}

export const autoTrader = new AutoTrader();
