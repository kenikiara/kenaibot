import React, { useMemo, useState } from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { scanMarkets } from '@/components/ai-scanner/market-scan';
import DigitStats from '@/components/digit-stats';
import { useFeedMarket, useFeedMarkets } from '@/hooks/useFeedMarket';
import { Localize, localize } from '@deriv-com/translations';
import { evenOddSignal, evenOddStats, overUnderShares, rankDigits, riseFallStats, TPatternSignal } from './analysis';
import './ai-analysis.scss';

type TAnalysisType = 'even-odd' | 'matches-differs' | 'over-under' | 'rise-fall';

const GROUPS: { title: string; items: { id: TAnalysisType; label: string; icon: string }[] }[] = [
    {
        title: localize('Digits'),
        items: [
            { id: 'even-odd', label: localize('Even/Odd'), icon: '2|1' },
            { id: 'matches-differs', label: localize('Matches/Differs'), icon: '=' },
            { id: 'over-under', label: localize('Over/Under'), icon: '↕' },
        ],
    },
    { title: localize('Ups & Downs'), items: [{ id: 'rise-fall', label: localize('Rise/Fall'), icon: '↗↘' }] },
];

const TITLES: Record<TAnalysisType, string> = {
    'even-odd': localize('Even/Odd Analysis'),
    'matches-differs': localize('Matches/Differs Analysis'),
    'over-under': localize('Over/Under Analysis'),
    'rise-fall': localize('Rise/Fall Analysis'),
};

const TICK_WINDOWS = [10, 30, 50, 100, 500, 1000];

const STORAGE_KEY = 'ai_analysis_settings';

type TSettings = { type: TAnalysisType; symbol: string; ticks: number; over: number; under: number };

const DEFAULTS: TSettings = { type: 'even-odd', symbol: 'R_100', ticks: 1000, over: 4, under: 5 };

const readSettings = (): TSettings => {
    try {
        return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') };
    } catch {
        return DEFAULTS;
    }
};

const pct = (n: number) => `${n.toFixed(1)}%`;

const SignalCard = ({ signal }: { signal: TPatternSignal }) => (
    <div className='ai-analysis__card ai-analysis__signal'>
        <h4>
            <Localize i18n_default_text='Trading Signal' />
        </h4>
        <p className={classNames('ai-analysis__signal-headline', { 'ai-analysis__signal-headline--active': signal.side })}>
            {signal.headline}
        </p>
        <div className='ai-analysis__strength'>
            <span>{localize('Pattern strength: {{strength}}%', { strength: signal.strength })}</span>
            <div className='ai-analysis__meter'>
                <div style={{ width: `${signal.strength}%` }} />
            </div>
        </div>
        <p>{signal.detail}</p>
        <small>
            <Localize i18n_default_text='Patterns describe recent ticks only. Each tick is random, so a pattern does not make the next result more likely.' />
        </small>
    </div>
);

const RecentDigits = ({ digits, label }: { digits: number[]; label: (d: number) => string }) => (
    <div className='ai-analysis__recent'>
        {digits.slice(-10).map((digit, i) => (
            // Position-in-window keys: the list is a sliding window of repeated values
            // eslint-disable-next-line react/no-array-index-key
            <span key={i} className={`ai-analysis__recent-item ai-analysis__recent-item--${label(digit).toLowerCase()}`}>
                <small>{label(digit)}</small>
                {digit}
            </span>
        ))}
    </div>
);

const AiAnalysis = observer(() => {
    const [settings, setSettings] = useState<TSettings>(readSettings);
    const markets = useFeedMarkets();
    const market = useFeedMarket(settings.symbol);

    const update = (patch: Partial<TSettings>) =>
        setSettings(current => {
            const next = { ...current, ...patch };
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            } catch {
                // storage unavailable
            }
            return next;
        });

    const digits = useMemo(() => market?.digits.slice(-settings.ticks) ?? [], [market?.digits, settings.ticks, market?.last_epoch]);
    const quotes = useMemo(() => market?.quotes.slice(-(settings.ticks + 1)) ?? [], [market?.quotes, settings.ticks, market?.last_epoch]);
    const latest = market?.digits[market.digits.length - 1];

    const scanner_view = useMemo(() => {
        if (!market) return null;
        if (settings.type === 'matches-differs') return scanMarkets([market], 'matchesdiffers').signals[0] ?? null;
        if (settings.type === 'rise-fall') return scanMarkets([market], 'risefall').signals[0] ?? null;
        if (settings.type === 'over-under') return scanMarkets([market], 'overunder').signals[0] ?? null;
        return null;
    }, [market, settings.type, market?.last_epoch]);

    const renderBody = () => {
        if (!market || digits.length === 0) {
            return (
                <p className='ai-analysis__empty'>
                    <Localize i18n_default_text='Waiting for market data…' />
                </p>
            );
        }

        if (settings.type === 'even-odd') {
            const stats = evenOddStats(digits);
            return (
                <>
                    <div className='ai-analysis__card'>
                        <h4>
                            <Localize i18n_default_text='Distribution' />
                        </h4>
                        <div className='ai-analysis__split'>
                            <div>
                                <b>{localize('Even (0,2,4,6,8)')}</b>
                                <span>
                                    {stats.even_count} ({pct(stats.even_pct)})
                                </span>
                                {stats.streak.parity === 'even' && (
                                    <small>{localize('Current streak: {{count}} even', { count: stats.streak.length })}</small>
                                )}
                            </div>
                            <div>
                                <b>{localize('Odd (1,3,5,7,9)')}</b>
                                <span>
                                    {stats.odd_count} ({pct(stats.odd_pct)})
                                </span>
                                {stats.streak.parity === 'odd' && (
                                    <small>{localize('Current streak: {{count}} odd', { count: stats.streak.length })}</small>
                                )}
                            </div>
                        </div>
                        <div className='ai-analysis__bar'>
                            <div className='ai-analysis__bar-even' style={{ width: `${stats.even_pct}%` }} />
                        </div>
                    </div>
                    <div className='ai-analysis__card'>
                        <h4>
                            <Localize i18n_default_text='Recent Digits' />
                        </h4>
                        <RecentDigits digits={digits} label={d => (d % 2 === 0 ? 'E' : 'O')} />
                    </div>
                    <SignalCard signal={evenOddSignal(digits)} />
                </>
            );
        }

        if (settings.type === 'over-under') {
            const shares = overUnderShares(digits, settings.over, settings.under);
            return (
                <>
                    <div className='ai-analysis__card'>
                        <h4>
                            <Localize i18n_default_text='Compare Over / Under' />
                        </h4>
                        <div className='ai-analysis__selectors'>
                            <label>
                                {localize('Over')}
                                <select value={settings.over} onChange={e => update({ over: Number(e.target.value) })}>
                                    {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(d => (
                                        <option key={d} value={d}>
                                            {d}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label>
                                {localize('Under')}
                                <select value={settings.under} onChange={e => update({ under: Number(e.target.value) })}>
                                    {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                        <option key={d} value={d}>
                                            {d}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        </div>
                        <div className='ai-analysis__split'>
                            <div>
                                <b>{localize('Over {{digit}}', { digit: settings.over })}</b>
                                <span>{pct(shares.over_pct)}</span>
                            </div>
                            <div>
                                <b>{localize('Under {{digit}}', { digit: settings.under })}</b>
                                <span>{pct(shares.under_pct)}</span>
                            </div>
                        </div>
                        <small>
                            <Localize i18n_default_text='Click any digit above or use the selectors to compare Over/Under percentages.' />
                        </small>
                    </div>
                    <div className='ai-analysis__card'>
                        <h4>
                            <Localize i18n_default_text='Recent Digits' />
                        </h4>
                        <RecentDigits digits={digits} label={d => (d > settings.over ? 'O' : d < settings.under ? 'U' : '·')} />
                    </div>
                    <ScannerCard signal={scanner_view} />
                </>
            );
        }

        if (settings.type === 'matches-differs') {
            const ranked = rankDigits(digits);
            const most = ranked[0];
            const least = ranked[ranked.length - 1];
            return (
                <>
                    <div className='ai-analysis__card'>
                        <h4>
                            <Localize i18n_default_text='Most and least frequent' />
                        </h4>
                        <div className='ai-analysis__split'>
                            <div>
                                <b>{localize('Most frequent: {{digit}}', { digit: most.digit })}</b>
                                <span>{localize('Matches {{digit}} won {{pct}}', { digit: most.digit, pct: pct(most.pct) })}</span>
                            </div>
                            <div>
                                <b>{localize('Least frequent: {{digit}}', { digit: least.digit })}</b>
                                <span>
                                    {localize('Differs {{digit}} won {{pct}}', { digit: least.digit, pct: pct(100 - least.pct) })}
                                </span>
                            </div>
                        </div>
                    </div>
                    <div className='ai-analysis__card'>
                        <h4>
                            <Localize i18n_default_text='Recent Digits' />
                        </h4>
                        <RecentDigits digits={digits} label={d => (d === most.digit ? 'M' : 'D')} />
                    </div>
                    <ScannerCard signal={scanner_view} />
                </>
            );
        }

        const moves = riseFallStats(quotes);
        return (
            <>
                <div className='ai-analysis__card'>
                    <h4>
                        <Localize i18n_default_text='Rise vs Fall' />
                    </h4>
                    <div className='ai-analysis__split'>
                        <div>
                            <b>{localize('Rise')}</b>
                            <span>{pct(moves.rise_pct)}</span>
                        </div>
                        <div>
                            <b>{localize('Fall')}</b>
                            <span>{pct(moves.fall_pct)}</span>
                        </div>
                    </div>
                    <div className='ai-analysis__bar'>
                        <div className='ai-analysis__bar-even' style={{ width: `${moves.rise_pct}%` }} />
                    </div>
                    <small>
                        {moves.direction
                            ? localize('{{count}} price moves analysed · current run: {{run}} {{direction}}', {
                                  count: moves.moves,
                                  run: moves.streak,
                                  direction: moves.direction,
                              })
                            : localize('{{count}} price moves analysed', { count: moves.moves })}
                    </small>
                </div>
                <ScannerCard signal={scanner_view} />
            </>
        );
    };

    return (
        <div className='ai-analysis'>
            <aside className='ai-analysis__sidebar'>
                <h3>
                    <Localize i18n_default_text='Analysis Types' />
                </h3>
                {GROUPS.map(group => (
                    <div key={group.title} className='ai-analysis__group'>
                        <span className='ai-analysis__group-title'>{group.title}</span>
                        {group.items.map(item => (
                            <button
                                key={item.id}
                                type='button'
                                className={classNames('ai-analysis__nav', { 'ai-analysis__nav--active': settings.type === item.id })}
                                onClick={() => update({ type: item.id })}
                            >
                                <span className='ai-analysis__nav-icon'>{item.icon}</span>
                                {item.label}
                            </button>
                        ))}
                    </div>
                ))}
            </aside>

            <main className='ai-analysis__main'>
                <div className='ai-analysis__title'>{TITLES[settings.type]}</div>

                <div className='ai-analysis__controls'>
                    <label>
                        {localize('Market:')}
                        <select value={settings.symbol} onChange={e => update({ symbol: e.target.value })}>
                            {(markets.length ? markets : [{ symbol: settings.symbol, name: settings.symbol }]).map(m => (
                                <option key={m.symbol} value={m.symbol}>
                                    {m.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        {localize('Ticks:')}
                        <select value={settings.ticks} onChange={e => update({ ticks: Number(e.target.value) })}>
                            {TICK_WINDOWS.map(value => (
                                <option key={value} value={value}>
                                    {localize('{{count}} ticks', { count: value })}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>

                {latest !== undefined && (
                    <div className='ai-analysis__last'>
                        <span>
                            <Localize i18n_default_text='Last Digit' />
                        </span>
                        <b>{latest}</b>
                    </div>
                )}

                {digits.length > 0 && (
                    <DigitStats
                        digits={digits}
                        size='large'
                        selected={settings.type === 'over-under' ? [settings.over, settings.under] : []}
                        onSelect={
                            settings.type === 'over-under'
                                ? digit => update({ over: Math.min(digit, 8), under: Math.max(digit, 1) })
                                : undefined
                        }
                    />
                )}

                <div className='ai-analysis__panels'>{renderBody()}</div>
            </main>
        </div>
    );
});

const ScannerCard = ({ signal }: { signal: ReturnType<typeof scanMarkets>['signals'][number] | null }) => (
    <div className='ai-analysis__card ai-analysis__signal'>
        <h4>
            <Localize i18n_default_text='Trading Signal' />
        </h4>
        {signal ? (
            <>
                <p className='ai-analysis__signal-headline ai-analysis__signal-headline--active'>{signal.direction}</p>
                <div className='ai-analysis__strength'>
                    <span>{localize('Recent win share: {{pct}}%', { pct: Math.round(signal.confidence) })}</span>
                    <div className='ai-analysis__meter'>
                        <div style={{ width: `${signal.confidence}%` }} />
                    </div>
                </div>
                <p>{signal.note}</p>
            </>
        ) : (
            <p className='ai-analysis__signal-headline'>
                <Localize i18n_default_text='No market rule is met right now — wait for clearer data.' />
            </p>
        )}
        <small>
            <Localize i18n_default_text='Uses up to the last 1000 ticks. Each tick is random, so past shares do not make the next result more likely.' />
        </small>
    </div>
);

export default AiAnalysis;
