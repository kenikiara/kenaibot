import React, { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { generateOAuthURL } from '@/components/shared';
import ChunkLoader from '@/components/loader/chunk-loader';
import { LogTypes } from '@/external/bot-skeleton';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { Localize, localize } from '@deriv-com/translations';
import { autoSession } from './engine/session';
import { TField, TMoneySettings, TSettingsValues, TStrategy } from './engine/types';
import { ALL_SYNTHETIC, marketName } from './strategies/helpers';
import { AUTO_STRATEGIES, DEFAULT_STRATEGY_ID, findStrategy } from './strategies';
import './auto-trades-pro.scss';

const ClassicAutoTrades = lazy(() => import('../trading/auto-trades'));

const CLASSIC_ID = 'classic';
const ACTIVE_KEY = 'auto_trades_pro_active';
const MONEY_KEY = 'auto_trades_pro_money';
const settingsKey = (id: string) => `auto_trades_pro_settings_${id}`;

const DEFAULT_MONEY: TMoneySettings = {
    symbol: 'R_100',
    stake: 1,
    martingale: 1,
    martingale_mode: 'normal',
    take_profit: 100,
    stop_loss_mode: 'amount',
    stop_loss: 100,
    max_losses: 4,
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

const GROUPS = ['Digits', 'Ups/Downs', 'Advanced'] as const;

const FieldInput = ({
    field,
    value,
    disabled,
    onChange,
}: {
    field: TField;
    value: any;
    disabled: boolean;
    onChange: (value: any) => void;
}) => {
    const id = `atp-${field.key}`;
    if (field.type === 'toggle') {
        return (
            <label className='atp__toggle' htmlFor={id}>
                <input id={id} type='checkbox' checked={Boolean(value)} disabled={disabled} onChange={e => onChange(e.target.checked)} />
                <span>{field.label}</span>
            </label>
        );
    }
    if (field.type === 'multi') {
        const selected: (string | number)[] = Array.isArray(value) ? value : [];
        return (
            <div className='atp__field atp__field--wide'>
                <span className='atp__label'>{field.label}</span>
                <div className='atp__chips'>
                    {(field.options ?? []).map(option => {
                        const is_on = selected.includes(option.value);
                        return (
                            <button
                                key={String(option.value)}
                                type='button'
                                disabled={disabled}
                                className={classNames('atp__chip', { 'atp__chip--on': is_on })}
                                onClick={() =>
                                    onChange(
                                        is_on ? selected.filter(v => v !== option.value) : [...selected, option.value]
                                    )
                                }
                            >
                                {option.label}
                            </button>
                        );
                    })}
                </div>
            </div>
        );
    }
    return (
        <div className='atp__field'>
            <label className='atp__label' htmlFor={id}>
                {field.label}
            </label>
            {field.type === 'select' ? (
                <select
                    id={id}
                    className='atp__input'
                    value={String(value)}
                    disabled={disabled}
                    onChange={e => {
                        const option = field.options?.find(o => String(o.value) === e.target.value);
                        onChange(option ? option.value : e.target.value);
                    }}
                >
                    {(field.options ?? []).map(option => (
                        <option key={String(option.value)} value={String(option.value)}>
                            {option.label}
                        </option>
                    ))}
                </select>
            ) : (
                <input
                    id={id}
                    className='atp__input'
                    type='number'
                    inputMode='decimal'
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={value}
                    disabled={disabled}
                    onChange={e => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n)) onChange(n);
                    }}
                />
            )}
        </div>
    );
};

const AutoTradesPro = observer(() => {
    const { transactions, summary_card, journal, client } = useStore();
    const { isAuthorized } = useApiBase();
    useSyncExternalStore(autoSession.subscribe, autoSession.getVersion);

    const [active_id, setActiveId] = useState<string>(() => {
        try {
            const saved = localStorage.getItem(ACTIVE_KEY);
            return saved && (saved === CLASSIC_ID || findStrategy(saved)) ? saved : DEFAULT_STRATEGY_ID;
        } catch {
            return DEFAULT_STRATEGY_ID;
        }
    });
    const [money, setMoney] = useState<TMoneySettings>(() => readJson(MONEY_KEY, DEFAULT_MONEY));
    const [error, setError] = useState('');
    const strategy = findStrategy(active_id);
    const [settings, setSettings] = useState<TSettingsValues>(() =>
        strategy ? readJson(settingsKey(strategy.id), strategy.defaults) : {}
    );
    const [sidebar_open, setSidebarOpen] = useState(true);

    const running_strategy = autoSession.strategy;
    const is_active = autoSession.isActive;
    const is_locked = is_active;

    useEffect(() => {
        if (strategy) setSettings(readJson(settingsKey(strategy.id), strategy.defaults));
        try {
            localStorage.setItem(ACTIVE_KEY, active_id);
        } catch {
            // storage unavailable
        }
    }, [active_id]);

    useEffect(() => writeJson(MONEY_KEY, money), [money]);
    useEffect(() => {
        if (strategy) writeJson(settingsKey(strategy.id), settings);
    }, [settings]);

    useEffect(() => {
        autoSession.setReporter({
            onSettled: result => {
                const contract = result.contract;
                if (!contract) return;
                const data = { ...contract, is_completed: true };
                transactions.onBotContractEvent(data);
                summary_card.onBotContractEvent(data);
                journal.onLogSuccess({
                    log_type: result.profit > 0 ? LogTypes.PROFIT : LogTypes.LOST,
                    extra: { currency: contract.currency ?? client.currency, profit: result.profit },
                });
            },
        });
    }, [transactions, summary_card, journal, client]);

    const visible_fields = useMemo(
        () => (strategy ? strategy.fields.filter(field => !field.visible || field.visible(settings)) : []),
        [strategy, settings]
    );

    const updateMoney = <K extends keyof TMoneySettings>(key: K, value: TMoneySettings[K]) =>
        setMoney(current => ({ ...current, [key]: value }));

    const start = async () => {
        setError('');
        if (!strategy) return;
        if (autoSession.status === 'paused') {
            autoSession.resume();
            return;
        }
        if (!strategy.signal_only && !isAuthorized) {
            const url = await generateOAuthURL();
            if (url) window.location.replace(url);
            return;
        }
        const problem = autoSession.start(strategy, { ...strategy.defaults, ...settings }, money);
        if (problem) setError(problem);
    };

    const renderStrategy = (item: TStrategy) => (
        <button
            key={item.id}
            type='button'
            className={classNames('atp__nav', {
                'atp__nav--active': active_id === item.id,
                'atp__nav--running': running_strategy?.id === item.id && is_active,
            })}
            disabled={is_locked && active_id !== item.id}
            title={is_locked && active_id !== item.id ? localize('Stop auto trading to switch strategies') : undefined}
            onClick={() => setActiveId(item.id)}
        >
            {item.label}
        </button>
    );

    const log = autoSession.log;
    const stats = [
        { label: localize('Runs'), value: autoSession.runs },
        { label: localize('Won'), value: autoSession.wins },
        { label: localize('Lost'), value: autoSession.losses },
        {
            label: localize('Profit/Loss'),
            value: `${autoSession.net >= 0 ? '+' : ''}${autoSession.net.toFixed(2)}`,
            tone: autoSession.net >= 0 ? 'win' : 'loss',
        },
        { label: localize('Next stake'), value: (is_active ? autoSession.current_stake : money.stake).toFixed(2) },
    ];

    return (
        <div className='atp'>
            {sidebar_open && (
                <aside className='atp__sidebar'>
                    <div className='atp__sidebar-head'>
                        <h3>
                            <Localize i18n_default_text='Auto Trades' />
                        </h3>
                        <button type='button' className='atp__collapse' onClick={() => setSidebarOpen(false)}>
                            ‹
                        </button>
                    </div>
                    {GROUPS.map(group => (
                        <div key={group} className='atp__group'>
                            <span className='atp__group-title'>{group}</span>
                            {AUTO_STRATEGIES.filter(item => item.group === group).map(renderStrategy)}
                        </div>
                    ))}
                    <div className='atp__group'>
                        <span className='atp__group-title'>{localize('More')}</span>
                        <button
                            type='button'
                            className={classNames('atp__nav', { 'atp__nav--active': active_id === CLASSIC_ID })}
                            disabled={is_locked}
                            onClick={() => setActiveId(CLASSIC_ID)}
                        >
                            {localize('Classic strategies')}
                        </button>
                    </div>
                </aside>
            )}

            <main className='atp__main'>
                {!sidebar_open && (
                    <button type='button' className='atp__expand' onClick={() => setSidebarOpen(true)}>
                        ☰ <Localize i18n_default_text='Strategies' />
                    </button>
                )}

                {active_id === CLASSIC_ID || !strategy ? (
                    <Suspense fallback={<ChunkLoader message={localize('Please wait, loading auto trades...')} />}>
                        <ClassicAutoTrades />
                    </Suspense>
                ) : (
                    <>
                        <div className='atp__card atp__title'>
                            <h2>{strategy.label}</h2>
                            <p>{strategy.summary}</p>
                        </div>

                        <div className='atp__columns'>
                            <section className='atp__card'>
                                <h4>
                                    <Localize i18n_default_text='Trade Settings' />
                                </h4>
                                <div className='atp__grid'>
                                    {strategy.uses_market && (
                                        <div className='atp__field'>
                                            <label className='atp__label' htmlFor='atp-market'>
                                                <Localize i18n_default_text='Market' />
                                            </label>
                                            <select
                                                id='atp-market'
                                                className='atp__input'
                                                value={money.symbol}
                                                disabled={is_locked}
                                                onChange={e => updateMoney('symbol', e.target.value)}
                                            >
                                                {ALL_SYNTHETIC.map(symbol => (
                                                    <option key={symbol} value={symbol}>
                                                        {marketName(symbol)}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                    )}
                                    {!strategy.signal_only && (
                                        <>
                                            <FieldInput
                                                field={{ key: 'stake', label: localize('Stake'), type: 'number', min: 0.35, step: 0.01 }}
                                                value={money.stake}
                                                disabled={is_locked}
                                                onChange={v => updateMoney('stake', v)}
                                            />
                                            <FieldInput
                                                field={{ key: 'martingale', label: localize('Martingale'), type: 'number', min: 1, step: 0.1 }}
                                                value={money.martingale}
                                                disabled={is_locked}
                                                onChange={v => updateMoney('martingale', v)}
                                            />
                                            <FieldInput
                                                field={{
                                                    key: 'martingale_mode',
                                                    label: localize('Martingale mode'),
                                                    type: 'select',
                                                    options: [
                                                        { value: 'normal', label: localize('Normal') },
                                                        { value: 'split', label: localize('Split (1×, 2×, 3×)') },
                                                    ],
                                                }}
                                                value={money.martingale_mode}
                                                disabled={is_locked}
                                                onChange={v => updateMoney('martingale_mode', v)}
                                            />
                                            <FieldInput
                                                field={{ key: 'take_profit', label: localize('Take profit'), type: 'number', min: 0.01, step: 0.5 }}
                                                value={money.take_profit}
                                                disabled={is_locked}
                                                onChange={v => updateMoney('take_profit', v)}
                                            />
                                            <FieldInput
                                                field={{
                                                    key: 'stop_loss_mode',
                                                    label: localize('Stop loss mode'),
                                                    type: 'select',
                                                    options: [
                                                        { value: 'amount', label: localize('Amount') },
                                                        { value: 'losses', label: localize('Number of losses') },
                                                    ],
                                                }}
                                                value={money.stop_loss_mode}
                                                disabled={is_locked}
                                                onChange={v => updateMoney('stop_loss_mode', v)}
                                            />
                                            {money.stop_loss_mode === 'amount' ? (
                                                <FieldInput
                                                    field={{ key: 'stop_loss', label: localize('Stop loss amount'), type: 'number', min: 0.01, step: 0.5 }}
                                                    value={money.stop_loss}
                                                    disabled={is_locked}
                                                    onChange={v => updateMoney('stop_loss', v)}
                                                />
                                            ) : (
                                                <FieldInput
                                                    field={{ key: 'max_losses', label: localize('Max losses in a row'), type: 'number', min: 1, step: 1 }}
                                                    value={money.max_losses}
                                                    disabled={is_locked}
                                                    onChange={v => updateMoney('max_losses', Math.round(v))}
                                                />
                                            )}
                                        </>
                                    )}
                                </div>

                                <div className='atp__actions'>
                                    {autoSession.status === 'running' && running_strategy?.id === strategy.id ? (
                                        <button type='button' className='atp__btn atp__btn--pause' onClick={() => autoSession.pause()}>
                                            <Localize i18n_default_text='Pause' />
                                        </button>
                                    ) : (
                                        <button
                                            type='button'
                                            className='atp__btn atp__btn--start'
                                            disabled={is_active && running_strategy?.id !== strategy.id}
                                            onClick={start}
                                        >
                                            {autoSession.status === 'paused'
                                                ? localize('Resume')
                                                : !strategy.signal_only && !isAuthorized
                                                  ? localize('Log in to start')
                                                  : localize('Start')}
                                        </button>
                                    )}
                                    <button
                                        type='button'
                                        className='atp__btn atp__btn--stop'
                                        disabled={!is_active}
                                        onClick={() => autoSession.stop()}
                                    >
                                        <Localize i18n_default_text='Stop' />
                                    </button>
                                </div>
                                {error && <p className='atp__error'>{error}</p>}
                                {!is_active && autoSession.stop_reason && running_strategy?.id === strategy.id && (
                                    <p className='atp__note'>{autoSession.stop_reason}</p>
                                )}
                            </section>

                            <section className='atp__card'>
                                <h4>
                                    <Localize i18n_default_text='Strategy Settings' />
                                </h4>
                                {visible_fields.length ? (
                                    <div className='atp__grid'>
                                        {visible_fields.map(field => (
                                            <FieldInput
                                                key={field.key}
                                                field={field}
                                                value={settings[field.key] ?? strategy.defaults[field.key]}
                                                disabled={is_locked}
                                                onChange={value => setSettings(current => ({ ...current, [field.key]: value }))}
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <p className='atp__note'>
                                        <Localize i18n_default_text='This strategy has no extra settings.' />
                                    </p>
                                )}
                            </section>
                        </div>

                        <section className='atp__card'>
                            <div className='atp__status-head'>
                                <h4>
                                    <Localize i18n_default_text='Status' />
                                </h4>
                                <span className={`atp__badge atp__badge--${is_active ? autoSession.status : 'idle'}`}>
                                    {is_active && running_strategy?.id === strategy.id
                                        ? autoSession.status === 'paused'
                                            ? localize('Paused')
                                            : autoSession.is_busy
                                              ? localize('Trade open')
                                              : localize('Running')
                                        : localize('Idle')}
                                </span>
                            </div>
                            {is_active && running_strategy?.id === strategy.id && (
                                <ul className='atp__status-lines'>
                                    {autoSession.statusLines.map(line => (
                                        <li key={line}>{line}</li>
                                    ))}
                                </ul>
                            )}
                            {!strategy.signal_only && (
                                <div className='atp__stats'>
                                    {stats.map(stat => (
                                        <div key={stat.label} className={classNames('atp__stat', stat.tone && `atp__stat--${stat.tone}`)}>
                                            <span>{stat.label}</span>
                                            <b>{stat.value}</b>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>

                        <section className='atp__card'>
                            <h4>
                                <Localize i18n_default_text='Activity' />
                            </h4>
                            {log.length ? (
                                <ul className='atp__log'>
                                    {log.map(entry => (
                                        <li
                                            key={entry.id}
                                            className={classNames(`atp__log-item atp__log-item--${entry.kind}`, {
                                                'atp__log-item--win': entry.is_win === true,
                                                'atp__log-item--loss': entry.is_win === false,
                                            })}
                                        >
                                            <time>{entry.time}</time>
                                            <span>{entry.text}</span>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className='atp__note'>
                                    <Localize i18n_default_text='Trades, virtual trades and signals will appear here.' />
                                </p>
                            )}
                        </section>

                        <p className='atp__disclaimer'>
                            <Localize i18n_default_text='Auto trades place real contracts on the account you are logged in with. Patterns describe past ticks; each tick is random, so no strategy changes the odds. Use stop loss and take profit, and try strategies on a demo account first.' />
                        </p>
                    </>
                )}
            </main>
        </div>
    );
});

export default AutoTradesPro;
