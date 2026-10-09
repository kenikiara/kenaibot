import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import classNames from 'classnames';
import { botNotification } from '@/components/bot-notification/bot-notification';
import { generateOAuthURL } from '@/components/shared';
import { useApiBase } from '@/hooks/useApiBase';
import { Localize, localize } from '@deriv-com/translations';
import { MIN_STAKE, simulateSession } from '../digit-session/session-math';
import {
    Field,
    ForecastCard,
    loadSettings,
    money,
    NumberInput,
    OpportunityBoard,
    pct,
    ProgressCard,
    saveSettings,
    Segmented,
    Select,
    StatusPill,
    Step,
    TradeLog,
} from '../digit-session/ui';
import { fetchPairPayouts, getPair, OU_PAIRS, priceAll } from '../over-under/catalog';
import { DEFAULT_OU_ENTRY, readOverUnder, TOUEntry } from '../over-under/ou-entry';
import { scannerFeed } from '../scanner/scanner-feed';
import { buildTopPick, planFor, scanPatterns, suggestParameters, TGoal, TSuggestion, TTopPick } from './analysis';
import { getMillionLive, millionRunner, startMillionBot } from './million-bot-runner';
import './million-bot.scss';

const SETTINGS_KEY = 'million_bot_settings';

type TSettings = {
    goal: TGoal;
    pattern_window: number;
    entry: TOUEntry;
    switch_after: number;
    rotate_entry: boolean;
    min_probability: number;
    payout_factor: number;
    applied: { b: number; stake_plan: 'flat' | 'recovery'; trades: number } | null;
};

const DEFAULTS: TSettings = {
    goal: { target: 3, stop_loss: 6, stake: 1, max_trades: 30, max_losing_streak: 4, max_stake: 3 },
    pattern_window: 100,
    entry: DEFAULT_OU_ENTRY,
    switch_after: 2,
    rotate_entry: true,
    min_probability: 0.2,
    payout_factor: 0.98,
    applied: null,
};

const heat = (z: number) => {
    const a = Math.min(Math.abs(z) / 3, 1) * 0.75;
    return z >= 0 ? `rgb(16 185 129 / ${a})` : `rgb(229 55 78 / ${a})`;
};

const MillionBot = () => {
    const [settings, setSettings] = useState<TSettings>(() => {
        const saved = loadSettings(SETTINGS_KEY, DEFAULTS);
        return { ...saved, goal: { ...DEFAULTS.goal, ...saved.goal }, entry: { ...DEFAULTS.entry, ...saved.entry } };
    });
    const [payouts, setPayouts] = useState<Record<number, number>>({});
    const [suggestions, setSuggestions] = useState<TSuggestion[]>([]);
    const [analysing, setAnalysing] = useState(false);
    const [scanned_at, setScannedAt] = useState<number | null>(null);
    const [combos, setCombos] = useState(0);
    const [top_pick, setTopPick] = useState<TTopPick | null>(null);
    const { isAuthorized, authData } = useApiBase();
    useSyncExternalStore(scannerFeed.subscribe, scannerFeed.getVersion);
    useSyncExternalStore(millionRunner.subscribe, millionRunner.getVersion);

    const run = millionRunner.state;
    const running = run.is_running;
    const currency = authData?.currency || 'USD';
    const { goal } = settings;
    const update = (patch: Partial<TSettings>) => setSettings(prev => ({ ...prev, ...patch }));
    const updateGoal = (patch: Partial<TGoal>) => update({ goal: { ...goal, ...patch } });

    useEffect(() => {
        scannerFeed.start();
    }, []);
    useEffect(() => saveSettings(SETTINGS_KEY, settings), [settings]);

    const markets = scannerFeed.sortedMarkets.filter(m => m.digits.length);
    const first_symbol = markets[0]?.symbol;
    useEffect(() => {
        if (!first_symbol || scannerFeed.status !== 'live') return;
        fetchPairPayouts(first_symbol).then(setPayouts);
    }, [first_symbol, scannerFeed.status]);

    const priced = useMemo(() => priceAll(payouts), [payouts]);
    const patterns = scanPatterns(markets, settings.pattern_window);
    const goal_invalid = goal.stake < MIN_STAKE || goal.target <= 0 || goal.stop_loss < MIN_STAKE;

    const analyse = () => {
        if (goal_invalid) return;
        setAnalysing(true);
        // Let the "Analysing…" state paint before the simulations run
        setTimeout(() => {
            const result = suggestParameters(goal, priced);
            // Show the best trade count for each pair and stake plan, not six near-copies
            const seen = new Set<string>();
            const distinct = result.filter(s => {
                const id = `${s.pair.b}-${s.stake_plan}`;
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
            });
            setSuggestions(distinct.slice(0, 6));
            setCombos(result.length);
            const pick = buildTopPick(goal, priced);
            setTopPick(pick);
            setScannedAt(Date.now());
            setAnalysing(false);
            // First visit: start from the top pick so Start is ready to go
            if (pick && !settings.applied) applyPick(pick, false);
        }, 30);
    };

    const applyPick = (pick: TTopPick, notify = true) => {
        const { pair, stake_plan, trades } = pick.suggestion;
        setSettings(prev => ({
            ...prev,
            applied: { b: pair.b, stake_plan, trades },
            entry: pick.entry,
            switch_after: pick.switch_after,
            rotate_entry: pick.rotate_entry,
            min_probability: pick.min_probability,
            payout_factor: pick.payout_factor,
            goal: { ...prev.goal, max_losing_streak: pick.max_losing_streak },
        }));
        if (notify) botNotification(localize('Top pick applied. Review the settings, then press Start.'));
    };

    const pick_applied =
        !!top_pick &&
        settings.applied?.b === top_pick.suggestion.pair.b &&
        settings.applied?.stake_plan === top_pick.suggestion.stake_plan &&
        settings.applied?.trades === top_pick.suggestion.trades &&
        settings.entry.mode === top_pick.entry.mode &&
        settings.entry.sides === top_pick.entry.sides &&
        settings.entry.streak === top_pick.entry.streak &&
        settings.switch_after === top_pick.switch_after &&
        settings.rotate_entry === top_pick.rotate_entry &&
        settings.min_probability === top_pick.min_probability &&
        settings.payout_factor === top_pick.payout_factor &&
        goal.max_losing_streak === top_pick.max_losing_streak;

    // Re-scan when the goal changes (the losing-streak stop is part of the pick, so it doesn't count)
    const goal_key = JSON.stringify({ ...goal, max_losing_streak: 0 });
    useEffect(() => {
        if (!scanned_at || running) return undefined;
        const timer = setTimeout(analyse, 600);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [goal_key]);

    // First analysis once markets and payouts are in
    const ready = markets.length > 0 && Object.keys(payouts).length > 0;
    useEffect(() => {
        if (ready && !scanned_at && !running) analyse();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ready]);

    const applied = settings.applied;
    const applied_pair = priced.find(p => p.b === (applied?.b ?? 2)) ?? priced[2];
    const applied_plan = planFor(goal, applied_pair, applied?.stake_plan ?? 'flat', applied?.trades ?? 10);
    const live_plan = millionRunner.config?.plan ?? applied_plan;
    const forecast = useMemo(() => simulateSession(applied_plan), [JSON.stringify(applied_plan)]); // eslint-disable-line react-hooks/exhaustive-deps

    const start = async () => {
        if (!isAuthorized) {
            const url = await generateOAuthURL();
            if (url) window.location.replace(url);
            return;
        }
        startMillionBot({
            goal,
            pairs: priced,
            suggestion: {
                key: 'applied',
                pair: applied_pair,
                stake_plan: applied_plan.stake_plan,
                trades: applied_plan.trades,
                plan: applied_plan,
                outcome: forecast,
            },
            entry: settings.entry,
            switch_after: settings.switch_after,
            rotate_entry: settings.rotate_entry,
            min_probability: settings.min_probability,
            payout_factor: settings.payout_factor,
        });
    };

    const live = running ? getMillionLive() : { pair: getPair(applied_pair.b), entry: settings.entry };
    const board = markets
        .map(m => ({ market: m, reading: readOverUnder(m, live.pair, live.entry) }))
        .sort((a, b) => b.reading.readiness - a.reading.readiness)
        .slice(0, 8)
        .map(({ market, reading }) => ({
            key: market.symbol,
            name: market.name,
            detail: reading.detail,
            readiness: reading.readiness,
            ready_label: reading.contract?.label ?? null,
        }));

    // Where the top pick would enter first right now
    const pick_next = top_pick
        ? markets
              .map(m => ({ market: m, reading: readOverUnder(m, getPair(top_pick.suggestion.pair.b), top_pick.entry) }))
              .sort((a, b) => b.reading.readiness - a.reading.readiness)[0]
        : undefined;

    return (
        <div className='eos'>
            <header className='eos__head'>
                <div>
                    <h1 className='eos__title'>
                        <Localize i18n_default_text='Million Bot' />
                    </h1>
                    <p className='eos__sub'>
                        <Localize i18n_default_text='Scans every Over/Under contract on every market, suggests the settings with the best odds for your goal, then trades and adapts as it goes.' />
                    </p>
                </div>
                <StatusPill state={run} />
            </header>

            <div className='eos__grid'>
                <div className='eos__setup'>
                    <Step n={1} title={localize('Your goal')}>
                        <div className='eos__fields'>
                            <Field label={localize('Target profit ({{currency}})', { currency })}>
                                <NumberInput
                                    value={goal.target}
                                    onChange={target => updateGoal({ target })}
                                    disabled={running}
                                />
                            </Field>
                            <Field label={localize('Stop loss ({{currency}})', { currency })}>
                                <NumberInput
                                    value={goal.stop_loss}
                                    onChange={stop_loss => updateGoal({ stop_loss })}
                                    disabled={running}
                                />
                            </Field>
                            <Field label={localize('Base stake ({{currency}})', { currency })}>
                                <NumberInput
                                    value={goal.stake}
                                    min={MIN_STAKE}
                                    onChange={stake => updateGoal({ stake })}
                                    disabled={running}
                                />
                            </Field>
                            <Field
                                label={localize('Largest single stake ({{currency}})', { currency })}
                                hint={localize('Caps recovery stakes.')}
                            >
                                <NumberInput
                                    value={goal.max_stake}
                                    min={MIN_STAKE}
                                    onChange={max_stake => updateGoal({ max_stake })}
                                    disabled={running}
                                />
                            </Field>
                            <Field label={localize('Most trades')}>
                                <Select
                                    value={goal.max_trades}
                                    disabled={running}
                                    onChange={v => updateGoal({ max_trades: Number(v) })}
                                    options={[10, 20, 30, 50].map(n => ({ value: n, label: String(n) }))}
                                />
                            </Field>
                        </div>
                    </Step>

                    <Step n={2} title={localize('Scan and suggested settings')}>
                        {top_pick && (
                            <div className={classNames('mb__pick', { 'mb__pick--applied': pick_applied })}>
                                <div className='mb__pick-main'>
                                    <span className='mb__pick-kicker'>
                                        <Localize i18n_default_text='Top pick · highest chance of reaching your target' />
                                    </span>
                                    <div className='mb__pick-title'>
                                        <strong>{top_pick.suggestion.pair.label}</strong>
                                        <span>
                                            {top_pick.suggestion.stake_plan === 'flat'
                                                ? localize('Flat stake')
                                                : localize('Recovery stake')}{' '}
                                            · {localize('{{n}} trades', { n: top_pick.suggestion.trades })}
                                        </span>
                                    </div>
                                    <div className='mb__pick-stats'>
                                        <div>
                                            <span>{localize('Reach target')}</span>
                                            <strong>{pct(top_pick.outcome.p_target)}</strong>
                                        </div>
                                        <div>
                                            <span>{localize('Win chance per trade')}</span>
                                            <strong>{pct(top_pick.suggestion.pair.win_probability)}</strong>
                                        </div>
                                        <div>
                                            <span>{localize('Average result')}</span>
                                            <strong className={top_pick.outcome.avg_net >= 0 ? 'eos__up' : 'eos__down'}>
                                                {money(top_pick.outcome.avg_net)}
                                            </strong>
                                        </div>
                                        <div>
                                            <span>{localize('Bad session (1 in 20)')}</span>
                                            <strong className='eos__down'>{money(top_pick.outcome.bad_case)}</strong>
                                        </div>
                                    </div>
                                    <ul className='mb__pick-params'>
                                        <li>{localize('Entry: either side, after 1 loss')}</li>
                                        <li>
                                            {localize('Re-scan after {{n}} losses in a row', {
                                                n: top_pick.switch_after,
                                            })}
                                        </li>
                                        <li>
                                            {top_pick.max_losing_streak
                                                ? localize('Stop after {{n}} losses in a row', {
                                                      n: top_pick.max_losing_streak,
                                                  })
                                                : localize('No losing-streak stop')}
                                        </li>
                                        <li>
                                            {localize('Stop if chance drops below {{p}}', {
                                                p: pct(top_pick.min_probability),
                                            })}
                                        </li>
                                        <li>{localize('Largest stake {{s}}', { s: goal.max_stake.toFixed(2) })}</li>
                                        <li>{localize('All markets scanned')}</li>
                                    </ul>
                                    {pick_next && (
                                        <p className='mb__pick-next'>
                                            <span
                                                className={classNames('mb__dot', {
                                                    'mb__dot--ready': pick_next.reading.contract,
                                                })}
                                            />
                                            {pick_next.reading.contract
                                                ? localize('Next entry: {{side}} on {{market}} now', {
                                                      side: pick_next.reading.contract.label,
                                                      market: pick_next.market.name,
                                                  })
                                                : localize('Next likely entry: {{market}} ({{detail}})', {
                                                      market: pick_next.market.name,
                                                      detail: pick_next.reading.detail,
                                                  })}
                                        </p>
                                    )}
                                </div>
                                <button
                                    type='button'
                                    className='mb__pick-use'
                                    disabled={running || analysing}
                                    onClick={() => applyPick(top_pick)}
                                >
                                    {pick_applied ? localize('Settings applied') : localize('Use this setup')}
                                </button>
                            </div>
                        )}
                        <div className='mb__scan-row'>
                            <button
                                type='button'
                                className='mb__scan'
                                onClick={analyse}
                                disabled={analysing || running || !ready || goal_invalid}
                            >
                                {analysing ? localize('Analysing…') : localize('Scan all contracts')}
                            </button>
                            <span className='eos__hint'>
                                {localize(
                                    '{{markets}} markets × 18 contracts · {{ticks}} ticks · {{combos}} setups simulated',
                                    {
                                        markets: markets.length,
                                        ticks: patterns.ticks.toLocaleString(),
                                        combos,
                                    }
                                )}
                            </span>
                        </div>
                        {suggestions.length > 0 && (
                            <div className='eos__table-wrap'>
                                <table className='eos__table'>
                                    <thead>
                                        <tr>
                                            <th>{localize('Pair')}</th>
                                            <th>{localize('Stake')}</th>
                                            <th>{localize('Trades')}</th>
                                            <th>{localize('Reach target')}</th>
                                            <th>{localize('Finish ahead')}</th>
                                            <th>{localize('Avg result')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {suggestions.map((s, i) => {
                                            const active =
                                                applied?.b === s.pair.b &&
                                                applied?.stake_plan === s.stake_plan &&
                                                applied?.trades === s.trades;
                                            return (
                                                <tr
                                                    key={s.key}
                                                    className={classNames({
                                                        'eos__row--active': active,
                                                        'eos__row--disabled': running,
                                                    })}
                                                    onClick={() =>
                                                        !running &&
                                                        update({
                                                            applied: {
                                                                b: s.pair.b,
                                                                stake_plan: s.stake_plan,
                                                                trades: s.trades,
                                                            },
                                                        })
                                                    }
                                                >
                                                    <td>
                                                        {s.pair.label}
                                                        {i === 0 && (
                                                            <span className='eos__best'>{localize('Suggested')}</span>
                                                        )}
                                                    </td>
                                                    <td>
                                                        {s.stake_plan === 'flat'
                                                            ? localize('Flat')
                                                            : localize('Recovery')}
                                                    </td>
                                                    <td>{s.trades}</td>
                                                    <td>
                                                        <span className='eos__bar'>
                                                            <span style={{ width: pct(s.outcome.p_target) }} />
                                                        </span>
                                                        {pct(s.outcome.p_target)}
                                                    </td>
                                                    <td>{pct(s.outcome.p_ahead)}</td>
                                                    <td className={s.outcome.avg_net >= 0 ? 'eos__up' : 'eos__down'}>
                                                        {money(s.outcome.avg_net)}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        <h3 className='eos__card-title mb__subtitle'>
                            <Localize i18n_default_text='Patterns across markets' />
                        </h3>
                        <div className='eos__fields eos__fields--tight'>
                            <Field label={localize('Look back')}>
                                <Select
                                    value={settings.pattern_window}
                                    onChange={v => update({ pattern_window: Number(v) })}
                                    options={[50, 100, 200, 500, 1000].map(n => ({
                                        value: n,
                                        label: localize('{{n}} ticks', { n }),
                                    }))}
                                />
                            </Field>
                        </div>
                        <div className='mb__heat-wrap'>
                            <table className='mb__heat'>
                                <thead>
                                    <tr>
                                        <th />
                                        {OU_PAIRS.map(p => (
                                            <th key={p.b}>{localize('Over {{b}}', { b: p.b })}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {markets.map(m => (
                                        <tr key={m.symbol}>
                                            <th>{m.name}</th>
                                            {OU_PAIRS.map(p => {
                                                const cell = patterns.cells.find(
                                                    c => c.symbol === m.symbol && c.b === p.b
                                                );
                                                return (
                                                    <td
                                                        key={p.b}
                                                        style={{ background: cell ? heat(cell.z) : undefined }}
                                                        title={
                                                            cell
                                                                ? `${pct(cell.rate)} vs ${pct(cell.expected)} · z ${cell.z.toFixed(1)}`
                                                                : ''
                                                        }
                                                    >
                                                        {cell ? pct(cell.rate) : ''}
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <p className='eos__hint'>
                            <Localize i18n_default_text='Green: Over hit more than expected (so the mirrored Under hit less). Red: the opposite. Hover a cell for details.' />
                        </p>
                        {patterns.strongest.length > 0 && (
                            <ul className='mb__patterns'>
                                {patterns.strongest.map(c => (
                                    <li key={`${c.symbol}-${c.b}`}>
                                        <strong>{c.market_name}</strong>
                                        <span>
                                            {localize('Over {{b}} hit {{rate}} vs {{exp}} expected', {
                                                b: c.b,
                                                rate: pct(c.rate),
                                                exp: pct(c.expected),
                                            })}
                                        </span>
                                        <span className='eos__hint'>z {c.z.toFixed(1)}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <p className='eos__note'>
                            {localize(
                                '{{unusual}} of {{cells}} readings are beyond ±2σ right now; about {{chance}} would be by pure chance. Digits come from an audited RNG, so these patterns do not carry forward, and the suggestions above do not use them.',
                                {
                                    unusual: patterns.unusual,
                                    cells: patterns.cells.length,
                                    chance: patterns.expected_by_chance,
                                }
                            )}
                        </p>
                    </Step>

                    <Step n={3} title={localize('Switching')}>
                        <div className='eos__fields'>
                            <Field
                                label={localize('Re-scan and switch after')}
                                hint={localize('Switches pair, stake plan and entry rule from the current position.')}
                            >
                                <Select
                                    value={settings.switch_after}
                                    disabled={running}
                                    onChange={v => update({ switch_after: Number(v) })}
                                    options={[
                                        { value: 0, label: localize('Never') },
                                        ...[1, 2, 3].map(n => ({
                                            value: n,
                                            label: localize('{{n}} losses in a row', { n }),
                                        })),
                                    ]}
                                />
                            </Field>
                            <Field label={localize('Rotate entry rule on switch')}>
                                <Select
                                    value={settings.rotate_entry ? 1 : 0}
                                    disabled={running}
                                    onChange={v => update({ rotate_entry: v === '1' })}
                                    options={[
                                        { value: 1, label: localize('Yes') },
                                        { value: 0, label: localize('No') },
                                    ]}
                                />
                            </Field>
                        </div>
                        <Segmented
                            label={localize('Starting entry rule')}
                            value={settings.entry.mode}
                            disabled={running}
                            onChange={mode => update({ entry: { ...settings.entry, mode } })}
                            options={[
                                { value: 'cold', label: localize('After a loss') },
                                { value: 'lagging', label: localize('When lagging') },
                                { value: 'every', label: localize('Every tick') },
                            ]}
                        />
                        <p className='eos__hint mb__gap'>
                            <Localize i18n_default_text='Markets are always scanned together: the bot trades whichever market fires first, so it moves between volatilities on its own.' />
                        </p>
                    </Step>

                    <Step n={4} title={localize('Safety stops')}>
                        <div className='eos__fields'>
                            <Field label={localize('Stop after losses in a row')}>
                                <Select
                                    value={goal.max_losing_streak}
                                    disabled={running}
                                    onChange={v => updateGoal({ max_losing_streak: Number(v) })}
                                    options={[
                                        { value: 0, label: localize('Off') },
                                        ...[2, 3, 4, 5, 6].map(n => ({ value: n, label: String(n) })),
                                    ]}
                                />
                            </Field>
                            <Field label={localize('Stop when chance of target falls below')}>
                                <Select
                                    value={settings.min_probability}
                                    disabled={running}
                                    onChange={v => update({ min_probability: Number(v) })}
                                    options={[
                                        { value: 0, label: localize('Off') },
                                        ...[0.1, 0.15, 0.2, 0.25, 0.3, 0.4].map(n => ({ value: n, label: pct(n) })),
                                    ]}
                                />
                            </Field>
                            <Field label={localize('Stop if payout falls by')}>
                                <Select
                                    value={settings.payout_factor}
                                    disabled={running}
                                    onChange={v => update({ payout_factor: Number(v) })}
                                    options={[
                                        { value: 0.99, label: '1%' },
                                        { value: 0.98, label: '2%' },
                                        { value: 0.97, label: '3%' },
                                    ]}
                                />
                            </Field>
                        </div>
                    </Step>
                </div>

                <aside className='eos__side'>
                    <ForecastCard
                        runner={millionRunner}
                        plan={applied_plan}
                        forecast={forecast}
                        win_label={`${applied_pair.label} · ${pct(applied_pair.win_probability)}`}
                        onStart={start}
                        is_authorized={isAuthorized}
                        start_label={localize('Start Million Bot')}
                    />
                    <ProgressCard state={run} plan={live_plan} currency={currency} />
                    {run.events.length > 0 && (
                        <section className='eos__card'>
                            <h3 className='eos__card-title'>{localize('Bot activity')}</h3>
                            <ul className='mb__events'>
                                {run.events.map((e, i) => (
                                    <li key={`${e.time}-${i}`}>
                                        <span className='eos__hint'>{new Date(e.time).toLocaleTimeString()}</span>
                                        <span>{e.text}</span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                    <OpportunityBoard
                        rows={board}
                        hint={localize('Where {{pair}} would enter next ({{mode}}).', {
                            pair: live.pair.label,
                            mode: live.entry.mode,
                        })}
                    />
                    <TradeLog state={run} />
                </aside>
            </div>
        </div>
    );
};

export default MillionBot;
