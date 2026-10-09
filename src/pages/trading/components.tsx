import React from 'react';
import classNames from 'classnames';
import { Localize } from '@deriv-com/translations';
import { TMarket } from '../scanner/scanner-feed';

const CHART_POINTS = 120;

export const PriceChart = ({ market }: { market?: TMarket }) => {
    const quotes = market?.quotes.slice(-CHART_POINTS) ?? [];
    if (quotes.length < 2) {
        return (
            <div className='trading__chart trading__chart--empty'>
                <Localize i18n_default_text='Loading prices…' />
            </div>
        );
    }
    const min = Math.min(...quotes);
    const max = Math.max(...quotes);
    const span = max - min || 1;
    const w = 1000;
    const h = 400;
    const pad = 20;
    const x = (i: number) => (i / (quotes.length - 1)) * w;
    const y = (q: number) => pad + (1 - (q - min) / span) * (h - pad * 2);
    const line = quotes.map((q, i) => `${x(i).toFixed(1)},${y(q).toFixed(1)}`).join(' ');
    const last = quotes[quotes.length - 1];
    const last_y = (y(last) / h) * 100;

    return (
        <div className='trading__chart'>
            <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio='none' aria-hidden>
                <polygon className='trading__chart-area' points={`0,${h} ${line} ${w},${h}`} />
                <polyline className='trading__chart-line' points={line} vectorEffect='non-scaling-stroke' />
                <line
                    className='trading__chart-level'
                    x1={0}
                    x2={w}
                    y1={y(last)}
                    y2={y(last)}
                    vectorEffect='non-scaling-stroke'
                />
            </svg>
            <span className='trading__chart-price' style={{ top: `${last_y}%` }}>
                {last.toFixed(market?.decimals ?? 2)}
            </span>
            <span className='trading__chart-axis trading__chart-axis--max'>{max.toFixed(market?.decimals ?? 2)}</span>
            <span className='trading__chart-axis trading__chart-axis--min'>{min.toFixed(market?.decimals ?? 2)}</span>
        </div>
    );
};

const RING_R = 16;
const RING_C = 2 * Math.PI * RING_R;

export const DigitRing = ({
    market,
    window = 1000,
    selected,
    onSelect,
}: {
    market?: TMarket;
    window?: number;
    selected?: number;
    onSelect?: (digit: number) => void;
}) => {
    const digits = market?.digits.slice(-window) ?? [];
    const counts = new Array(10).fill(0);
    digits.forEach(d => counts[d]++);
    const shares = counts.map(c => (digits.length ? c / digits.length : 0));
    const max = Math.max(...shares);
    const min = Math.min(...shares);
    const last = digits[digits.length - 1];

    return (
        <div className='trading__ring-row'>
            {shares.map((share, digit) => (
                <button
                    type='button'
                    key={digit}
                    className={classNames('trading__ring', {
                        'trading__ring--high': digits.length > 0 && share === max,
                        'trading__ring--low': digits.length > 0 && share === min,
                        'trading__ring--current': digit === last,
                        'trading__ring--selected': digit === selected,
                    })}
                    onClick={() => onSelect?.(digit)}
                    disabled={!onSelect}
                    aria-label={`${digit}: ${(share * 100).toFixed(1)}%`}
                >
                    <svg viewBox='0 0 40 40' aria-hidden>
                        <circle className='trading__ring-track' cx='20' cy='20' r={RING_R} />
                        <circle
                            className='trading__ring-arc'
                            cx='20'
                            cy='20'
                            r={RING_R}
                            strokeDasharray={`${Math.min(share * 5, 1) * RING_C} ${RING_C}`}
                        />
                    </svg>
                    <span className='trading__ring-digit'>{digit}</span>
                    <span className='trading__ring-pct'>{(share * 100).toFixed(1)}%</span>
                </button>
            ))}
        </div>
    );
};

export const MarketSelect = ({
    markets,
    value,
    onChange,
    disabled,
}: {
    markets: TMarket[];
    value: string;
    onChange: (symbol: string) => void;
    disabled?: boolean;
}) => (
    <select
        className='trading__select trading__market-select'
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
    >
        {markets.length === 0 && <option value={value}>{value}</option>}
        {markets.map(m => (
            <option key={m.symbol} value={m.symbol}>
                {m.name}
            </option>
        ))}
    </select>
);
