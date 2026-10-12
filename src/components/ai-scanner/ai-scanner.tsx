import React, { useEffect, useRef, useState } from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { generateOAuthURL } from '@/components/shared';
import { DBOT_TABS } from '@/constants/bot-contents';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { scannerFeed, TMarket } from '@/pages/scanner/scanner-feed';
import {
    loadStrategyXml,
    publicXmlUrl,
    setBotBoolean,
    setBotNumber,
    setBotPurchaseSide,
    setXmlMarket,
} from '@/utils/bot-workspace';
import { localize } from '@deriv-com/translations';
import { PLAN_BOT_FILES, SCAN_MARKETS, SCAN_TYPES, scanMarkets, TScanSignal, TScanType } from './market-scan';
import './ai-scanner.scss';

const SETTINGS_KEY = 'ai_scanner_settings';
const POSITION_KEY = 'ai_scanner_pos';
const BUTTON_SIZE = 56;
const DATA_WAIT_MS = 12000;

type TSettings = {
    type: TScanType;
    stake: number;
    martingale: number;
    take_profit: number;
    max_losses: number;
    multi_market: boolean;
    market: string;
    differs_trades: number;
};

type TPhase = 'idle' | 'scanning' | 'found' | 'none' | 'loading' | 'waiting';

const DEFAULTS: TSettings = {
    type: 'overunder',
    stake: 1,
    martingale: 2,
    take_profit: 10,
    max_losses: 5,
    multi_market: true,
    market: SCAN_MARKETS[0],
    differs_trades: 5,
};

const readJson = <T,>(key: string, fallback: T): T => {
    try {
        const saved = localStorage.getItem(key);
        return saved ? { ...fallback, ...JSON.parse(saved) } : fallback;
    } catch {
        return fallback;
    }
};

const writeJson = (key: string, value: unknown) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // storage unavailable
    }
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Resolves with the markets once each has enough history, or with whatever arrived by the deadline. */
const waitForMarkets = async (symbols: string[]) => {
    scannerFeed.start();
    const deadline = Date.now() + DATA_WAIT_MS;
    const pick = () => symbols.map(s => scannerFeed.markets.get(s)).filter((m): m is TMarket => Boolean(m));
    while (Date.now() < deadline) {
        const markets = pick();
        if (markets.length === symbols.length && markets.every(m => m.digits.length >= 400)) return markets;
        await sleep(500);
    }
    return pick();
};

/** Applies the scanner settings and the signal's plan to the freshly loaded bot. */
const applyPlanToBot = (signal: TScanSignal, settings: TSettings) => {
    const { plan } = signal;
    const { stake, martingale, take_profit, max_losses } = settings;
    setBotNumber('Stake', stake);
    setBotNumber('InitialStake', stake);
    setBotNumber('TakeProfit', take_profit);

    const martingaleSettings = () => {
        setBotNumber('Martingale', martingale);
        setBotNumber('MartingaleLevel', max_losses);
    };

    switch (plan.bot) {
        case 'magical':
            setBotBoolean('IsItOverMarket', plan.is_over);
            setBotNumber('over prediction', plan.over_barrier);
            setBotNumber('Under Prediction', plan.under_barrier);
            setBotNumber('martingale:size', martingale);
            setBotNumber('StopLoss', max_losses);
            break;
        case 'over1ai':
        case 'under8strategy':
            setBotNumber('underPrediction', plan.primary_barrier);
            setBotNumber('overPrediction', plan.recovery_barrier);
            setBotNumber('prediction', plan.primary_barrier);
            martingaleSettings();
            break;
        case 'underside':
            setBotNumber('underPrediction', plan.primary_barrier);
            setBotNumber('underprediction2', plan.recovery_barrier);
            setBotNumber('prediction', plan.primary_barrier);
            martingaleSettings();
            break;
        case 'oversingle':
            setBotNumber('overPrediction', plan.barrier);
            martingaleSettings();
            break;
        case 'undersingle':
            setBotNumber('underPrediction', plan.barrier);
            martingaleSettings();
            break;
        case 'matches':
            setBotNumber('Prediction', plan.digit);
            setBotPurchaseSide(plan.side);
            martingaleSettings();
            break;
        case 'differs':
            setBotNumber('Prediction', plan.digit);
            setBotNumber('MutipleTradeNumber', plan.trade_count);
            martingaleSettings();
            break;
        case 'evenodd':
        case 'risefall':
            setBotPurchaseSide(plan.side);
            martingaleSettings();
            break;
        default:
            break;
    }
};

/**
 * Builds the tick watcher that decides when to press Run after loading a bot.
 * Returns null when the bot should start straight away.
 */
const makeEntryWatcher = (signal: TScanSignal, onProgress: (text: string) => void) => {
    const { plan } = signal;

    if (plan.bot === 'evenodd') {
        const want_even = plan.side === 'DIGITEVEN';
        let against = 0;
        return (digit: number) => {
            if ((digit % 2 === 0) === want_even) {
                if (against >= 3) return true;
                against = 0;
            } else {
                against += 1;
            }
            onProgress(localize('{{count}}/3 opposite ticks', { count: against }));
            return false;
        };
    }
    if (plan.bot === 'risefall') {
        const want_up = plan.side === 'CALL';
        let moves = 0;
        let previous: number | null = null;
        return (_digit: number, quote: number) => {
            if (previous !== null && quote !== previous) {
                if (quote > previous === want_up) moves += 1;
                else moves = 0;
            }
            previous = quote;
            onProgress(localize('{{count}}/3 ticks {{direction}}', { count: moves, direction: want_up ? 'up' : 'down' }));
            return moves >= 3;
        };
    }
    if (plan.bot === 'matches' && signal.entry_digit !== undefined) {
        const entry = signal.entry_digit;
        onProgress(localize('Waiting for digit {{digit}}', { digit: entry }));
        return (digit: number) => digit === entry;
    }
    if (signal.streak_entry && (plan.bot === 'oversingle' || plan.bot === 'undersingle')) {
        const is_under = plan.bot === 'undersingle';
        const barrier = plan.barrier;
        let against = 0;
        return (digit: number) => {
            if (is_under ? digit > barrier : digit < barrier) {
                against += 1;
            } else if (is_under ? digit < barrier : digit > barrier) {
                if (against >= 5) return true;
                against = 0;
            } else {
                against = 0;
            }
            onProgress(localize('{{count}}/5 ticks against the trade', { count: against }));
            return false;
        };
    }
    return null;
};

const AiScanner = observer(() => {
    const { dashboard, run_panel } = useStore();
    const { isAuthorized } = useApiBase();
    const [is_open, setIsOpen] = useState(false);
    const [settings, setSettings] = useState<TSettings>(() => readJson(SETTINGS_KEY, DEFAULTS));
    const [phase, setPhase] = useState<TPhase>('idle');
    const [signal, setSignal] = useState<TScanSignal | null>(null);
    const [message, setMessage] = useState('');
    const [position, setPosition] = useState(() => readJson(POSITION_KEY, { x: -1, y: -1 }));
    const drag = useRef({ active: false, moved: false, dx: 0, dy: 0, sx: 0, sy: 0 });
    const stop_waiting = useRef<(() => void) | null>(null);

    useEffect(() => writeJson(SETTINGS_KEY, settings), [settings]);

    useEffect(() => {
        if (position.x < 0) setPosition({ x: window.innerWidth - 84, y: window.innerHeight - 140 });
    }, [position.x]);

    useEffect(() => () => stop_waiting.current?.(), []);

    const update = <K extends keyof TSettings>(key: K, value: TSettings[K]) =>
        setSettings(current => ({ ...current, [key]: value }));

    const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
        drag.current = {
            active: true,
            moved: false,
            dx: event.clientX - position.x,
            dy: event.clientY - position.y,
            sx: event.clientX,
            sy: event.clientY,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
        const state = drag.current;
        if (!state.active) return;
        if (!state.moved && Math.hypot(event.clientX - state.sx, event.clientY - state.sy) < 5) return;
        state.moved = true;
        setPosition({
            x: clamp(event.clientX - state.dx, 4, window.innerWidth - BUTTON_SIZE - 4),
            y: clamp(event.clientY - state.dy, 4, window.innerHeight - BUTTON_SIZE - 4),
        });
    };

    const onPointerUp = () => {
        const state = drag.current;
        state.active = false;
        if (state.moved) writeJson(POSITION_KEY, position);
        else setIsOpen(open => !open);
    };

    const scan = async () => {
        stop_waiting.current?.();
        setSignal(null);
        setPhase('scanning');
        setMessage(localize('Scanning markets…'));
        const symbols = settings.multi_market ? SCAN_MARKETS : [settings.market];
        const markets = await waitForMarkets(symbols);
        const { signals, scanned } = scanMarkets(markets, settings.type, { differs_trades: settings.differs_trades });
        if (signals.length) {
            setSignal(signals[0]);
            setPhase('found');
            setMessage('');
        } else {
            setPhase('none');
            setMessage(
                scanned
                    ? localize('No suitable market right now (scanned {{count}}). Try again in a moment.', { count: scanned })
                    : localize('No market data — check your connection and try again.')
            );
        }
    };

    const login = async () => {
        const url = await generateOAuthURL();
        if (url) window.location.replace(url);
    };

    const cancelWaiting = () => {
        stop_waiting.current?.();
        stop_waiting.current = null;
        setPhase('found');
        setMessage('');
    };

    const loadSignal = async (auto_run: boolean) => {
        if (!signal) return;
        if (auto_run && !isAuthorized) {
            login();
            return;
        }
        const file = PLAN_BOT_FILES[signal.plan.bot];
        const bot_name = file.replace(/\.xml$/, '');
        setPhase('loading');
        setMessage(localize('Loading {{bot_name}}…', { bot_name }));
        try {
            const response = await fetch(publicXmlUrl(`ai-scanner/${file}`));
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const xml = setXmlMarket(await response.text(), signal.symbol);
            dashboard.setActiveTab(DBOT_TABS.BOT_BUILDER);
            await sleep(60);
            await loadStrategyXml(xml, bot_name);
            await sleep(400);
            applyPlanToBot(signal, settings);
        } catch {
            setPhase('found');
            setMessage(localize('Could not load the bot. Please try again.'));
            return;
        }

        if (!auto_run) {
            setPhase('found');
            setMessage(localize('{{bot_name}} is loaded in the Bot Builder.', { bot_name }));
            return;
        }

        const run = () => {
            stop_waiting.current = null;
            setIsOpen(false);
            setPhase('found');
            setMessage('');
            if (!run_panel.is_running) run_panel.onRunButtonClick();
        };

        const watcher = makeEntryWatcher(signal, setMessage);
        if (!watcher) {
            run();
            return;
        }

        setPhase('waiting');
        scannerFeed.start();
        const unsubscribe = scannerFeed.onTick(market => {
            if (market.symbol !== signal.symbol || market.last_quote === null) return;
            const digit = market.digits[market.digits.length - 1];
            if (watcher(digit, market.last_quote)) {
                unsubscribe();
                run();
            }
        });
        stop_waiting.current = unsubscribe;
    };

    const is_busy = phase === 'scanning' || phase === 'loading' || phase === 'waiting';
    const panel_left = clamp(position.x - 300, 8, Math.max(8, window.innerWidth - 348));
    const panel_top = clamp(position.y - 440, 8, Math.max(8, window.innerHeight - 520));

    return (
        <>
            <button
                type='button'
                className={classNames('ai-scanner__fab', { 'ai-scanner__fab--active': is_open || phase === 'waiting' })}
                style={{ left: position.x, top: position.y }}
                aria-label={localize('AI Market Scanner')}
                title={localize('AI Market Scanner')}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            >
                AI
            </button>

            {is_open && (
                <div className='ai-scanner__panel' style={{ left: panel_left, top: panel_top }} role='dialog'>
                    <div className='ai-scanner__head'>
                        <span className='ai-scanner__dot' />
                        <span className='ai-scanner__title'>{localize('AI Market Scanner')}</span>
                        <button
                            type='button'
                            className='ai-scanner__close'
                            aria-label={localize('Close')}
                            onClick={() => setIsOpen(false)}
                        >
                            ×
                        </button>
                    </div>

                    <div className='ai-scanner__body'>
                        <label className='ai-scanner__label' htmlFor='ai-scanner-type'>
                            {localize('Trade type')}
                        </label>
                        <select
                            id='ai-scanner-type'
                            className='ai-scanner__input'
                            value={settings.type}
                            disabled={is_busy}
                            onChange={e => update('type', e.target.value as TScanType)}
                        >
                            {SCAN_TYPES.map(({ value, label }) => (
                                <option key={value} value={value}>
                                    {label}
                                </option>
                            ))}
                        </select>

                        <div className='ai-scanner__grid'>
                            <NumberInput
                                id='ai-scanner-stake'
                                label={localize('Stake (= initial)')}
                                value={settings.stake}
                                min={0.35}
                                step={0.01}
                                onChange={n => update('stake', n)}
                            />
                            <NumberInput
                                id='ai-scanner-martingale'
                                label={localize('Martingale ×')}
                                value={settings.martingale}
                                min={1}
                                step={0.1}
                                onChange={n => update('martingale', n)}
                            />
                            <NumberInput
                                id='ai-scanner-tp'
                                label={localize('Take Profit ($)')}
                                value={settings.take_profit}
                                min={0}
                                step={1}
                                onChange={n => update('take_profit', n)}
                            />
                            <NumberInput
                                id='ai-scanner-sl'
                                label={localize('Max losses (1-8)')}
                                value={settings.max_losses}
                                min={1}
                                max={8}
                                step={1}
                                onChange={n => update('max_losses', Math.round(n))}
                            />
                            {settings.type === 'matchesdiffers' && (
                                <NumberInput
                                    id='ai-scanner-differs'
                                    label={localize('Differs trades (1-50)')}
                                    value={settings.differs_trades}
                                    min={1}
                                    max={50}
                                    step={1}
                                    onChange={n => update('differs_trades', Math.round(n))}
                                />
                            )}
                        </div>

                        <label className='ai-scanner__toggle'>
                            <input
                                type='checkbox'
                                checked={settings.multi_market}
                                disabled={is_busy}
                                onChange={e => update('multi_market', e.target.checked)}
                            />
                            {localize('Multi-Market Scan')}
                        </label>
                        {!settings.multi_market && (
                            <select
                                className='ai-scanner__input'
                                aria-label={localize('Market')}
                                value={settings.market}
                                disabled={is_busy}
                                onChange={e => update('market', e.target.value)}
                            >
                                {SCAN_MARKETS.map(symbol => (
                                    <option key={symbol} value={symbol}>
                                        {scannerFeed.markets.get(symbol)?.name ?? symbol}
                                    </option>
                                ))}
                            </select>
                        )}

                        {signal && (phase === 'found' || phase === 'loading' || phase === 'waiting') && (
                            <div className='ai-scanner__result'>
                                <div className='ai-scanner__result-title'>✓ {localize('Suitable market found!')}</div>
                                <div className='ai-scanner__result-market'>{signal.market_name}</div>
                                <div className='ai-scanner__result-direction'>{signal.direction}</div>
                                <div className='ai-scanner__stats'>
                                    <span>
                                        {localize('Confidence')} <b>{Math.round(signal.confidence)}%</b>
                                    </span>
                                    {signal.z_score !== undefined && (
                                        <span>
                                            {localize('Z-Score')} <b>{signal.z_score}</b>
                                        </span>
                                    )}
                                    {signal.agree !== undefined && (
                                        <span>
                                            {localize('Agree')} <b>{signal.agree}%</b>
                                        </span>
                                    )}
                                </div>
                                <p className='ai-scanner__note'>{signal.note}</p>
                            </div>
                        )}

                        {message && <p className='ai-scanner__message'>{message}</p>}

                        <div className='ai-scanner__actions'>
                            {phase === 'waiting' ? (
                                <button type='button' className='ai-scanner__btn' onClick={cancelWaiting}>
                                    {localize('Cancel')}
                                </button>
                            ) : signal && (phase === 'found' || phase === 'loading') ? (
                                <>
                                    <button
                                        type='button'
                                        className='ai-scanner__btn'
                                        disabled={is_busy}
                                        onClick={() => loadSignal(false)}
                                    >
                                        {phase === 'loading' ? localize('Loading…') : localize('Load only')}
                                    </button>
                                    <button
                                        type='button'
                                        className='ai-scanner__btn ai-scanner__btn--primary'
                                        disabled={is_busy}
                                        onClick={() => loadSignal(true)}
                                    >
                                        {isAuthorized ? localize('Load & Run') : localize('Log in to run')}
                                    </button>
                                    <button
                                        type='button'
                                        className='ai-scanner__btn ai-scanner__btn--link'
                                        disabled={is_busy}
                                        onClick={scan}
                                    >
                                        {localize('New Scan')}
                                    </button>
                                </>
                            ) : (
                                <button
                                    type='button'
                                    className='ai-scanner__btn ai-scanner__btn--primary'
                                    disabled={is_busy}
                                    onClick={scan}
                                >
                                    {phase === 'scanning' ? localize('Scanning…') : localize('Scan Markets')}
                                </button>
                            )}
                        </div>
                        <p className='ai-scanner__disclaimer'>
                            {localize(
                                'Signals summarise recent ticks. Each tick is random, so a signal does not make a win more likely.'
                            )}
                        </p>
                    </div>
                </div>
            )}
        </>
    );
});

const NumberInput = ({
    id,
    label,
    value,
    min,
    max,
    step,
    onChange,
}: {
    id: string;
    label: string;
    value: number;
    min: number;
    max?: number;
    step: number;
    onChange: (n: number) => void;
}) => (
    <div className='ai-scanner__field'>
        <label className='ai-scanner__label' htmlFor={id}>
            {label}
        </label>
        <input
            id={id}
            className='ai-scanner__input'
            type='number'
            inputMode='decimal'
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={e => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) onChange(clamp(n, min, max ?? Number.MAX_SAFE_INTEGER));
            }}
        />
    </div>
);

export default AiScanner;
