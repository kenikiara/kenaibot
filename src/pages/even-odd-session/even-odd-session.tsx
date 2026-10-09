import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { generateOAuthURL } from '@/components/shared';
import { useApiBase } from '@/hooks/useApiBase';
import { Localize, localize } from '@deriv-com/translations';
import {
    DEFAULT_SESSION,
    Field,
    ForecastCard,
    GoalFields,
    loadSettings,
    OpportunityBoard,
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
import { readMarket, TEntryConfig, TEntryRuleKey } from './entry-rules';
import { sessionRunner } from './session-runner';

const SETTINGS_KEY = 'even_odd_session_settings';

type TSettings = TSessionSettings & { market: string; entry: TEntryConfig };

const DEFAULTS: TSettings = {
    ...DEFAULT_SESSION,
    market: 'auto',
    entry: { rule: 'streak', streak: 4, window: 50, threshold: 0.6, fixed_side: 0 },
};

const pctLabel = (n: number) => `${Math.round(n * 100)}%`;

const EvenOddSession = () => {
    const [settings, setSettings] = useState<TSettings>(() => {
        const saved = loadSettings(SETTINGS_KEY, DEFAULTS);
        return { ...saved, entry: { ...DEFAULTS.entry, ...saved.entry } };
    });
    const [payout, setPayout] = useState(1.95);
    const { isAuthorized, authData } = useApiBase();
    useSyncExternalStore(scannerFeed.subscribe, scannerFeed.getVersion);
    useSyncExternalStore(sessionRunner.subscribe, sessionRunner.getVersion);

    const run = sessionRunner.state;
    const running = run.is_running;
    const currency = authData?.currency || 'USD';
    const update = (patch: Partial<TSettings>) => setSettings(prev => ({ ...prev, ...patch }));
    const updateEntry = (patch: Partial<TEntryConfig>) => update({ entry: { ...settings.entry, ...patch } });

    useEffect(() => {
        scannerFeed.start();
    }, []);

    useEffect(() => saveSettings(SETTINGS_KEY, settings), [settings]);

    // Live Even/Odd payout from the public socket; the same for every synthetic index
    const first_symbol = scannerFeed.sortedMarkets[0]?.symbol;
    useEffect(() => {
        if (!first_symbol || scannerFeed.status !== 'live') return;
        scannerFeed
            .getPayout(first_symbol, { contract_type: 'DIGITEVEN' })
            .then(setPayout)
            .catch(() => undefined);
    }, [first_symbol, scannerFeed.status]);

    const plan = toPlan(settings, payout, 0.5);
    const { forecast, counts } = useForecast(plan);

    const board = scannerFeed.sortedMarkets
        .filter(m => m.digits.length && (settings.market === 'auto' || m.symbol === settings.market))
        .map(m => ({ market: m, reading: readMarket(m, settings.entry) }))
        .sort((a, b) => b.reading.readiness - a.reading.readiness)
        .slice(0, 8)
        .map(({ market, reading }) => ({
            key: market.symbol,
            name: market.name,
            detail: reading.detail,
            readiness: reading.readiness,
            ready_label: reading.side ? (reading.side === 'DIGITEVEN' ? 'Even' : 'Odd') : null,
        }));

    const start = async () => {
        if (!isAuthorized) {
            const url = await generateOAuthURL();
            if (url) window.location.replace(url);
            return;
        }
        const { entry, market: only } = settings;
        sessionRunner.start({
            plan,
            min_probability: settings.min_probability,
            min_payout: settings.min_payout,
            pick: market => {
                if (only !== 'auto' && market.symbol !== only) return null;
                const side = readMarket(market, entry).side;
                return side ? { contract_type: side } : null;
            },
        });
    };

    const rule_options: { value: TEntryRuleKey; label: string }[] = [
        { value: 'streak', label: localize('After a streak') },
        { value: 'imbalance', label: localize('After an imbalance') },
        { value: 'fixed', label: localize('Every tick') },
    ];

    return (
        <div className='eos'>
            <header className='eos__head'>
                <div>
                    <h1 className='eos__title'>
                        <Localize i18n_default_text='Even/Odd Session' />
                    </h1>
                    <p className='eos__sub'>
                        <Localize i18n_default_text='Plan a session, see your real odds, then let it scan every market and trade within your limits.' />
                    </p>
                </div>
                <StatusPill state={run} />
            </header>

            <div className='eos__grid'>
                <div className='eos__setup'>
                    <Step n={1} title={localize('Your goal')}>
                        <GoalFields settings={settings} update={update} disabled={running} currency={currency} />
                    </Step>

                    <Step n={2} title={localize('How many trades?')}>
                        <TradeCountTable counts={counts} settings={settings} update={update} disabled={running} />
                    </Step>

                    <Step n={3} title={localize('Where and when to trade')}>
                        <div className='eos__fields'>
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
                            value={settings.entry.rule}
                            disabled={running}
                            onChange={rule => updateEntry({ rule })}
                            options={rule_options}
                        />
                        <div className='eos__fields eos__fields--tight'>
                            {settings.entry.rule === 'streak' && (
                                <Field
                                    label={localize('Same parity in a row')}
                                    hint={localize('Then buys the opposite side.')}
                                >
                                    <Select
                                        value={settings.entry.streak}
                                        disabled={running}
                                        onChange={v => updateEntry({ streak: Number(v) })}
                                        options={[2, 3, 4, 5, 6, 7, 8].map(n => ({ value: n, label: String(n) }))}
                                    />
                                </Field>
                            )}
                            {settings.entry.rule === 'imbalance' && (
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
                                    <Field
                                        label={localize('One side reaches')}
                                        hint={localize('Then buys the less frequent side.')}
                                    >
                                        <Select
                                            value={settings.entry.threshold}
                                            disabled={running}
                                            onChange={v => updateEntry({ threshold: Number(v) })}
                                            options={[0.55, 0.6, 0.65, 0.7].map(n => ({
                                                value: n,
                                                label: pctLabel(n),
                                            }))}
                                        />
                                    </Field>
                                </>
                            )}
                            {settings.entry.rule === 'fixed' && (
                                <Field label={localize('Side')}>
                                    <Select
                                        value={settings.entry.fixed_side}
                                        disabled={running}
                                        onChange={v => updateEntry({ fixed_side: Number(v) as 0 | 1 })}
                                        options={[
                                            { value: 0, label: localize('Even') },
                                            { value: 1, label: localize('Odd') },
                                        ]}
                                    />
                                </Field>
                            )}
                        </div>
                        <p className='eos__note'>
                            <Localize i18n_default_text='Entry rules only choose when and where to trade. Every tick is still a 50% chance, so they do not change the forecast.' />
                        </p>
                    </Step>

                    <Step n={4} title={localize('Safety stops')}>
                        <SafetyFields
                            settings={settings}
                            update={update}
                            disabled={running}
                            payout_options={[1.85, 1.9, 1.93, 1.95]}
                        />
                    </Step>
                </div>

                <aside className='eos__side'>
                    <ForecastCard
                        runner={sessionRunner}
                        plan={plan}
                        forecast={forecast}
                        win_label={`50% · ${localize('pays {{p}}', { p: payout.toFixed(2) })}`}
                        onStart={start}
                        is_authorized={isAuthorized}
                        start_label={localize('Start {{n}}-trade session', { n: settings.trades })}
                    />
                    <ProgressCard state={run} plan={sessionRunner.config?.plan ?? plan} currency={currency} />
                    <OpportunityBoard
                        rows={board}
                        hint={localize(
                            'Markets closest to your entry rule. The session trades the first one that fires.'
                        )}
                    />
                    <TradeLog state={run} />
                </aside>
            </div>
        </div>
    );
};

export default EvenOddSession;
