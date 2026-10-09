import React, { useEffect, useState, useSyncExternalStore } from 'react';
import classNames from 'classnames';
import { generateOAuthURL } from '@/components/shared';
import { useApiBase } from '@/hooks/useApiBase';
import { Localize, localize } from '@deriv-com/translations';
import { scannerFeed } from '../scanner/scanner-feed';
import { autoTrader, TAutoConfig, worstCaseLoss } from './auto-trader';
import { DigitRing, MarketSelect } from './components';
import { defaultParams, STRATEGIES, TStrategy } from './strategies';
import { getTradeType } from './trade-types';
import './trading.scss';

const SETTINGS_KEY = 'auto_trades_settings';
const MARTINGALES = [1, 1.5, 2, 2.1, 2.5, 3];

type TSettings = Omit<TAutoConfig, 'params'> & { params: Record<string, Record<string, number>> };

const DEFAULTS: TSettings = {
    strategy_key: STRATEGIES[0].key,
    params: Object.fromEntries(STRATEGIES.map(s => [s.key, defaultParams(s)])),
    symbol: '1HZ100V',
    stake: 1,
    martingale: 1,
    max_steps: 3,
    take_profit: 5,
    stop_loss: 5,
};

const load = (): TSettings => {
    try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
        return { ...DEFAULTS, ...saved, params: { ...DEFAULTS.params, ...saved.params } };
    } catch {
        return DEFAULTS;
    }
};

const NumberField = ({
    id,
    label,
    value,
    onChange,
    min = 0,
    step = 0.5,
    disabled,
}: {
    id: string;
    label: React.ReactNode;
    value: number;
    onChange: (n: number) => void;
    min?: number;
    step?: number;
    disabled?: boolean;
}) => (
    <div className='trading__field'>
        <label className='trading__label' htmlFor={id}>
            {label}
        </label>
        <input
            id={id}
            className='trading__input'
            type='number'
            min={min}
            step={step}
            value={value}
            disabled={disabled}
            onChange={e => onChange(Math.max(min, Number(e.target.value)))}
        />
    </div>
);

const AutoTrades = () => {
    const [settings, setSettings] = useState<TSettings>(load);
    const { isAuthorized, authData } = useApiBase();
    useSyncExternalStore(scannerFeed.subscribe, scannerFeed.getVersion);
    useSyncExternalStore(autoTrader.subscribe, autoTrader.getVersion);

    const state = autoTrader.state;
    const running = state.is_running;
    const currency = authData?.currency || 'USD';
    const strategy = STRATEGIES.find(s => s.key === settings.strategy_key) ?? STRATEGIES[0];
    const params = settings.params[strategy.key] ?? defaultParams(strategy);
    const market = scannerFeed.markets.get(settings.symbol);
    const worst = worstCaseLoss(settings.stake, settings.martingale, settings.max_steps);

    const update = (patch: Partial<TSettings>) => setSettings(prev => ({ ...prev, ...patch }));
    const setParam = (key: string, value: number) =>
        update({ params: { ...settings.params, [strategy.key]: { ...params, [key]: value } } });

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

    const start = async () => {
        if (!isAuthorized) {
            const url = await generateOAuthURL();
            if (url) window.location.replace(url);
            return;
        }
        autoTrader.start({ ...settings, params });
    };

    const grouped = STRATEGIES.reduce<Record<string, TStrategy[]>>((acc, s) => {
        (acc[s.trade_type] ??= []).push(s);
        return acc;
    }, {});

    const win_rate = state.trades ? (state.wins / state.trades) * 100 : 0;

    return (
        <div className='trading trading--auto'>
            <nav className='trading__strategies' aria-label={localize('Strategies')}>
                {Object.entries(grouped).map(([type, list]) => (
                    <div key={type} className='trading__strategy-group'>
                        <span className='trading__group-title'>{getTradeType(type as never).label}</span>
                        {list.map(s => (
                            <button
                                type='button'
                                key={s.key}
                                disabled={running}
                                className={classNames('trading__strategy', {
                                    'trading__strategy--active': s.key === strategy.key,
                                })}
                                onClick={() => update({ strategy_key: s.key })}
                            >
                                {s.name}
                            </button>
                        ))}
                    </div>
                ))}
            </nav>

            <div className='trading__auto-main'>
                <section className='trading__card trading__card--wide'>
                    <h2 className='trading__heading'>{strategy.name}</h2>
                    <p>{strategy.summary}</p>
                    <p className='trading__reality'>{strategy.reality}</p>
                    <div className='trading__param-row'>
                        <div className='trading__field'>
                            <label className='trading__label' htmlFor='auto-market'>
                                <Localize i18n_default_text='Market' />
                            </label>
                            <MarketSelect
                                markets={scannerFeed.sortedMarkets}
                                value={settings.symbol}
                                onChange={symbol => update({ symbol })}
                                disabled={running}
                            />
                        </div>
                        {strategy.params.map(p => (
                            <div className='trading__field' key={p.key}>
                                <label className='trading__label' htmlFor={`auto-${p.key}`}>
                                    {p.label}
                                </label>
                                <select
                                    id={`auto-${p.key}`}
                                    className='trading__select'
                                    value={params[p.key]}
                                    disabled={running}
                                    onChange={e => setParam(p.key, Number(e.target.value))}
                                >
                                    {p.options.map(o => (
                                        <option key={o.value} value={o.value}>
                                            {o.label}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        ))}
                    </div>
                    <DigitRing market={market} window={100} />
                </section>

                <section className='trading__card trading__card--wide'>
                    <h3 className='trading__subheading'>
                        <Localize i18n_default_text='Risk limits' />
                    </h3>
                    <div className='trading__param-row'>
                        <NumberField
                            id='auto-stake'
                            label={localize('Stake ({{currency}})', { currency })}
                            value={settings.stake}
                            min={0.35}
                            onChange={stake => update({ stake })}
                            disabled={running}
                        />
                        <div className='trading__field'>
                            <label className='trading__label' htmlFor='auto-martingale'>
                                <Localize i18n_default_text='Martingale' />
                            </label>
                            <select
                                id='auto-martingale'
                                className='trading__select'
                                value={settings.martingale}
                                disabled={running}
                                onChange={e => update({ martingale: Number(e.target.value) })}
                            >
                                {MARTINGALES.map(m => (
                                    <option key={m} value={m}>
                                        {m === 1 ? localize('Off') : `×${m}`}
                                    </option>
                                ))}
                            </select>
                        </div>
                        {settings.martingale > 1 && (
                            <NumberField
                                id='auto-steps'
                                label={localize('Max steps')}
                                value={settings.max_steps}
                                min={1}
                                step={1}
                                onChange={max_steps => update({ max_steps: Math.min(8, Math.round(max_steps)) })}
                                disabled={running}
                            />
                        )}
                        <NumberField
                            id='auto-tp'
                            label={localize('Take profit')}
                            value={settings.take_profit}
                            onChange={take_profit => update({ take_profit })}
                            disabled={running}
                        />
                        <NumberField
                            id='auto-sl'
                            label={localize('Stop loss')}
                            value={settings.stop_loss}
                            onChange={stop_loss => update({ stop_loss })}
                            disabled={running}
                        />
                    </div>
                    {settings.martingale > 1 && (
                        <p
                            className={classNames('trading__warning', {
                                'trading__warning--bad': worst > settings.stop_loss,
                            })}
                        >
                            <Localize
                                i18n_default_text='If {{steps}} martingale steps all lose, you lose {{worst}} {{currency}} in one run.'
                                values={{ steps: settings.max_steps + 1, worst: worst.toFixed(2), currency }}
                            />
                            {worst > settings.stop_loss && (
                                <>
                                    {' '}
                                    <Localize i18n_default_text='That is more than your stop loss, so the bot will stop before the last steps.' />
                                </>
                            )}
                        </p>
                    )}
                    <div className='trading__actions'>
                        {running ? (
                            <button
                                type='button'
                                className='trading__buy trading__buy--down'
                                onClick={() => autoTrader.stop()}
                            >
                                <span className='trading__buy-label'>
                                    <Localize i18n_default_text='Stop' />
                                </span>
                            </button>
                        ) : (
                            <button
                                type='button'
                                className='trading__buy trading__buy--up'
                                onClick={start}
                                disabled={settings.stake < 0.35 || settings.stop_loss <= 0 || settings.take_profit <= 0}
                            >
                                <span className='trading__buy-label'>
                                    {isAuthorized ? localize('Start') : localize('Log in to start')}
                                </span>
                            </button>
                        )}
                        {!running && state.trades > 0 && (
                            <button type='button' className='trading__ghost' onClick={() => autoTrader.reset()}>
                                <Localize i18n_default_text='Reset stats' />
                            </button>
                        )}
                        <span className='trading__muted'>
                            {running
                                ? state.is_buying
                                    ? localize('In a trade…')
                                    : localize('Waiting for entry signal…')
                                : state.stop_reason}
                        </span>
                    </div>
                </section>

                <section className='trading__card trading__card--wide'>
                    <div className='trading__tiles'>
                        <div className='trading__tile'>
                            <span className='trading__muted'>
                                <Localize i18n_default_text='Net P/L' />
                            </span>
                            <strong className={state.net >= 0 ? 'trading__up' : 'trading__down'}>
                                {state.net >= 0 ? '+' : ''}
                                {state.net.toFixed(2)}
                            </strong>
                        </div>
                        <div className='trading__tile'>
                            <span className='trading__muted'>
                                <Localize i18n_default_text='Trades' />
                            </span>
                            <strong>{state.trades}</strong>
                        </div>
                        <div className='trading__tile'>
                            <span className='trading__muted'>
                                <Localize i18n_default_text='Won / lost' />
                            </span>
                            <strong>
                                {state.wins} / {state.losses}
                            </strong>
                        </div>
                        <div className='trading__tile'>
                            <span className='trading__muted'>
                                <Localize i18n_default_text='Win rate' />
                            </span>
                            <strong>{win_rate.toFixed(1)}%</strong>
                        </div>
                        <div className='trading__tile'>
                            <span className='trading__muted'>
                                <Localize i18n_default_text='Next stake' />
                            </span>
                            <strong>{(running || state.trades ? state.next_stake : settings.stake).toFixed(2)}</strong>
                        </div>
                    </div>
                    {state.log.length > 0 && (
                        <div className='trading__history trading__history--flat'>
                            <ul>
                                {state.log.map(t => (
                                    <li key={t.contract_id}>
                                        <span>
                                            {t.contract_type.replace('DIGIT', '')}
                                            {t.barrier !== undefined ? ` ${t.barrier}` : ''}
                                        </span>
                                        <span className='trading__muted'>
                                            {localize('Stake {{s}}', { s: t.buy_price.toFixed(2) })}
                                        </span>
                                        <span className={t.is_win ? 'trading__up' : 'trading__down'}>
                                            {t.profit >= 0 ? '+' : ''}
                                            {t.profit.toFixed(2)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
};

export default AutoTrades;
