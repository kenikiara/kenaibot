import { scannerFeed, TMarket } from '../scanner/scanner-feed';
import { buyContract, isTradingReady, TTradeResult } from '../trading/trade-service';
import { TContractType } from '../trading/trade-types';
import { nextStake, simulateSession, START, TSessionPlan, TSessionState } from './session-math';

/**
 * Runs a digit-contract session: one contract at a time, on whichever market the
 * `pick` function chooses, with target / stop-loss / losing-streak / payout /
 * probability stops. Shared by the Even/Odd session, Over/Under and Million Bot.
 */

export type TPick = { contract_type: TContractType; barrier?: number };

export type TAfterTrade = (
    state: TRunnerState,
    result: TTradeResult
) => { plan?: TSessionPlan; min_payout?: number; event?: string } | undefined;

export type TRunConfig = {
    plan: TSessionPlan;
    /** Called on every tick of every market; return a contract to buy it there now. */
    pick: (market: TMarket) => TPick | null;
    /** Stop when the chance of reaching the target falls below this (0 = off). */
    min_probability: number;
    /** Stop when the payout per 1 staked drops below this. */
    min_payout: number;
    /** Lets a bot switch plans between trades (e.g. Million Bot). */
    afterTrade?: TAfterTrade;
};

export type TSessionTrade = TTradeResult & { market_name: string; p_target_after: number };

export type TRunnerState = TSessionState & {
    is_running: boolean;
    is_buying: boolean;
    is_stopping: boolean;
    wins: number;
    losses: number;
    p_target: number | null;
    stop_reason: string;
    stop_tone: 'good' | 'bad' | 'neutral';
    log: TSessionTrade[];
    events: { time: number; text: string }[];
};

const initial = (): TRunnerState => ({
    ...START,
    is_running: false,
    is_buying: false,
    is_stopping: false,
    wins: 0,
    losses: 0,
    p_target: null,
    stop_reason: '',
    stop_tone: 'neutral',
    log: [],
    events: [],
});

export class DigitRunner {
    state: TRunnerState = initial();
    config: TRunConfig | null = null;
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

    start(config: TRunConfig) {
        if (this.state.is_running) return;
        if (!isTradingReady()) {
            this.update({ stop_reason: 'Log in to start a session.', stop_tone: 'bad' });
            return;
        }
        this.config = config;
        this.state = {
            ...initial(),
            is_running: true,
            p_target: simulateSession(config.plan, START, 4000).p_target,
        };
        scannerFeed.start();
        this.unsubscribe_tick = scannerFeed.onTick(market => this.onTick(market));
        this.emit();
    }

    /** Stops now, or right after the open contract settles. */
    stop(reason = 'Stopped by you.') {
        if (!this.state.is_running) return;
        if (this.state.is_buying) {
            this.update({ is_stopping: true, stop_reason: reason, stop_tone: 'neutral' });
            return;
        }
        this.finish(reason, 'neutral');
    }

    addEvent(text: string) {
        this.update({ events: [{ time: Date.now(), text }, ...this.state.events].slice(0, 50) });
    }

    private finish(reason: string, tone: TRunnerState['stop_tone']) {
        this.unsubscribe_tick?.();
        this.unsubscribe_tick = null;
        this.update({ is_running: false, is_stopping: false, is_buying: false, stop_reason: reason, stop_tone: tone });
    }

    private async onTick(market: TMarket) {
        const { config, state } = this;
        if (!config || !state.is_running || state.is_buying || state.is_stopping) return;
        if (scannerFeed.status !== 'live') return;

        const pick = config.pick(market);
        if (!pick) return;

        const stake = nextStake(config.plan, state.net);
        if (stake === null) {
            this.finish('Not enough loss budget left for another minimum stake.', 'bad');
            return;
        }
        if (!isTradingReady()) {
            this.finish('Disconnected or logged out.', 'bad');
            return;
        }

        this.update({ is_buying: true });
        try {
            const result = await buyContract({ symbol: market.symbol, stake, duration: 1, ...pick });
            this.record(result, market, config);
        } catch (error) {
            this.finish(`Trade failed: ${(error as Error).message}`, 'bad');
        }
    }

    private record(result: TTradeResult, market: TMarket, config: TRunConfig) {
        const s = this.state;
        const net = Math.round((s.net + result.profit) * 100) / 100;
        const next: TSessionState = {
            net,
            trades_done: s.trades_done + 1,
            losing_streak: result.is_win ? 0 : s.losing_streak + 1,
        };
        this.update({
            ...next,
            is_buying: false,
            wins: s.wins + (result.is_win ? 1 : 0),
            losses: s.losses + (result.is_win ? 0 : 1),
        });

        const change = config.afterTrade?.(this.state, result);
        if (change?.plan) config.plan = change.plan;
        if (change?.min_payout) config.min_payout = change.min_payout;
        if (change?.event) this.addEvent(change.event);

        const { plan } = config;
        const p_target = simulateSession(plan, next, 3000).p_target;
        this.update({
            p_target,
            log: [{ ...result, market_name: market.name, p_target_after: p_target }, ...s.log].slice(0, 100),
        });

        const payout_ratio = result.buy_price ? result.payout / result.buy_price : plan.payout;
        const pct = (n: number) => `${Math.round(n * 100)}%`;

        if (net >= plan.target) this.finish(`Target reached: +${net.toFixed(2)}.`, 'good');
        else if (next.trades_done >= plan.trades)
            this.finish(`Finished all ${plan.trades} trades.`, net > 0 ? 'good' : 'neutral');
        else if (net <= -plan.stop_loss) this.finish(`Stop loss reached (${net.toFixed(2)}).`, 'bad');
        else if (plan.max_losing_streak > 0 && next.losing_streak >= plan.max_losing_streak)
            this.finish(`${next.losing_streak} losses in a row — losing-streak stop.`, 'bad');
        else if (payout_ratio < config.min_payout)
            this.finish(`Payout dropped to ${payout_ratio.toFixed(3)} per 1 staked, below your minimum.`, 'bad');
        else if (config.min_probability > 0 && p_target < config.min_probability)
            this.finish(
                `Risky: chance of reaching your target fell to ${pct(p_target)} (your limit is ${pct(config.min_probability)}).`,
                'bad'
            );
        else if (s.is_stopping) this.finish(s.stop_reason || 'Stopped by you.', 'neutral');
    }

    private update(patch: Partial<TRunnerState>) {
        this.state = { ...this.state, ...patch };
        this.emit();
    }

    private emit() {
        this.version++;
        this.listeners.forEach(listener => listener());
    }
}
