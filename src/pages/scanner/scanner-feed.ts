import { isProduction, WS_SERVERS } from '@/components/shared/utils/config/config';
import { getLastDigit, pipStepToDecimals } from './scanner-engine';

/**
 * One public WebSocket that streams every synthetic Volatility and Jump index.
 * No login is needed, so the scanner works for visitors too. It lives as a
 * module singleton so it keeps streaming (and alerting) while the user is on
 * another tab.
 */

export const MAX_DIGITS = 1000;
export const MAX_QUOTES = 200;
const NOTIFY_INTERVAL_MS = 400;
const PING_INTERVAL_MS = 30000;
const PAYOUT_TTL_MS = 60000;
const SCANNED_SYMBOL = /^(R_\d+|1HZ\d+V|JD\d+)$/;

export type TFeedStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error';

export type TMarket = {
    symbol: string;
    name: string;
    decimals: number;
    digits: number[];
    /** Recent raw prices, for charts and rise/fall logic. */
    quotes: number[];
    last_quote: number | null;
    last_epoch: number;
    is_seeded: boolean;
    pending: { quote: number; epoch: number }[];
};

type TListener = () => void;
type TTickListener = (market: TMarket) => void;
type TPending = { resolve: (data: any) => void; reject: (error: Error) => void };

const sortMarkets = (a: TMarket, b: TMarket) => {
    // Volatility first, then 1s volatility, then Jump; numeric within each group
    const group = (s: string) => (s.startsWith('R_') ? 0 : s.startsWith('1HZ') ? 1 : 2);
    const num = (s: string) => Number(s.replace(/\D/g, ''));
    return group(a.symbol) - group(b.symbol) || num(a.symbol) - num(b.symbol);
};

class ScannerFeed {
    status: TFeedStatus = 'idle';
    markets = new Map<string, TMarket>();
    version = 0;

    private ws: WebSocket | null = null;
    private listeners = new Set<TListener>();
    private tick_listeners = new Set<TTickListener>();
    private notify_timer: ReturnType<typeof setTimeout> | null = null;
    private ping_timer: ReturnType<typeof setInterval> | null = null;
    private reconnect_timer: ReturnType<typeof setTimeout> | null = null;
    private reconnect_attempts = 0;
    private req_id = 0;
    private pending = new Map<number, TPending>();
    private payout_cache = new Map<string, { value: number; at: number }>();
    private is_stopped = true;

    get sortedMarkets(): TMarket[] {
        return [...this.markets.values()].sort(sortMarkets);
    }

    subscribe = (listener: TListener) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    getVersion = () => this.version;

    onTick(listener: TTickListener) {
        this.tick_listeners.add(listener);
        return () => {
            this.tick_listeners.delete(listener);
        };
    }

    start() {
        if (!this.is_stopped) return;
        this.is_stopped = false;
        this.connect();
    }

    stop() {
        this.is_stopped = true;
        this.clearTimers();
        this.ws?.close();
        this.ws = null;
        this.setStatus('idle');
    }

    get isRunning() {
        return !this.is_stopped;
    }

    /** Payout per 1 USD staked, from a live proposal on the public socket. */
    async getPayout(symbol: string, side: { contract_type: string; barrier?: number }, duration = 1): Promise<number> {
        const key = `${symbol}:${side.contract_type}:${side.barrier ?? ''}:${duration}`;
        const cached = this.payout_cache.get(key);
        if (cached && Date.now() - cached.at < PAYOUT_TTL_MS) return cached.value;

        const response = await this.request({
            proposal: 1,
            amount: 1,
            basis: 'stake',
            currency: 'USD',
            duration,
            duration_unit: 't',
            contract_type: side.contract_type,
            underlying_symbol: symbol,
            ...(side.barrier !== undefined ? { barrier: String(side.barrier) } : {}),
        });
        const value = Number(response.proposal.payout) / Number(response.proposal.ask_price);
        this.payout_cache.set(key, { value, at: Date.now() });
        return value;
    }

    private connect() {
        this.clearTimers();
        this.setStatus(this.reconnect_attempts > 0 ? 'reconnecting' : 'connecting');

        // brand config stores these as https:// URLs; older browsers only accept ws(s)://
        const url = (isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING).replace(/^http/, 'ws');
        let ws: WebSocket;
        try {
            ws = new WebSocket(url);
        } catch {
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            this.reconnect_attempts = 0;
            this.send({ active_symbols: 'brief' });
            this.ping_timer = setInterval(() => this.send({ ping: 1 }), PING_INTERVAL_MS);
        };
        ws.onmessage = event => this.handleMessage(JSON.parse(event.data));
        ws.onclose = () => {
            if (this.ws !== ws) return;
            this.ws = null;
            this.rejectPending('Connection closed');
            if (!this.is_stopped) this.scheduleReconnect();
        };
        ws.onerror = () => ws.close();
    }

    private scheduleReconnect() {
        this.clearTimers();
        this.reconnect_attempts++;
        this.setStatus(this.reconnect_attempts > 5 ? 'error' : 'reconnecting');
        const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnect_attempts, 5));
        this.reconnect_timer = setTimeout(() => this.connect(), delay);
    }

    private clearTimers() {
        if (this.ping_timer) clearInterval(this.ping_timer);
        if (this.reconnect_timer) clearTimeout(this.reconnect_timer);
        this.ping_timer = null;
        this.reconnect_timer = null;
    }

    private send(payload: Record<string, unknown>) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
    }

    private request(payload: Record<string, unknown>): Promise<any> {
        return new Promise((resolve, reject) => {
            if (this.ws?.readyState !== WebSocket.OPEN) {
                reject(new Error('Scanner is not connected'));
                return;
            }
            const req_id = ++this.req_id;
            this.pending.set(req_id, { resolve, reject });
            this.send({ ...payload, req_id });
        });
    }

    private rejectPending(reason: string) {
        this.pending.forEach(p => p.reject(new Error(reason)));
        this.pending.clear();
    }

    private handleMessage(data: any) {
        if (data.req_id && this.pending.has(data.req_id)) {
            const { resolve, reject } = this.pending.get(data.req_id)!;
            this.pending.delete(data.req_id);
            if (data.error) reject(new Error(data.error.message));
            else resolve(data);
            return;
        }
        if (data.error) {
            // Per-symbol failures (e.g. a market closed) shouldn't take the scanner down
            console.warn('[scanner]', data.error.message);
            return;
        }
        switch (data.msg_type) {
            case 'active_symbols':
                this.handleActiveSymbols(data.active_symbols);
                break;
            case 'history':
                this.handleHistory(data);
                break;
            case 'tick':
                this.handleTick(data.tick);
                break;
            default:
                break;
        }
    }

    private handleActiveSymbols(symbols: any[]) {
        const scanned = symbols.filter(
            s => SCANNED_SYMBOL.test(s.underlying_symbol) && s.exchange_is_open && !s.is_trading_suspended
        );
        const next = new Map<string, TMarket>();
        scanned.forEach(s => {
            next.set(s.underlying_symbol, {
                symbol: s.underlying_symbol,
                name: s.underlying_symbol_name,
                decimals: pipStepToDecimals(s.pip_size),
                digits: [],
                quotes: [],
                last_quote: null,
                last_epoch: 0,
                is_seeded: false,
                pending: [],
            });
        });
        this.markets = next;
        this.setStatus('live');
        this.markDirty();

        next.forEach(({ symbol }) => {
            this.send({ ticks_history: symbol, count: MAX_DIGITS, end: 'latest', style: 'ticks' });
            this.send({ ticks: symbol, subscribe: 1 });
        });
    }

    private handleHistory(data: any) {
        const market = this.markets.get(data.echo_req?.ticks_history);
        if (!market) return;
        if (Number.isInteger(data.pip_size)) market.decimals = data.pip_size;

        const { prices = [], times = [] } = data.history ?? {};
        market.digits = prices.map((p: number) => getLastDigit(p, market.decimals));
        market.quotes = prices.slice(-MAX_QUOTES);
        market.last_quote = prices.length ? prices[prices.length - 1] : null;
        market.last_epoch = times.length ? times[times.length - 1] : 0;
        market.is_seeded = true;

        // Ticks that streamed in before the history arrived
        market.pending.forEach(t => this.appendTick(market, t.quote, t.epoch));
        market.pending = [];
        this.markDirty();
    }

    private handleTick(tick: any) {
        const market = this.markets.get(tick?.symbol);
        if (!market) return;
        if (Number.isInteger(tick.pip_size)) market.decimals = tick.pip_size;
        if (!market.is_seeded) {
            market.pending.push({ quote: tick.quote, epoch: tick.epoch });
            return;
        }
        if (this.appendTick(market, tick.quote, tick.epoch)) {
            this.tick_listeners.forEach(listener => listener(market));
            this.markDirty();
        }
    }

    private appendTick(market: TMarket, quote: number, epoch: number) {
        if (epoch <= market.last_epoch) return false;
        market.digits.push(getLastDigit(quote, market.decimals));
        if (market.digits.length > MAX_DIGITS) market.digits.splice(0, market.digits.length - MAX_DIGITS);
        market.quotes.push(quote);
        if (market.quotes.length > MAX_QUOTES) market.quotes.splice(0, market.quotes.length - MAX_QUOTES);
        market.last_quote = quote;
        market.last_epoch = epoch;
        return true;
    }

    private setStatus(status: TFeedStatus) {
        if (this.status === status) return;
        this.status = status;
        this.markDirty();
    }

    // Ticks across ~18 markets arrive many times a second; batch UI updates
    private markDirty() {
        if (this.notify_timer) return;
        this.notify_timer = setTimeout(() => {
            this.notify_timer = null;
            this.version++;
            this.listeners.forEach(listener => listener());
        }, NOTIFY_INTERVAL_MS);
    }
}

export const scannerFeed = new ScannerFeed();
