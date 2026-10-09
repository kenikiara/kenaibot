import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import classNames from 'classnames';
import { Localize, localize } from '@deriv-com/translations';
import { useDevice } from '@deriv-com/ui';
import { requestAlertPermission, setAlertConfig } from './scanner-alerts';
import {
    backtestStreakRule,
    breakEvenRate,
    computeWindowStats,
    expectedReturn,
    getSides,
    TScanMode,
    TSide,
    TSideStats,
    TSignificance,
    TWindowStats,
} from './scanner-engine';
import { scannerFeed, TFeedStatus, TMarket } from './scanner-feed';
import './scanner.scss';

const WINDOWS = [25, 50, 100, 500, 1000];
const BARRIERS = [1, 2, 3, 4, 5, 6, 7, 8];
const STREAKS = [3, 4, 5, 6, 7, 8, 10, 12];
const SETTINGS_KEY = 'scanner_settings';

type TSettings = {
    mode: TScanMode;
    barrier: number;
    window: number;
    alerts: boolean;
    alert_streak: number;
    rule_trigger: number;
};

const DEFAULT_SETTINGS: TSettings = {
    mode: 'even_odd',
    barrier: 5,
    window: 100,
    alerts: false,
    alert_streak: 6,
    rule_trigger: 4,
};

const loadSettings = (): TSettings => {
    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
    } catch {
        return DEFAULT_SETTINGS;
    }
};

const pct = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const signed = (value: number, digits = 2) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;

const significanceLabel = (s: TSignificance) =>
    ({
        normal: localize('Normal noise'),
        unusual: localize('Unusual'),
        rare: localize('Rare'),
    })[s];

const statusLabel = (status: TFeedStatus, count: number) =>
    ({
        idle: localize('Paused'),
        connecting: localize('Connecting…'),
        live: localize('Live · {{count}} markets', { count }),
        reconnecting: localize('Reconnecting…'),
        error: localize('Connection problem, retrying'),
    })[status];

type TMarketRow = { market: TMarket; stats: TWindowStats };

const SignificanceBadge = ({ stats }: { stats: TSideStats }) => (
    <span
        className={`scanner__badge scanner__badge--${stats.significance}`}
        title={localize('z-score {{z}}', { z: stats.z.toFixed(2) })}
    >
        {significanceLabel(stats.significance)}
    </span>
);

const DigitChip = ({ digit, side }: { digit: number; side?: TSide }) => (
    <span
        className={classNames('scanner__chip', {
            'scanner__chip--win': side?.wins(digit),
            'scanner__chip--loss': side && !side.wins(digit),
        })}
    >
        {digit}
    </span>
);

const Segmented = <T extends string | number>({
    value,
    options,
    onChange,
    label,
}: {
    value: T;
    options: { value: T; label: React.ReactNode }[];
    onChange: (value: T) => void;
    label: string;
}) => (
    <div className='scanner__segmented' role='radiogroup' aria-label={label}>
        {options.map(o => (
            <button
                key={String(o.value)}
                type='button'
                role='radio'
                aria-checked={o.value === value}
                className={classNames('scanner__segment', { 'scanner__segment--active': o.value === value })}
                onClick={() => onChange(o.value)}
            >
                {o.label}
            </button>
        ))}
    </div>
);

const MarketTable = ({
    rows,
    sides,
    focused,
    onFocus,
}: {
    rows: TMarketRow[];
    sides: TSide[];
    focused: string | null;
    onFocus: (symbol: string) => void;
}) => (
    <div className='scanner__table-wrap'>
        <table className='scanner__table'>
            <thead>
                <tr>
                    <th>
                        <Localize i18n_default_text='Market' />
                    </th>
                    <th className='scanner__col-recent'>
                        <Localize i18n_default_text='Recent digits' />
                    </th>
                    {sides.map(side => (
                        <th key={side.key} className='scanner__num'>
                            {side.label}
                        </th>
                    ))}
                    <th className='scanner__num'>
                        <Localize i18n_default_text='Streak' />
                    </th>
                    <th>
                        <Localize i18n_default_text='Deviation' />
                    </th>
                </tr>
            </thead>
            <tbody>
                {rows.map(({ market, stats }) => {
                    const streak_side = stats.sides.reduce((a, b) => (b.win_streak > a.win_streak ? b : a));
                    return (
                        <tr
                            key={market.symbol}
                            className={classNames({ 'scanner__row--focused': market.symbol === focused })}
                            onClick={() => onFocus(market.symbol)}
                            tabIndex={0}
                            onKeyDown={e => e.key === 'Enter' && onFocus(market.symbol)}
                        >
                            <td className='scanner__market'>{market.name}</td>
                            <td className='scanner__col-recent'>
                                <span className='scanner__chips'>
                                    {market.digits.slice(-8).map((d, i) => (
                                        <DigitChip key={i} digit={d} side={sides[0]} />
                                    ))}
                                </span>
                            </td>
                            {stats.sides.map(s => (
                                <td
                                    key={s.side.key}
                                    className={classNames('scanner__num', {
                                        'scanner__num--above': s.rate > s.side.expected,
                                        'scanner__num--below': s.rate < s.side.expected,
                                    })}
                                >
                                    {pct(s.rate)}
                                </td>
                            ))}
                            <td className='scanner__num'>
                                {streak_side.win_streak} {streak_side.side.label}
                            </td>
                            <td>{stats.leader && <SignificanceBadge stats={stats.leader} />}</td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    </div>
);

const usePayouts = (symbol: string | undefined, sides: TSide[], status: TFeedStatus) => {
    const [payouts, setPayouts] = useState<Record<string, number>>({});
    const sides_key = sides.map(s => s.key).join(',');

    useEffect(() => {
        if (!symbol || status !== 'live') return undefined;
        let cancelled = false;
        Promise.all(
            sides.map(side =>
                scannerFeed
                    .getPayout(symbol, side)
                    .then(value => [side.key, value] as const)
                    .catch(() => null)
            )
        ).then(results => {
            if (cancelled) return;
            setPayouts(Object.fromEntries(results.filter(Boolean) as [string, number][]));
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [symbol, sides_key, status]);

    return payouts;
};

const SideCard = ({
    stats,
    payout,
    digits,
    trigger,
}: {
    stats: TSideStats;
    payout?: number;
    digits: number[];
    trigger: number;
}) => {
    const { side } = stats;
    const rule = payout ? backtestStreakRule(digits, side, trigger, payout) : null;
    return (
        <div className='scanner__side'>
            <div className='scanner__side-head'>
                <span className='scanner__side-name'>{side.label}</span>
                <SignificanceBadge stats={stats} />
            </div>
            <div className='scanner__side-rate'>
                <span className='scanner__big'>{pct(stats.rate)}</span>
                <span className='scanner__muted'>
                    <Localize i18n_default_text='expected {{rate}}' values={{ rate: pct(side.expected, 0) }} />
                </span>
            </div>
            <div className='scanner__meter' aria-hidden>
                <span className='scanner__meter-fill' style={{ width: pct(Math.min(stats.rate, 1)) }} />
                <span className='scanner__meter-mark' style={{ left: pct(side.expected) }} />
            </div>
            <dl className='scanner__facts'>
                <dt>
                    <Localize i18n_default_text='Current run' />
                </dt>
                <dd>
                    {stats.win_streak > 0
                        ? localize('{{count}} wins', { count: stats.win_streak })
                        : localize('{{count}} losses', { count: stats.loss_streak })}
                </dd>
                <dt>
                    <Localize i18n_default_text='Longest losing run' />
                </dt>
                <dd>{stats.longest_loss_streak}</dd>
                <dt>
                    <Localize i18n_default_text='Payout per $1' />
                </dt>
                <dd>{payout ? `$${payout.toFixed(2)}` : '—'}</dd>
                <dt>
                    <Localize i18n_default_text='Break-even win rate' />
                </dt>
                <dd>{payout ? pct(breakEvenRate(payout)) : '—'}</dd>
                <dt>
                    <Localize i18n_default_text='Expected return per trade' />
                </dt>
                <dd className={classNames({ scanner__neg: payout && expectedReturn(payout, side.expected) < 0 })}>
                    {payout ? `${signed(expectedReturn(payout, side.expected) * 100, 1)}%` : '—'}
                </dd>
            </dl>
            {rule && (
                <div className='scanner__rule'>
                    <div className='scanner__rule-title'>
                        <Localize
                            i18n_default_text='Last {{n}} ticks, buying {{side}} after every {{count}} losses in a row:'
                            values={{ n: digits.length, side: side.label, count: trigger }}
                        />
                    </div>
                    {rule.trades === 0 ? (
                        <span className='scanner__muted'>
                            <Localize
                                i18n_default_text='No trades would have triggered in the last {{n}} ticks.'
                                values={{ n: digits.length }}
                            />
                        </span>
                    ) : (
                        <div className='scanner__rule-stats'>
                            <span>
                                <Localize i18n_default_text='{{n}} trades' values={{ n: rule.trades }} />
                            </span>
                            <span>
                                <Localize i18n_default_text='{{rate}} won' values={{ rate: pct(rule.win_rate) }} />
                            </span>
                            <span className={rule.net >= 0 ? 'scanner__pos' : 'scanner__neg'}>
                                <Localize i18n_default_text='{{net}} per $1 stake' values={{ net: signed(rule.net) }} />
                            </span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

const MarketDetail = ({
    market,
    stats,
    sides,
    status,
    trigger,
}: {
    market: TMarket;
    stats: TWindowStats;
    sides: TSide[];
    status: TFeedStatus;
    trigger: number;
}) => {
    const payouts = usePayouts(market.symbol, sides, status);
    const last = market.digits[market.digits.length - 1];
    const max_count = Math.max(1, ...stats.digit_counts);

    return (
        <section className='scanner__detail' id='scanner-detail' aria-label={market.name}>
            <header className='scanner__detail-head'>
                <div>
                    <h2 className='scanner__detail-title'>{market.name}</h2>
                    <span className='scanner__muted'>
                        {market.last_quote?.toFixed(market.decimals)} ·{' '}
                        <Localize i18n_default_text='last {{n}} ticks' values={{ n: stats.sample_size }} />
                    </span>
                </div>
                {last !== undefined && <span className='scanner__last'>{last}</span>}
            </header>

            <div className='scanner__digits'>
                {stats.digit_counts.map((count, digit) => {
                    const share = stats.sample_size ? count / stats.sample_size : 0;
                    return (
                        <div
                            key={digit}
                            className={classNames('scanner__digit', {
                                'scanner__digit--current': digit === last,
                                'scanner__digit--win': sides[0]?.wins(digit),
                            })}
                        >
                            <span className='scanner__digit-bar' style={{ height: `${(count / max_count) * 100}%` }} />
                            <span className='scanner__digit-n'>{digit}</span>
                            <span className='scanner__digit-pct'>{pct(share)}</span>
                        </div>
                    );
                })}
            </div>

            <div className='scanner__recent'>
                {market.digits.slice(-30).map((d, i) => (
                    <DigitChip key={i} digit={d} side={sides[0]} />
                ))}
            </div>

            <div className='scanner__sides'>
                {stats.sides.map(s => (
                    <SideCard
                        key={s.side.key}
                        stats={s}
                        payout={payouts[s.side.key]}
                        digits={market.digits}
                        trigger={trigger}
                    />
                ))}
            </div>

            <p className='scanner__note'>
                <Localize i18n_default_text='Synthetic indices use an audited random number generator, so each digit is independent of the last. With many markets and windows on screen, a few "Unusual" readings are expected by chance at any moment. Past streaks do not change the odds of the next tick.' />
            </p>
        </section>
    );
};

const Scanner = () => {
    const [settings, setSettings] = useState<TSettings>(loadSettings);
    const [focused, setFocused] = useState<string | null>(null);
    const { isDesktop } = useDevice();

    const focusMarket = (symbol: string) => {
        setFocused(symbol);
        // The detail panel sits below the table on smaller screens
        if (!isDesktop) {
            requestAnimationFrame(() =>
                document.getElementById('scanner-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            );
        }
    };
    useSyncExternalStore(scannerFeed.subscribe, scannerFeed.getVersion);
    const { status } = scannerFeed;

    const update = (patch: Partial<TSettings>) => setSettings(prev => ({ ...prev, ...patch }));

    useEffect(() => {
        scannerFeed.start();
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch {
            // Storage can be unavailable in private mode
        }
        setAlertConfig({
            enabled: settings.alerts,
            mode: settings.mode,
            barrier: settings.barrier,
            streak: settings.alert_streak,
        });
    }, [settings]);

    const sides = useMemo(() => getSides(settings.mode, settings.barrier), [settings.mode, settings.barrier]);

    const rows = scannerFeed.sortedMarkets
        .filter(m => m.digits.length > 0)
        .map(market => ({ market, stats: computeWindowStats(market.digits, settings.window, sides) }))
        .sort((a, b) => Math.abs(b.stats.leader?.z ?? 0) - Math.abs(a.stats.leader?.z ?? 0));

    const focused_row = rows.find(r => r.market.symbol === focused) ?? rows[0];
    const is_running = scannerFeed.isRunning;

    return (
        <div className='scanner'>
            <div className='scanner__toolbar'>
                <div className='scanner__title-group'>
                    <h1 className='scanner__title'>
                        <Localize i18n_default_text='Digit Scanner' />
                    </h1>
                    <span className={`scanner__status scanner__status--${status}`}>
                        <span className='scanner__status-dot' />
                        {statusLabel(status, rows.length)}
                    </span>
                </div>
                <div className='scanner__controls'>
                    <Segmented
                        label={localize('Contract type')}
                        value={settings.mode}
                        onChange={mode => update({ mode })}
                        options={[
                            { value: 'even_odd', label: localize('Even / Odd') },
                            { value: 'over_under', label: localize('Over / Under') },
                        ]}
                    />
                    {settings.mode === 'over_under' && (
                        <label className='scanner__field'>
                            <Localize i18n_default_text='Barrier' />
                            <select
                                value={settings.barrier}
                                onChange={e => update({ barrier: Number(e.target.value) })}
                            >
                                {BARRIERS.map(b => (
                                    <option key={b} value={b}>
                                        {b}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}
                    <label className='scanner__field'>
                        <Localize i18n_default_text='Window' />
                        <select value={settings.window} onChange={e => update({ window: Number(e.target.value) })}>
                            {WINDOWS.map(w => (
                                <option key={w} value={w}>
                                    {w === 1 ? localize('1 tick') : localize('{{n}} ticks', { n: w })}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className='scanner__field'>
                        <Localize i18n_default_text='Rule check after' />
                        <select
                            value={settings.rule_trigger}
                            onChange={e => update({ rule_trigger: Number(e.target.value) })}
                        >
                            {STREAKS.map(n => (
                                <option key={n} value={n}>
                                    {localize('{{n}} losses', { n })}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className='scanner__alert'>
                        <label className='scanner__toggle'>
                            <input
                                type='checkbox'
                                checked={settings.alerts}
                                onChange={e => {
                                    if (e.target.checked) requestAlertPermission();
                                    update({ alerts: e.target.checked });
                                }}
                            />
                            <Localize i18n_default_text='Alert at' />
                        </label>
                        <select
                            aria-label={localize('Alert streak length')}
                            value={settings.alert_streak}
                            onChange={e => update({ alert_streak: Number(e.target.value) })}
                        >
                            {STREAKS.map(n => (
                                <option key={n} value={n}>
                                    {localize('{{n}} in a row', { n })}
                                </option>
                            ))}
                        </select>
                    </div>
                    <button
                        type='button'
                        className='scanner__button'
                        onClick={() => (is_running ? scannerFeed.stop() : scannerFeed.start())}
                    >
                        {is_running ? localize('Pause') : localize('Resume')}
                    </button>
                </div>
            </div>

            {rows.length === 0 ? (
                <div className='scanner__empty'>
                    {status === 'idle' ? (
                        <Localize i18n_default_text='Scanner is paused.' />
                    ) : (
                        <Localize i18n_default_text='Loading tick history for all markets…' />
                    )}
                </div>
            ) : (
                <div className='scanner__body'>
                    <MarketTable
                        rows={rows}
                        sides={sides}
                        focused={focused_row?.market.symbol ?? null}
                        onFocus={focusMarket}
                    />
                    {focused_row && (
                        <MarketDetail
                            market={focused_row.market}
                            stats={focused_row.stats}
                            sides={sides}
                            status={status}
                            trigger={settings.rule_trigger}
                        />
                    )}
                </div>
            )}
        </div>
    );
};

export default Scanner;
