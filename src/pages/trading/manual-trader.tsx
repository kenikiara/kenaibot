import React, { useEffect, useState, useSyncExternalStore } from 'react';
import classNames from 'classnames';
import { botNotification } from '@/components/bot-notification/bot-notification';
import { generateOAuthURL } from '@/components/shared';
import { useApiBase } from '@/hooks/useApiBase';
import { Localize, localize } from '@deriv-com/translations';
import { scannerFeed } from '../scanner/scanner-feed';
import { DigitRing, MarketSelect, PriceChart } from './components';
import { buyContract, TTradeResult } from './trade-service';
import { DURATIONS, fairWinRate, getTradeType, TRADE_TYPES, TTradeOption, TTradeTypeKey } from './trade-types';
import './trading.scss';

const SETTINGS_KEY = 'manual_trader_settings';

type TSettings = { symbol: string; type: TTradeTypeKey; duration: number; digit: number; stake: number };

const DEFAULTS: TSettings = { symbol: '1HZ100V', type: 'over_under', duration: 1, digit: 5, stake: 1 };

const load = (): TSettings => {
    try {
        return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
    } catch {
        return DEFAULTS;
    }
};

const login = async () => {
    const url = await generateOAuthURL();
    if (url) window.location.replace(url);
};

const usePayoutRatios = (symbol: string, options: TTradeOption[], digit: number, duration: number, ready: boolean) => {
    const [ratios, setRatios] = useState<Record<string, number>>({});
    const key = options.map(o => o.contract_type).join(',');
    useEffect(() => {
        if (!ready) return undefined;
        let cancelled = false;
        setRatios({});
        options.forEach(o => {
            const needs_digit = Boolean(o.valid_digits);
            if (needs_digit && !o.valid_digits!.includes(digit)) return;
            scannerFeed
                .getPayout(
                    symbol,
                    { contract_type: o.contract_type, barrier: needs_digit ? digit : undefined },
                    duration
                )
                .then(ratio => !cancelled && setRatios(prev => ({ ...prev, [o.contract_type]: ratio })))
                .catch(() => undefined);
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [symbol, key, digit, duration, ready]);
    return ratios;
};

const ManualTrader = () => {
    const [settings, setSettings] = useState<TSettings>(load);
    const [buying, setBuying] = useState<string | null>(null);
    const [history, setHistory] = useState<TTradeResult[]>([]);
    const { isAuthorized, authData } = useApiBase();
    useSyncExternalStore(scannerFeed.subscribe, scannerFeed.getVersion);

    const update = (patch: Partial<TSettings>) => setSettings(prev => ({ ...prev, ...patch }));
    const trade_type = getTradeType(settings.type);
    const type_index = TRADE_TYPES.indexOf(trade_type);
    const markets = scannerFeed.sortedMarkets;
    const market = scannerFeed.markets.get(settings.symbol);
    const currency = authData?.currency || 'USD';
    const ratios = usePayoutRatios(
        settings.symbol,
        trade_type.options,
        settings.digit,
        settings.duration,
        scannerFeed.status === 'live'
    );

    useEffect(() => {
        scannerFeed.start();
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch {
            // ignore
        }
    }, [settings]);

    const prev_quote = market?.quotes[market.quotes.length - 2];
    const change = market?.last_quote != null && prev_quote != null ? market.last_quote - prev_quote : 0;
    const session_net = history.reduce((sum, t) => sum + t.profit, 0);

    const cycleType = (step: number) =>
        update({ type: TRADE_TYPES[(type_index + step + TRADE_TYPES.length) % TRADE_TYPES.length].key });

    const buy = async (option: TTradeOption) => {
        if (!isAuthorized) {
            login();
            return;
        }
        setBuying(option.contract_type);
        try {
            const result = await buyContract({
                symbol: settings.symbol,
                contract_type: option.contract_type,
                barrier: option.valid_digits ? settings.digit : undefined,
                stake: settings.stake,
                duration: settings.duration,
            });
            setHistory(prev => [result, ...prev].slice(0, 30));
            const message = result.is_win
                ? localize('Won {{amount}} {{currency}}', {
                      amount: result.profit.toFixed(2),
                      currency: result.currency,
                  })
                : localize('Lost {{amount}} {{currency}}', {
                      amount: Math.abs(result.profit).toFixed(2),
                      currency: result.currency,
                  });
            botNotification(message, undefined, { autoClose: 2500 });
        } catch (error) {
            botNotification((error as Error).message);
        } finally {
            setBuying(null);
        }
    };

    return (
        <div className='trading trading--manual'>
            <div className='trading__stage'>
                <div className='trading__market-head'>
                    <MarketSelect markets={markets} value={settings.symbol} onChange={symbol => update({ symbol })} />
                    {market?.last_quote != null && (
                        <span className='trading__quote'>
                            {market.last_quote.toFixed(market.decimals)}
                            <span className={change >= 0 ? 'trading__up' : 'trading__down'}>
                                {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(market.decimals)}
                            </span>
                        </span>
                    )}
                </div>
                <PriceChart market={market} />
                <DigitRing
                    market={market}
                    selected={trade_type.needs_digit ? settings.digit : undefined}
                    onSelect={trade_type.needs_digit ? digit => update({ digit }) : undefined}
                />
                <p className='trading__ring-caption'>
                    <Localize i18n_default_text='Digit frequency over the last 1000 ticks. Green is most frequent, red least.' />
                </p>
            </div>

            <aside className='trading__panel'>
                <div className='trading__type-switch'>
                    <button type='button' aria-label={localize('Previous trade type')} onClick={() => cycleType(-1)}>
                        ‹
                    </button>
                    <span>{trade_type.label}</span>
                    <button type='button' aria-label={localize('Next trade type')} onClick={() => cycleType(1)}>
                        ›
                    </button>
                </div>
                <p className='trading__help'>{trade_type.help}</p>

                <div className='trading__card'>
                    <label className='trading__label' htmlFor='manual-duration'>
                        <Localize i18n_default_text='Duration' />
                    </label>
                    <select
                        id='manual-duration'
                        className='trading__select'
                        value={settings.duration}
                        onChange={e => update({ duration: Number(e.target.value) })}
                    >
                        {DURATIONS.map(d => (
                            <option key={d} value={d}>
                                {d === 1 ? localize('1 tick') : localize('{{n}} ticks', { n: d })}
                            </option>
                        ))}
                    </select>
                </div>

                {trade_type.needs_digit && (
                    <div className='trading__card'>
                        <span className='trading__label'>
                            <Localize i18n_default_text='Last digit prediction' />
                        </span>
                        <div className='trading__digit-grid'>
                            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                <button
                                    type='button'
                                    key={d}
                                    className={classNames('trading__digit-btn', {
                                        'trading__digit-btn--active': d === settings.digit,
                                    })}
                                    onClick={() => update({ digit: d })}
                                >
                                    {d}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <div className='trading__card'>
                    <label className='trading__label' htmlFor='manual-stake'>
                        <Localize i18n_default_text='Stake ({{currency}})' values={{ currency }} />
                    </label>
                    <input
                        id='manual-stake'
                        className='trading__input'
                        type='number'
                        min={0.35}
                        step={0.5}
                        value={settings.stake}
                        onChange={e => update({ stake: Math.max(0, Number(e.target.value)) })}
                    />
                </div>

                <div className='trading__buy-row'>
                    {trade_type.options.map(option => {
                        const invalid = option.valid_digits && !option.valid_digits.includes(settings.digit);
                        const ratio = ratios[option.contract_type];
                        const fair = fairWinRate(
                            option.contract_type,
                            option.valid_digits ? settings.digit : undefined
                        );
                        return (
                            <button
                                type='button'
                                key={option.contract_type}
                                className={`trading__buy trading__buy--${option.tone}`}
                                disabled={Boolean(buying) || invalid || settings.stake < 0.35}
                                onClick={() => buy(option)}
                            >
                                <span className='trading__buy-label'>
                                    {buying === option.contract_type ? localize('Buying…') : option.label}
                                    {option.valid_digits ? ` ${settings.digit}` : ''}
                                </span>
                                <span className='trading__buy-meta'>
                                    {invalid
                                        ? localize('Not available')
                                        : ratio
                                          ? localize('Payout {{amount}}', {
                                                amount: (ratio * settings.stake).toFixed(2),
                                            })
                                          : '—'}
                                </span>
                                {fair !== undefined && ratio && !invalid && (
                                    <span className='trading__buy-meta'>
                                        {localize('Win chance {{p}}%', { p: Math.round(fair * 100) })}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
                {!isAuthorized && (
                    <p className='trading__login-hint'>
                        <Localize i18n_default_text='Log in to place trades. A demo account works.' />
                    </p>
                )}

                {history.length > 0 && (
                    <div className='trading__history'>
                        <div className='trading__history-head'>
                            <Localize i18n_default_text='This session' />
                            <span className={session_net >= 0 ? 'trading__up' : 'trading__down'}>
                                {session_net >= 0 ? '+' : ''}
                                {session_net.toFixed(2)} {currency}
                            </span>
                        </div>
                        <ul>
                            {history.map(t => (
                                <li key={t.contract_id}>
                                    <span>
                                        {t.contract_type.replace('DIGIT', '')}
                                        {t.barrier !== undefined ? ` ${t.barrier}` : ''}
                                    </span>
                                    <span className='trading__muted'>{t.exit_spot}</span>
                                    <span className={t.is_win ? 'trading__up' : 'trading__down'}>
                                        {t.profit >= 0 ? '+' : ''}
                                        {t.profit.toFixed(2)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </aside>
        </div>
    );
};

export default ManualTrader;
