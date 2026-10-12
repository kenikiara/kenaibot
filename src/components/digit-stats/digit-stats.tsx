import React, { useMemo } from 'react';
import classNames from 'classnames';
import './digit-stats.scss';

type TDigitStatsProps = {
    /** Last digits, oldest first, already cut to the window being analysed. */
    digits: number[];
    /** Digit to mark as the latest tick; defaults to the last entry of `digits`. */
    current?: number;
    size?: 'small' | 'large';
    onSelect?: (digit: number) => void;
    selected?: number[];
};

export const digitPercentages = (digits: number[]) => {
    const counts = Array(10).fill(0);
    digits.forEach(digit => counts[digit]++);
    return counts.map(count => (digits.length ? (count / digits.length) * 100 : 0));
};

/**
 * Ten digit circles with their share of recent ticks. The most frequent digit
 * is ringed green, the second most frequent yellow, the least frequent red and
 * the latest tick blue.
 */
const DigitStats = ({ digits, current, size = 'small', onSelect, selected = [] }: TDigitStatsProps) => {
    const percentages = useMemo(() => digitPercentages(digits), [digits]);
    const latest = current ?? digits[digits.length - 1];

    const { highest, second, lowest } = useMemo(() => {
        const distinct = [...new Set(percentages)].sort((a, b) => b - a);
        return {
            highest: distinct[0],
            second: distinct[1],
            lowest: distinct[distinct.length - 1],
        };
    }, [percentages]);

    return (
        <div className={classNames('digit-stats', `digit-stats--${size}`)}>
            {percentages.map((pct, digit) => (
                <button
                    type='button'
                    key={digit}
                    disabled={!onSelect}
                    onClick={() => onSelect?.(digit)}
                    className={classNames('digit-stats__digit', {
                        'digit-stats__digit--highest': digits.length > 0 && pct === highest,
                        'digit-stats__digit--second': digits.length > 0 && pct === second && pct !== lowest,
                        'digit-stats__digit--lowest': digits.length > 0 && pct === lowest && pct !== highest,
                        'digit-stats__digit--current': digit === latest,
                        'digit-stats__digit--selected': selected.includes(digit),
                    })}
                >
                    <span className='digit-stats__value'>{digit}</span>
                    <span className='digit-stats__pct'>{pct.toFixed(1)}%</span>
                    {digit === latest && <span className='digit-stats__marker' aria-hidden='true' />}
                </button>
            ))}
        </div>
    );
};

export default DigitStats;
