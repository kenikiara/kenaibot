import React, { useEffect, useMemo, useState } from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { Localize, localize } from '@deriv-com/translations';
import './risk-management.scss';

const MIN_STAKE = 0.35;
const MAX_LADDER_ROWS = 8;

const APPETITES = [
    { pct: 5, label: localize('Conservative') },
    { pct: 10, label: localize('Moderate') },
    { pct: 15, label: localize('Aggressive') },
];

const RECOVERY_STYLES = [
    { mult: 1, label: localize('Flat') },
    { mult: 2, label: localize('2× Martingale') },
    { mult: 3, label: localize('3× Martingale') },
];

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Total staked across `losses` consecutive losing trades, multiplying the stake by `mult` after each. */
export const totalRisked = (stake: number, mult: number, losses: number) => {
    if (losses <= 0 || stake <= 0) return 0;
    return mult === 1 ? stake * losses : (stake * (mult ** losses - 1)) / (mult - 1);
};

/** How many losses in a row the balance can cover before the next stake is unaffordable. */
export const lossesSurvivable = (balance: number, stake: number, mult: number) => {
    if (stake <= 0 || balance <= 0) return 0;
    let losses = 0;
    while (losses < 200 && totalRisked(stake, mult, losses + 1) <= balance) losses++;
    return losses;
};

const riskTone = (pct: number) => {
    if (pct <= 5) return { label: localize('Low risk'), tone: 'safe' };
    if (pct <= 10) return { label: localize('Balanced'), tone: 'balanced' };
    if (pct <= 15) return { label: localize('High risk'), tone: 'warn' };
    return { label: localize('Very high risk'), tone: 'danger' };
};

const Stepper = ({
    value,
    onChange,
    min,
    max,
    label,
}: {
    value: number;
    onChange: (n: number) => void;
    min: number;
    max: number;
    label: string;
}) => (
    <div className='risk-management__stepper' aria-label={label}>
        <button type='button' onClick={() => onChange(clamp(value - 1, min, max))} aria-label={localize('Decrease')}>
            −
        </button>
        <span>{value}</span>
        <button type='button' onClick={() => onChange(clamp(value + 1, min, max))} aria-label={localize('Increase')}>
            +
        </button>
    </div>
);

const RiskManagement = observer(() => {
    const { client } = useStore();
    const currency = client?.currency || 'USD';
    const account_balance = parseFloat(String(client?.balance ?? '0')) || 0;

    const [balance_input, setBalanceInput] = useState(account_balance ? String(account_balance) : '');
    const [edited, setEdited] = useState(false);
    const [risk_pct, setRiskPct] = useState(10);
    const [mult, setMult] = useState(2);
    const [payout_pct, setPayoutPct] = useState(95);
    const [target_wins, setTargetWins] = useState(5);
    const [stop_losses, setStopLosses] = useState(3);

    useEffect(() => {
        if (!edited && account_balance > 0) setBalanceInput(String(account_balance));
    }, [account_balance, edited]);

    const plan = useMemo(() => {
        const balance = parseFloat(balance_input) || 0;
        const raw_stake = (balance * risk_pct) / 100;
        const stake = balance > 0 ? Math.max(MIN_STAKE, Math.round(raw_stake * 100) / 100) : 0;
        const flat_survival = lossesSurvivable(balance, stake, 1);
        const style_survival = lossesSurvivable(balance, stake, mult);
        const profit_per_win = (stake * payout_pct) / 100;
        const wins = clamp(target_wins, 1, 999);
        const take_profit = wins * profit_per_win;
        const safe_stop = clamp(stop_losses, 1, Math.max(1, (mult === 1 ? flat_survival : style_survival) || 1));
        const stop_loss = totalRisked(stake, mult, safe_stop);
        const ladder = Array.from({ length: Math.min(Math.max(style_survival, 1), MAX_LADDER_ROWS) }, (_, i) => {
            const n = i + 1;
            return { n, cumulative: totalRisked(stake, mult, n) };
        });
        return {
            balance,
            stake,
            below_min: balance > 0 && raw_stake < MIN_STAKE,
            effective_pct: balance > 0 ? (stake / balance) * 100 : 0,
            flat_survival,
            style_survival,
            take_profit,
            take_profit_pct: balance > 0 ? (take_profit / balance) * 100 : 0,
            stop_loss,
            stop_loss_pct: balance > 0 ? (stop_loss / balance) * 100 : 0,
            safe_stop,
            ladder,
        };
    }, [balance_input, risk_pct, mult, payout_pct, target_wins, stop_losses]);

    const money = useMemo(() => {
        try {
            const format = new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency,
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
            });
            return (n: number) => format.format(Number.isFinite(n) ? n : 0);
        } catch {
            return (n: number) => `${(Number.isFinite(n) ? n : 0).toFixed(2)} ${currency}`;
        }
    }, [currency]);

    const tone = riskTone(risk_pct);
    const max_stop = Math.max(1, mult === 1 ? plan.flat_survival : plan.style_survival);
    const style_label = mult === 1 ? localize('flat') : localize('{{mult}}× martingale', { mult });

    return (
        <div className='risk-management'>
            <div className='risk-management__inner'>
                <header className='risk-management__head'>
                    <h2>
                        <Localize i18n_default_text='Risk Management' />
                    </h2>
                    <p>
                        <Localize i18n_default_text='Enter your balance and pick a risk level to get a recommended stake, take-profit and stop-loss target — plus how many losses your account can survive.' />
                    </p>
                </header>

                <div className='risk-management__layout'>
                    <section className='risk-management__card'>
                        <h3>
                            <Localize i18n_default_text='Your setup' />
                        </h3>

                        <label className='risk-management__label' htmlFor='rm-balance'>
                            <Localize i18n_default_text='Account balance' />
                        </label>
                        <div className='risk-management__balance'>
                            <span>{currency}</span>
                            <input
                                id='rm-balance'
                                type='number'
                                inputMode='decimal'
                                min={0}
                                step='0.01'
                                placeholder='0.00'
                                value={balance_input}
                                onChange={e => {
                                    setEdited(true);
                                    setBalanceInput(e.target.value);
                                }}
                            />
                        </div>

                        <span className='risk-management__label'>
                            <Localize i18n_default_text='Risk appetite' />
                        </span>
                        <div className='risk-management__segments'>
                            {APPETITES.map(appetite => (
                                <button
                                    key={appetite.pct}
                                    type='button'
                                    className={classNames({ active: risk_pct === appetite.pct })}
                                    onClick={() => setRiskPct(appetite.pct)}
                                >
                                    {appetite.label}
                                    <small>{appetite.pct}%</small>
                                </button>
                            ))}
                        </div>

                        <div className='risk-management__label-row'>
                            <label className='risk-management__label' htmlFor='rm-risk'>
                                <Localize i18n_default_text='Risk per trade' />
                            </label>
                            <span className={`risk-management__pill risk-management__pill--${tone.tone}`}>
                                {risk_pct}% · {tone.label}
                            </span>
                        </div>
                        <input
                            id='rm-risk'
                            type='range'
                            min={1}
                            max={25}
                            value={risk_pct}
                            onChange={e => setRiskPct(Number(e.target.value))}
                        />

                        <span className='risk-management__label'>
                            <Localize i18n_default_text='Recovery style' />
                        </span>
                        <div className='risk-management__segments'>
                            {RECOVERY_STYLES.map(style => (
                                <button
                                    key={style.mult}
                                    type='button'
                                    className={classNames({ active: mult === style.mult })}
                                    onClick={() => setMult(style.mult)}
                                >
                                    {style.label}
                                </button>
                            ))}
                        </div>

                        <div className='risk-management__label-row'>
                            <label className='risk-management__label' htmlFor='rm-payout'>
                                <Localize i18n_default_text='Payout per win' />
                            </label>
                            <span>{payout_pct}%</span>
                        </div>
                        <input
                            id='rm-payout'
                            type='range'
                            min={5}
                            max={100}
                            value={payout_pct}
                            onChange={e => setPayoutPct(Number(e.target.value))}
                        />
                    </section>

                    <section className='risk-management__results'>
                        <div className='risk-management__hero'>
                            <span className='risk-management__eyebrow'>
                                <Localize i18n_default_text='Recommended stake per trade' />
                            </span>
                            <strong>{money(plan.stake)}</strong>
                            <div className='risk-management__chips'>
                                <span>
                                    {localize('{{pct}}% of balance', { pct: plan.effective_pct.toFixed(1).replace(/\.0$/, '') })}
                                </span>
                                <span>{tone.label}</span>
                            </div>
                            {plan.below_min && (
                                <p className='risk-management__warning'>
                                    {localize(
                                        'Raised to the {{min}} minimum stake, which is more than {{pct}}% of this balance.',
                                        { min: money(MIN_STAKE), pct: risk_pct }
                                    )}
                                </p>
                            )}
                        </div>

                        <div className='risk-management__targets'>
                            <div className='risk-management__target risk-management__target--profit'>
                                <div className='risk-management__target-head'>
                                    <span>
                                        <Localize i18n_default_text='Take profit' />
                                    </span>
                                    <span>+{plan.take_profit_pct.toFixed(1)}%</span>
                                </div>
                                <strong>{money(plan.take_profit)}</strong>
                                <div className='risk-management__target-row'>
                                    <span>
                                        <Localize i18n_default_text='Target wins' />
                                    </span>
                                    <Stepper
                                        label={localize('Target wins')}
                                        value={target_wins}
                                        min={1}
                                        max={999}
                                        onChange={setTargetWins}
                                    />
                                </div>
                                <small>{localize('Profit after {{count}} winning trades', { count: target_wins })}</small>
                            </div>

                            <div className='risk-management__target risk-management__target--loss'>
                                <div className='risk-management__target-head'>
                                    <span>
                                        <Localize i18n_default_text='Stop loss' />
                                    </span>
                                    <span>−{plan.stop_loss_pct.toFixed(1)}%</span>
                                </div>
                                <strong>{money(plan.stop_loss)}</strong>
                                <div className='risk-management__target-row'>
                                    <span>
                                        <Localize i18n_default_text='Stop after losses' />
                                    </span>
                                    <Stepper
                                        label={localize('Stop after losses')}
                                        value={plan.safe_stop}
                                        min={1}
                                        max={max_stop}
                                        onChange={setStopLosses}
                                    />
                                </div>
                                <small>
                                    {localize('Total risked over {{count}} consecutive losses', { count: plan.safe_stop })}
                                </small>
                            </div>
                        </div>

                        <div className='risk-management__survival'>
                            <div>
                                <strong>{plan.flat_survival}</strong>
                                <span>{localize('losses survivable · flat stake')}</span>
                            </div>
                            <div>
                                <strong>{plan.style_survival}</strong>
                                <span>{localize('losses survivable · {{style}}', { style: style_label })}</span>
                            </div>
                        </div>

                        <div className='risk-management__ladder'>
                            <span className='risk-management__eyebrow'>
                                <Localize i18n_default_text='Loss streak exposure' />
                            </span>
                            {plan.ladder.map(row => {
                                const pct = plan.balance > 0 ? (row.cumulative / plan.balance) * 100 : 0;
                                return (
                                    <div key={row.n} className='risk-management__ladder-row'>
                                        <span>{row.n}</span>
                                        <div className='risk-management__bar'>
                                            <div
                                                className={classNames({ danger: pct > 50, warn: pct > 25 && pct <= 50 })}
                                                style={{ width: `${clamp(pct, 0, 100)}%` }}
                                            />
                                        </div>
                                        <span>{Math.round(clamp(pct, 0, 999))}%</span>
                                    </div>
                                );
                            })}
                            <small>
                                <Localize i18n_default_text='Cumulative % of balance risked after each consecutive loss' />
                            </small>
                        </div>

                        <p className='risk-management__disclaimer'>
                            <Localize i18n_default_text='These figures are guidance to help you size trades and set limits — not a guarantee of results. Trading involves risk of loss.' />
                        </p>
                    </section>
                </div>
            </div>
        </div>
    );
});

export default RiskManagement;
