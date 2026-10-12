/**
 * Pure digit statistics for the AI Analysis tab. Everything here describes
 * the ticks already seen; none of it changes the odds of the next tick.
 */

export type TParity = 'even' | 'odd';

export type TEvenOddStats = {
    even_count: number;
    odd_count: number;
    even_pct: number;
    odd_pct: number;
    /** Current run of the same parity at the end of the window. */
    streak: { parity: TParity | null; length: number };
    longest_even: number;
    longest_odd: number;
};

export type TPatternSignal = {
    side: string | null;
    /** 0-100: how strongly the recent pattern stands out, not a win probability. */
    strength: number;
    headline: string;
    detail: string;
};

const parityOf = (digit: number): TParity => (digit % 2 === 0 ? 'even' : 'odd');

export const evenOddStats = (digits: number[]): TEvenOddStats => {
    let even_count = 0;
    let longest_even = 0;
    let longest_odd = 0;
    let run = 0;
    let previous: TParity | null = null;
    for (const digit of digits) {
        const parity = parityOf(digit);
        if (parity === 'even') even_count++;
        run = parity === previous ? run + 1 : 1;
        previous = parity;
        if (parity === 'even') longest_even = Math.max(longest_even, run);
        else longest_odd = Math.max(longest_odd, run);
    }
    const total = digits.length || 1;
    return {
        even_count,
        odd_count: digits.length - even_count,
        even_pct: (even_count / total) * 100,
        odd_pct: ((digits.length - even_count) / total) * 100,
        streak: { parity: previous, length: digits.length ? run : 0 },
        longest_even,
        longest_odd,
    };
};

const isAlternating = (digits: number[], length = 6) => {
    if (digits.length < length) return false;
    const recent = digits.slice(-length).map(parityOf);
    return recent.every((parity, i) => i === 0 || parity !== recent[i - 1]);
};

/** Even/Odd pattern read-out: streaks, a strong bias or a clean alternation. */
export const evenOddSignal = (digits: number[]): TPatternSignal => {
    if (digits.length < 20) {
        return {
            side: null,
            strength: 0,
            headline: 'Collecting more data',
            detail: 'At least 20 ticks are needed to describe the pattern.',
        };
    }
    const stats = evenOddStats(digits);
    const { parity, length } = stats.streak;

    if (parity && length >= 4) {
        return {
            side: parity,
            strength: Math.min(90, 70 + 5 * length),
            headline: `${parity.toUpperCase()} streak of ${length}`,
            detail: `The last ${length} digits were all ${parity}. Longest ${parity} run in this window: ${
                parity === 'even' ? stats.longest_even : stats.longest_odd
            }.`,
        };
    }
    if (stats.even_pct > 65 || stats.odd_pct > 65) {
        const side: TParity = stats.even_pct > stats.odd_pct ? 'even' : 'odd';
        const pct = side === 'even' ? stats.even_pct : stats.odd_pct;
        return {
            side,
            strength: Math.min(85, Math.round(pct)),
            headline: `${side.toUpperCase()} bias`,
            detail: `${pct.toFixed(1)}% of the last ${digits.length} digits were ${side}.`,
        };
    }
    if (isAlternating(digits)) {
        const last = digits[digits.length - 1];
        const side: TParity = parityOf(last) === 'even' ? 'odd' : 'even';
        return {
            side,
            strength: 80,
            headline: `Alternating pattern → ${side.toUpperCase()} next in sequence`,
            detail: `The last 6 digits alternated ${digits
                .slice(-6)
                .map(d => (d % 2 === 0 ? 'E' : 'O'))
                .join('')}.`,
        };
    }
    return {
        side: null,
        strength: 50,
        headline: 'No clear pattern',
        detail: `Even ${stats.even_pct.toFixed(1)}%, Odd ${stats.odd_pct.toFixed(1)}%.`,
    };
};

/** Share of digits strictly over / under a barrier. */
export const overUnderShares = (digits: number[], over_barrier: number, under_barrier: number) => {
    const total = digits.length || 1;
    return {
        over_pct: (digits.filter(d => d > over_barrier).length / total) * 100,
        under_pct: (digits.filter(d => d < under_barrier).length / total) * 100,
    };
};

/** Digits ordered from most to least frequent, with their shares. */
export const rankDigits = (digits: number[]) => {
    const counts = Array(10).fill(0);
    digits.forEach(d => counts[d]++);
    const total = digits.length || 1;
    return counts
        .map((count, digit) => ({ digit, pct: (count / total) * 100 }))
        .sort((a, b) => b.pct - a.pct || a.digit - b.digit);
};

export type TRiseFallStats = { rise_pct: number; fall_pct: number; moves: number; streak: number; direction: 'rise' | 'fall' | null };

/** Up/down share of price moves (unchanged ticks ignored) and the current run. */
export const riseFallStats = (quotes: number[]): TRiseFallStats => {
    let rises = 0;
    let falls = 0;
    let streak = 0;
    let direction: 'rise' | 'fall' | null = null;
    for (let i = 1; i < quotes.length; i++) {
        if (quotes[i] === quotes[i - 1]) continue;
        const move = quotes[i] > quotes[i - 1] ? 'rise' : 'fall';
        if (move === 'rise') rises++;
        else falls++;
        streak = move === direction ? streak + 1 : 1;
        direction = move;
    }
    const moves = rises + falls;
    return {
        rise_pct: moves ? (rises / moves) * 100 : 0,
        fall_pct: moves ? (falls / moves) * 100 : 0,
        moves,
        streak,
        direction,
    };
};
