import React, { useEffect, useState, useSyncExternalStore } from 'react';
import classNames from 'classnames';
import { generateOAuthURL } from '@/components/shared';
import { useApiBase } from '@/hooks/useApiBase';
import { Localize, localize } from '@deriv-com/translations';
import { compareTradeCounts } from '../digit-session/session-math';
import {
    DEFAULT_SESSION,
    Field,
    ForecastCard,
    GoalFields,
    loadSettings,
    OpportunityBoard,
    pct,
    ProgressCard,
    saveSettings,
    SafetyFields,
    Segmented,
    Select,
    StatusPill,
    Step,
    toPlan,
    TradeCountTable,
    TradeLog,
    TSessionSettings,
    useForecast,
} from '../digit-session/ui';
import { scannerFeed } from '../scanner/scanner-feed';
import { fetchPairPayouts, getPair, pooledHitRate, priceAll, TOUContract, TPricedPair } from './catalog';
import { DEFAULT_OU_ENTRY, readOverUnder, sidesFor, TOUEntry, TOUEntryMode, TOUSides } from './ou-entry';
import { overUnderRunner } from './ou-runner';

const SETTINGS_KEY = 'over_under_session_settings';
const HIT_WINDOW = 100;

type TSettings = TSessionSettings & { pair_b: number; market: string; entry: TOUEntry };

const DEFAULTS: TSettings = {
    ...DEFAULT_SESSION,
    trades: 20,
    max_losing_streak: 3,
    min_payout: 1.37,
    pair_b: 2,
    market: 'auto',
    entry: DEFAULT_OU_ENTRY,
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const evLabel = (ev: number) => `${ev >= 0 ? '+' : '−'}${Math.abs(ev * 100).toFixed(2)}%`;

const BestPairs = ({
    pairs,
    selected,
    onSelect,
    disabled,
}: {
    pairs: TPricedPair[];
    selected: number;
    onSelect: (b: number) => void;
    disabled: boolean;
}) => {
    const markets = scannerFeed.sortedMarkets;
    const ranked = [...pairs].sort((a, b) => b.ev - a.ev);
    const best = ranked[0]?.b;
    return (
        <div className='eos__table-wrap'>
            <table className='eos__table'>
                <thead>
                    <tr>
                        <th>{localize('Pair')}</th>
                        <th>{localize('Win chance')}</th>
                        <th>{localize('Payout')}</th>
                        <th>{localize('Cost per trade')}</th>
                        <th>{localize('Wins to cover a loss')}</th>
                        <th>{localize('Live hit rate (Over / Under)')}</th>
                    </tr>
                </thead>
                <tbody>
                    {ranked.map(p => (
                        <tr
                            key={p.key}
                            className={classNames({
                                'eos__row--active': p.b === selected,
                                'eos__row--disabled': disabled,
                            })}
                            onClick={() => !disabled && onSelect(p.b)}
                        >
                            <td>
                                {p.label}
                                {p.b === best && <span className='eos__best'>{localize('Lowest cost')}</span>}
                            </td>
                            <td>{pct(p.win_probability)}</td>
                            <td>{p.payout.toFixed(3)}</td>
                            <td className='eos__down'>{evLabel(p.ev)}</td>
                            <td>{p.wins_per_loss.toFixed(1)}</td>
                            <td>
                                {pct(pooledHitRate(markets, p.over, HIT_WINDOW))} /{' '}
                                {pct(pooledHitRate(markets, p.under, HIT_WINDOW))}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

const HighWinRate = ({
    pairs,
    onUse,
    disabled,
}: {
    pairs: TPricedPair[];
    onUse: (pair: TPricedPair, contract: TOUContract) => void;
    disabled: boolean;
}) => {
    const markets = scannerFeed.sortedMarkets;
    const picks = pairs
        .filter(p => p.win_probability >= 0.7)
        .sort((a, b) => b.ev - a.ev)
        .flatMap(p => [
            { pair: p, contract: p.over },
            { pair: p, contract: p.under },
        ]);
    return (
        <div className='ou__picks'>
            {picks.map(({ pair, contract }) => {
                const live = pooledHitRate(markets, contract, HIT_WINDOW);
                return (
                    <div key={contract.key} className='ou__pick'>
                        <div className='ou__pick-head'>
                            <strong>{contract.label}</strong>
                            <span className='eos__best'>
                                {localize('Wins {{p}}', { p: pct(pair.win_probability) })}
                            </span>
                        </div>
                        <dl className='eos__facts'>
                            <dt>{localize('Live hit rate (all markets)')}</dt>
                            <dd>{pct(live)}</dd>
                            <dt>{localize('Payout per 1')}</dt>
                            <dd>{pair.payout.toFixed(3)}</dd>
                            <dt>{localize('One loss wipes out')}</dt>
                            <dd className='eos__down'>
                                {localize('{{n}} wins', { n: pair.wins_per_loss.toFixed(1) })}
                            </dd>
                            <dt>{localize('Cost per trade')}</dt>
                            <dd className='eos__down'>{evLabel(pair.ev)}</dd>
                        </dl>
                        <button
                            type='button'
                            className='ou__use'
                            disabled={disabled}
                            onClick={() => onUse(pair, contract)}
                        >
                            {localize('Use safe settings')}
                        </button>
                    </div>
                );
            })}
        </div>
    );
};

const OverUnder = () => {
    const [settings, setSettings] = useState<TSettings>(() => {
        const saved = loadSettings(SETTINGS_KEY, DEFAULTS);
        return { ...saved, entry: { ...DEFAULTS.entry, ...saved.entry } };
    });
    const [payouts, setPayouts] = useState<Record<number, number>>({});
    const { isAuthorized, authData } = useApiBase();
    useSyncExternalStore(scannerFeed.subscribe, scannerFeed.getVersion);
    useSyncExternalStore(overUnderRunner.subscribe, overUnderRunner.getVersion);

    const run = overUnderRunner.state;
    const running = run.is_running;
    const currency = authData?.currency || 'USD';
    const update = (patch: Partial<TSettings>) => setSettings(prev => ({ ...prev, ...patch }));
    const updateEntry = (patch: Partial<TOUEntry>) => update({ entry: { ...settings.entry, ...patch } });

    useEffect(() => {
        scannerFeed.start();
    }, []);
    useEffect(() => saveSettings(SETTINGS_KEY, settings), [settings]);

    const first_symbol = scannerFeed.sortedMarkets[0]?.symbol;
    useEffect(() => {
        if (!first_symbol || scannerFeed.status !== 'live') return;
        fetchPairPayouts(first_symbol).then(setPayouts);
    }, [first_symbol, scannerFeed.status]);

    const priced = priceAll(payouts);
    const pair = priced.find(p => p.b === settings.pair_b) ?? priced[2];
    const plan = toPlan(settings, pair.payout, pair.win_probability);
    const { forecast, counts } = useForecast(plan);
    const payout_options = [0.97, 0.98, 0.99, 1].map(f => round3(pair.payout * f));

    // Keep the payout guard valid when the pair (and so its payout) changes
    useEffect(() => {
        if (!payout_options.includes(settings.min_payout)) update({ min_payout: payout_options[1] });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pair.payout]);

    const applySafe = (p: TPricedPair, contract: TOUContract) => {
        const stake = Math.max(0.35, settings.stake);
        const safe = {
            ...settings,
            pair_b: p.b,
            stake,
            stake_plan: 'flat' as const,
            target: round2(stake * (p.payout - 1) * 8),
            max_losing_streak: 2,
            min_probability: 0.3,
            entry: {
                ...settings.entry,
                mode: 'every' as TOUEntryMode,
                sides: (contract.contract_type === 'DIGITOVER' ? 'over' : 'under') as TOUSides,
            },
        };
        const best = compareTradeCounts(toPlan(safe, p.payout, p.win_probability), 2000).best;
        setSettings({ ...safe, trades: best, min_payout: round3(p.payout * 0.98) });
    };

    const board = scannerFeed.sortedMarkets
        .filter(m => m.digits.length && (settings.market === 'auto' || m.symbol === settings.market))
        .map(m => ({ market: m, reading: readOverUnder(m, getPair(settings.pair_b), settings.entry) }))
        .sort((a, b) => b.reading.readiness - a.reading.readiness)
        .slice(0, 8)
        .map(({ market, reading }) => ({
            key: market.symbol,
            name: market.name,
            detail: reading.detail,
            readiness: reading.readiness,
            ready_label: reading.contract?.label ?? null,
        }));

    const start = async () => {
        if (!isAuthorized) {
            const url = await generateOAuthURL();
            if (url) window.location.replace(url);
            return;
        }
        const { entry, market: only } = settings;
        const chosen = getPair(settings.pair_b);
        overUnderRunner.start({
            plan,
            min_probability: settings.min_probability,
            min_payout: settings.min_payout,
            pick: market => {
                if (only !== 'auto' && market.symbol !== only) return null;
                const { contract } = readOverUnder(market, chosen, entry);
                return contract ? { contract_type: contract.contract_type, barrier: contract.barrier } : null;
            },
        });
    };

    const side_options = sidesFor(getPair(settings.pair_b), 'pair');

    return (
        <div className='eos'>
            <header className='eos__head'>
                <div>
                    <h1 className='eos__title'>
                        <Localize i18n_default_text='Over/Under' />
                    </h1>
                    <p className='eos__sub'>
                        <Localize i18n_default_text='Find the best-value pair, set your limits, and let it trade wherever your entry rule fires first.' />
                    </p>
                </div>
                <StatusPill state={run} />
            </header>

            <div className='eos__grid'>
                <div className='eos__setup'>
                    <Step n={1} title={localize('Best pairs right now')}>
                        <p className='eos__hint'>
                            <Localize i18n_default_text='Ranked by real cost per trade from live payouts. Payouts are the same on every market, so the barrier is what matters. Click a pair to trade it.' />
                        </p>
                        <BestPairs
                            pairs={priced}
                            selected={settings.pair_b}
                            onSelect={pair_b => update({ pair_b })}
                            disabled={running}
                        />
                    </Step>

                    <Step n={2} title={localize('High win-rate picks')}>
                        <p className='eos__hint'>
                            <Localize i18n_default_text='Contracts that win 70–90% of ticks and repeat often. They are also the cheapest per trade, but nothing is guaranteed: a single loss erases many wins, so the safe settings use a flat stake and stop after 2 losses in a row.' />
                        </p>
                        <HighWinRate pairs={priced} onUse={applySafe} disabled={running} />
                    </Step>

                    <Step n={3} title={localize('Your goal')}>
                        <GoalFields settings={settings} update={update} disabled={running} currency={currency} />
                    </Step>

                    <Step n={4} title={localize('Entry and market')}>
                        <div className='eos__fields'>
                            <Field label={localize('Trade')}>
                                <Select
                                    value={settings.entry.sides}
                                    disabled={running}
                                    onChange={v => updateEntry({ sides: v as TOUSides })}
                                    options={[
                                        {
                                            value: 'pair',
                                            label: localize('Either side of {{pair}}', { pair: pair.label }),
                                        },
                                        { value: 'over', label: side_options[0].label },
                                        { value: 'under', label: side_options[1].label },
                                    ]}
                                />
                            </Field>
                            <Field label={localize('Market')}>
                                <Select
                                    value={settings.market}
                                    disabled={running}
                                    onChange={market => update({ market })}
                                    options={[
                                        { value: 'auto', label: localize('Auto: scan all markets') },
                                        ...scannerFeed.sortedMarkets.map(m => ({ value: m.symbol, label: m.name })),
                                    ]}
                                />
                            </Field>
                        </div>
                        <Segmented
                            label={localize('Entry rule')}
                            value={settings.entry.mode}
                            disabled={running}
                            onChange={mode => updateEntry({ mode })}
                            options={[
                                { value: 'cold', label: localize('After losses') },
                                { value: 'lagging', label: localize('When lagging') },
                                { value: 'every', label: localize('Every tick') },
                            ]}
                        />
                        <div className='eos__fields eos__fields--tight'>
                            {settings.entry.mode === 'cold' && (
                                <Field label={localize('Side lost in a row')}>
                                    <Select
                                        value={settings.entry.streak}
                                        disabled={running}
                                        onChange={v => updateEntry({ streak: Number(v) })}
                                        options={[1, 2, 3, 4, 5].map(n => ({ value: n, label: String(n) }))}
                                    />
                                </Field>
                            )}
                            {settings.entry.mode === 'lagging' && (
                                <>
                                    <Field label={localize('Look back')}>
                                        <Select
                                            value={settings.entry.window}
                                            disabled={running}
                                            onChange={v => updateEntry({ window: Number(v) })}
                                            options={[20, 50, 100, 200].map(n => ({
                                                value: n,
                                                label: localize('{{n}} ticks', { n }),
                                            }))}
                                        />
                                    </Field>
                                    <Field label={localize('Below expected by')}>
                                        <Select
                                            value={settings.entry.gap}
                                            disabled={running}
                                            onChange={v => updateEntry({ gap: Number(v) })}
                                            options={[0.05, 0.1, 0.15, 0.2].map(n => ({ value: n, label: pct(n) }))}
                                        />
                                    </Field>
                                </>
                            )}
                        </div>
                        <p className='eos__note'>
                            <Localize i18n_default_text='Entry rules choose when and where to trade. Each tick keeps the contract’s fixed win chance, so they do not change the forecast.' />
                        </p>
                    </Step>

                    <Step n={5} title={localize('How many trades?')}>
                        <TradeCountTable counts={counts} settings={settings} update={update} disabled={running} />
                    </Step>

                    <Step n={6} title={localize('Safety stops')}>
                        <SafetyFields
                            settings={settings}
                            update={update}
                            disabled={running}
                            payout_options={payout_options}
                        />
                    </Step>
                </div>

                <aside className='eos__side'>
                    <ForecastCard
                        runner={overUnderRunner}
                        plan={plan}
                        forecast={forecast}
                        win_label={`${pct(pair.win_probability)} · ${localize('pays {{p}}', { p: pair.payout.toFixed(3) })}`}
                        onStart={start}
                        is_authorized={isAuthorized}
                        start_label={localize('Start {{pair}} · {{n}} trades', {
                            pair: pair.label,
                            n: settings.trades,
                        })}
                    />
                    <ProgressCard state={run} plan={overUnderRunner.config?.plan ?? plan} currency={currency} />
                    <OpportunityBoard
                        rows={board}
                        hint={localize('Markets closest to your entry rule for {{pair}}.', { pair: pair.label })}
                    />
                    <TradeLog state={run} />
                </aside>
            </div>
        </div>
    );
};

export default OverUnder;
