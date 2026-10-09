import React, { useDeferredValue, useMemo } from 'react';
import classNames from 'classnames';
import { Localize, localize } from '@deriv-com/translations';
import { TContractType } from '../trading/trade-types';
import { DigitRunner, TRunnerState } from './digit-runner';
import { compareTradeCounts, MIN_STAKE, nextStake, simulateSession, TSessionPlan, TStakePlan } from './session-math';
import './session.scss';

/** Building blocks shared by the Even/Odd session, Over/Under and Million Bot pages. */

export const pct = (p: number) => `${Math.round(p * 100)}%`;
export const money = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;

export const contractLabel = (contract_type: TContractType | string, barrier?: number) => {
    const names: Record<string, string> = {
        DIGITEVEN: 'Even',
        DIGITODD: 'Odd',
        DIGITOVER: 'Over',
        DIGITUNDER: 'Under',
        DIGITMATCH: 'Matches',
        DIGITDIFF: 'Differs',
    };
    const name = names[contract_type] ?? contract_type;
    return barrier === undefined ? name : `${name} ${barrier}`;
};

export type TSessionSettings = {
    trades: number;
    stake: number;
    stake_plan: TStakePlan;
    target: number;
    stop_loss: number;
    max_losing_streak: number;
    max_stake: number;
    min_probability: number;
    min_payout: number;
};

export const DEFAULT_SESSION: TSessionSettings = {
    trades: 10,
    stake: 1,
    stake_plan: 'flat',
    target: 3,
    stop_loss: 5,
    max_losing_streak: 5,
    max_stake: 3,
    min_probability: 0.25,
    min_payout: 1.9,
};

export const toPlan = (s: TSessionSettings, payout: number, win_probability: number): TSessionPlan => ({
    trades: s.trades,
    stake: s.stake,
    stake_plan: s.stake_plan,
    target: s.target,
    stop_loss: s.stop_loss,
    max_losing_streak: s.max_losing_streak,
    max_stake: s.max_stake,
    payout,
    win_probability,
});

export const isPlanInvalid = (plan: TSessionPlan) =>
    plan.stake < MIN_STAKE || plan.target <= 0 || plan.stop_loss < MIN_STAKE || nextStake(plan, 0) === null;

export const loadSettings = <T,>(key: string, defaults: T): T => {
    try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(key) ?? '{}') };
    } catch {
        return defaults;
    }
};

export const saveSettings = (key: string, value: unknown) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage can be unavailable in private mode
    }
};

/** Forecast and trade-count comparison, recomputed only when the plan changes. */
export const useForecast = (plan: TSessionPlan) => {
    const deferred = useDeferredValue(plan);
    const key = JSON.stringify(deferred);
    const forecast = useMemo(() => simulateSession(deferred), [key]); // eslint-disable-line react-hooks/exhaustive-deps
    const counts = useMemo(() => compareTradeCounts(deferred), [key]); // eslint-disable-line react-hooks/exhaustive-deps
    return { forecast, counts };
};

export const Segmented = <T extends string | number>({
    value,
    options,
    onChange,
    disabled,
    label,
}: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (v: T) => void;
    disabled?: boolean;
    label: string;
}) => (
    <div className='eos__segmented' role='radiogroup' aria-label={label}>
        {options.map(o => (
            <button
                key={String(o.value)}
                type='button'
                role='radio'
                aria-checked={o.value === value}
                disabled={disabled}
                className={classNames('eos__segment', { 'eos__segment--active': o.value === value })}
                onClick={() => onChange(o.value)}
            >
                {o.label}
            </button>
        ))}
    </div>
);

export const Field = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
    <label className='eos__field'>
        <span className='eos__label'>{label}</span>
        {children}
        {hint && <span className='eos__hint'>{hint}</span>}
    </label>
);

export const NumberInput = ({
    value,
    onChange,
    min = 0,
    step = 0.5,
    disabled,
}: {
    value: number;
    onChange: (n: number) => void;
    min?: number;
    step?: number;
    disabled?: boolean;
}) => (
    <input
        className='eos__input'
        type='number'
        min={min}
        step={step}
        value={value}
        disabled={disabled}
        onChange={e => onChange(Math.max(min, Number(e.target.value) || 0))}
    />
);

export const Select = ({
    value,
    options,
    onChange,
    disabled,
}: {
    value: number | string;
    options: { value: number | string; label: string }[];
    onChange: (v: string) => void;
    disabled?: boolean;
}) => (
    <select className='eos__select' value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
        {options.map(o => (
            <option key={o.value} value={o.value}>
                {o.label}
            </option>
        ))}
    </select>
);

export const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
    <section className='eos__card'>
        <h2 className='eos__step'>
            <span>{n}</span>
            {title}
        </h2>
        {children}
    </section>
);

type TSettingsProps = {
    settings: TSessionSettings;
    update: (patch: Partial<TSessionSettings>) => void;
    disabled: boolean;
    currency: string;
};

export const GoalFields = ({ settings, update, disabled, currency }: TSettingsProps) => (
    <>
        <div className='eos__fields'>
            <Field label={localize('Target profit ({{currency}})', { currency })}>
                <NumberInput value={settings.target} onChange={target => update({ target })} disabled={disabled} />
            </Field>
            <Field label={localize('Stop loss ({{currency}})', { currency })}>
                <NumberInput
                    value={settings.stop_loss}
                    onChange={stop_loss => update({ stop_loss })}
                    disabled={disabled}
                />
            </Field>
            <Field label={localize('Base stake ({{currency}})', { currency })}>
                <NumberInput
                    value={settings.stake}
                    min={MIN_STAKE}
                    onChange={stake => update({ stake })}
                    disabled={disabled}
                />
            </Field>
        </div>
        <div className='eos__plan-row'>
            <Segmented
                label={localize('Stake plan')}
                value={settings.stake_plan}
                disabled={disabled}
                onChange={stake_plan => update({ stake_plan })}
                options={[
                    { value: 'flat', label: localize('Flat stake') },
                    { value: 'recovery', label: localize('Recovery stake') },
                ]}
            />
            <span className='eos__hint'>
                {settings.stake_plan === 'flat'
                    ? localize('Same stake every trade. Smaller swings, lower chance of hitting a big target.')
                    : localize(
                          'Each stake is sized so one win reaches the target, capped by your largest stake and stop loss. Highest chance of hitting the target, but each loss is bigger.'
                      )}
            </span>
            {settings.stake_plan === 'recovery' && (
                <div className='eos__fields eos__fields--tight'>
                    <Field
                        label={localize('Largest single stake ({{currency}})', { currency })}
                        hint={localize('Keeps one losing trade from taking most of your stop loss.')}
                    >
                        <NumberInput
                            value={settings.max_stake}
                            min={MIN_STAKE}
                            onChange={max_stake => update({ max_stake })}
                            disabled={disabled}
                        />
                    </Field>
                </div>
            )}
        </div>
    </>
);

export const TradeCountTable = ({
    counts,
    settings,
    update,
    disabled,
}: Omit<TSettingsProps, 'currency'> & { counts: ReturnType<typeof compareTradeCounts> }) => (
    <>
        <p className='eos__hint'>
            <Localize i18n_default_text='Each row is 4,000 simulated sessions with your settings. Pick a row to use it.' />
        </p>
        <div className='eos__table-wrap'>
            <table className='eos__table'>
                <thead>
                    <tr>
                        <th>{localize('Trades')}</th>
                        <th>{localize('Reach target')}</th>
                        <th>{localize('Finish ahead')}</th>
                        <th>{localize('Avg result')}</th>
                    </tr>
                </thead>
                <tbody>
                    {counts.rows.map(({ trades, outcome }) => (
                        <tr
                            key={trades}
                            className={classNames({
                                'eos__row--active': trades === settings.trades,
                                'eos__row--disabled': disabled,
                            })}
                            onClick={() => !disabled && update({ trades })}
                        >
                            <td>
                                {trades}
                                {trades === counts.best && <span className='eos__best'>{localize('Best odds')}</span>}
                            </td>
                            <td>
                                <span className='eos__bar'>
                                    <span style={{ width: pct(outcome.p_target) }} />
                                </span>
                                {pct(outcome.p_target)}
                            </td>
                            <td>{pct(outcome.p_ahead)}</td>
                            <td className={outcome.avg_net >= 0 ? 'eos__up' : 'eos__down'}>{money(outcome.avg_net)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
        <Field label={localize('Or set your own')}>
            <NumberInput
                value={settings.trades}
                min={1}
                step={1}
                onChange={trades => update({ trades: Math.min(200, Math.round(trades)) })}
                disabled={disabled}
            />
        </Field>
    </>
);

export const SafetyFields = ({
    settings,
    update,
    disabled,
    payout_options,
}: Omit<TSettingsProps, 'currency'> & { payout_options: number[] }) => (
    <div className='eos__fields'>
        <Field label={localize('Stop after losses in a row')}>
            <Select
                value={settings.max_losing_streak}
                disabled={disabled}
                onChange={v => update({ max_losing_streak: Number(v) })}
                options={[
                    { value: 0, label: localize('Off') },
                    ...[1, 2, 3, 4, 5, 6, 8].map(n => ({ value: n, label: String(n) })),
                ]}
            />
        </Field>
        <Field label={localize('Stop when chance of target falls below')} hint={localize('Checked after every trade.')}>
            <Select
                value={settings.min_probability}
                disabled={disabled}
                onChange={v => update({ min_probability: Number(v) })}
                options={[
                    { value: 0, label: localize('Off') },
                    ...[0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6].map(n => ({ value: n, label: pct(n) })),
                ]}
            />
        </Field>
        <Field label={localize('Stop if payout per 1 drops below')}>
            <Select
                value={settings.min_payout}
                disabled={disabled}
                onChange={v => update({ min_payout: Number(v) })}
                options={payout_options.map(n => ({ value: n, label: n.toFixed(3) }))}
            />
        </Field>
    </div>
);

export const ForecastCard = ({
    runner,
    plan,
    forecast,
    win_label,
    onStart,
    is_authorized,
    start_label,
}: {
    runner: DigitRunner;
    plan: TSessionPlan;
    forecast: ReturnType<typeof simulateSession>;
    win_label: string;
    onStart: () => void;
    is_authorized: boolean;
    start_label: string;
}) => {
    const run = runner.state;
    const running = run.is_running;
    const live_p = run.p_target ?? forecast.p_target;
    const invalid = isPlanInvalid(plan);
    return (
        <section className='eos__card eos__forecast'>
            <span className='eos__label'>
                {running || run.trades_done
                    ? localize('Chance of reaching target now')
                    : localize('Chance of reaching target')}
            </span>
            <strong className='eos__big'>{pct(live_p)}</strong>
            <div className='eos__meter'>
                <span style={{ width: pct(live_p) }} />
            </div>
            <dl className='eos__facts'>
                <dt>{localize('Finish ahead')}</dt>
                <dd>{pct(forecast.p_ahead)}</dd>
                <dt>{localize('Hit a stop')}</dt>
                <dd>{pct(forecast.p_stopped)}</dd>
                <dt>{localize('Average result')}</dt>
                <dd className={forecast.avg_net >= 0 ? 'eos__up' : 'eos__down'}>{money(forecast.avg_net)}</dd>
                <dt>{localize('Bad session (1 in 20)')}</dt>
                <dd className='eos__down'>{money(forecast.bad_case)}</dd>
                <dt>{localize('Per trade')}</dt>
                <dd>{win_label}</dd>
                <dt>{localize('First stake')}</dt>
                <dd>{nextStake(plan, 0)?.toFixed(2) ?? '—'}</dd>
            </dl>
            {running ? (
                <button
                    type='button'
                    className='eos__go eos__go--stop'
                    onClick={() => runner.stop()}
                    disabled={run.is_stopping}
                >
                    {run.is_stopping ? localize('Stopping…') : localize('Stop now')}
                </button>
            ) : (
                <button type='button' className='eos__go' onClick={onStart} disabled={invalid}>
                    {is_authorized ? start_label : localize('Log in to start')}
                </button>
            )}
            {invalid && !running && (
                <p className='eos__warn'>
                    <Localize i18n_default_text='Stake must be at least 0.35, and target and stop loss above zero.' />
                </p>
            )}
            {!running && run.stop_reason && (
                <p className={`eos__result eos__result--${run.stop_tone}`}>{run.stop_reason}</p>
            )}
        </section>
    );
};

export const ProgressCard = ({
    state,
    plan,
    currency,
}: {
    state: TRunnerState;
    plan: TSessionPlan;
    currency: string;
}) => {
    if (!state.is_running && state.trades_done === 0) return null;
    const progress = plan.trades ? Math.min(state.trades_done / plan.trades, 1) : 0;
    return (
        <section className='eos__card'>
            <div className='eos__progress-head'>
                <span>
                    <Localize
                        i18n_default_text='Trade {{done}} of {{total}}'
                        values={{ done: state.trades_done, total: plan.trades }}
                    />
                </span>
                <strong className={state.net >= 0 ? 'eos__up' : 'eos__down'}>
                    {money(state.net)} {currency}
                </strong>
            </div>
            <div className='eos__meter eos__meter--progress'>
                <span style={{ width: pct(progress) }} />
            </div>
            <div className='eos__tiles'>
                <div>
                    <span>{localize('Won')}</span>
                    <strong className='eos__up'>{state.wins}</strong>
                </div>
                <div>
                    <span>{localize('Lost')}</span>
                    <strong className='eos__down'>{state.losses}</strong>
                </div>
                <div>
                    <span>{localize('Loss streak')}</span>
                    <strong>{state.losing_streak}</strong>
                </div>
                <div>
                    <span>{localize('Next stake')}</span>
                    <strong>{nextStake(plan, state.net)?.toFixed(2) ?? '—'}</strong>
                </div>
            </div>
        </section>
    );
};

export type TBoardRow = { key: string; name: string; detail: string; readiness: number; ready_label: string | null };

export const OpportunityBoard = ({ rows, hint }: { rows: TBoardRow[]; hint: string }) => (
    <section className='eos__card'>
        <h3 className='eos__card-title'>{localize('Opportunity board')}</h3>
        <p className='eos__hint'>{hint}</p>
        <ul className='eos__board'>
            {rows.map(row => (
                <li key={row.key} className={classNames({ 'eos__board--ready': row.ready_label })}>
                    <span className='eos__board-name'>{row.name}</span>
                    <span className='eos__board-detail'>{row.detail}</span>
                    <span className='eos__bar eos__bar--ready'>
                        <span style={{ width: pct(row.readiness) }} />
                    </span>
                    <span className='eos__board-side'>{row.ready_label ?? ''}</span>
                </li>
            ))}
            {rows.length === 0 && <li className='eos__hint'>{localize('Loading markets…')}</li>}
        </ul>
    </section>
);

export const TradeLog = ({ state }: { state: TRunnerState }) =>
    state.log.length ? (
        <section className='eos__card'>
            <h3 className='eos__card-title'>{localize('Trades')}</h3>
            <ul className='eos__log'>
                {state.log.map(t => (
                    <li key={t.contract_id}>
                        <span>{contractLabel(t.contract_type, t.barrier)}</span>
                        <span className='eos__hint'>{t.market_name}</span>
                        <span className='eos__hint'>{t.buy_price.toFixed(2)}</span>
                        <span className={t.is_win ? 'eos__up' : 'eos__down'}>{money(t.profit)}</span>
                    </li>
                ))}
            </ul>
        </section>
    ) : null;

export const StatusPill = ({ state }: { state: TRunnerState }) => (
    <span className={`eos__pill eos__pill--${state.is_running ? 'live' : 'idle'}`}>
        {state.is_running
            ? state.is_stopping
                ? localize('Stopping after this trade…')
                : state.is_buying
                  ? localize('In a trade…')
                  : localize('Scanning for entry…')
            : localize('Not running')}
    </span>
);
