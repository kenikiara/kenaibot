import { TMarket } from '../scanner/scanner-feed';

/**
 * Entry rules decide *where and when* the session trades. They cannot change
 * the 50% win chance of a tick; they only pace the session and pick the side.
 */

export type TEntryRuleKey = 'streak' | 'imbalance' | 'fixed';

export type TEntryConfig = {
    rule: TEntryRuleKey;
    /** streak: same-parity run length that triggers a trade */
    streak: number;
    /** imbalance: ticks to look back over */
    window: number;
    /** imbalance: share (0-1) one parity must reach */
    threshold: number;
    /** fixed: 0 = Even, 1 = Odd */
    fixed_side: 0 | 1;
};

export type TSide = 'DIGITEVEN' | 'DIGITODD';

export type TReading = {
    /** 0..1, how close this market is to triggering (1 = trade now). */
    readiness: number;
    side: TSide | null;
    detail: string;
};

const opposite = (parity: number): TSide => (parity === 0 ? 'DIGITODD' : 'DIGITEVEN');

const parityRun = (digits: number[]) => {
    const last = digits[digits.length - 1];
    if (last === undefined) return { parity: 0, run: 0 };
    const parity = last % 2;
    let run = 0;
    for (let i = digits.length - 1; i >= 0 && digits[i] % 2 === parity; i--) run++;
    return { parity, run };
};

export const readMarket = (market: TMarket, config: TEntryConfig): TReading => {
    const { digits } = market;
    if (!digits.length) return { readiness: 0, side: null, detail: '—' };

    switch (config.rule) {
        case 'streak': {
            const { parity, run } = parityRun(digits);
            const label = parity === 0 ? 'even' : 'odd';
            return {
                readiness: Math.min(run / config.streak, 1),
                side: run >= config.streak ? opposite(parity) : null,
                detail: `${run} ${label} in a row`,
            };
        }
        case 'imbalance': {
            const recent = digits.slice(-config.window);
            if (recent.length < config.window) return { readiness: 0, side: null, detail: 'Collecting ticks' };
            const even_share = recent.filter(d => d % 2 === 0).length / recent.length;
            const top = Math.max(even_share, 1 - even_share);
            const heavy = even_share >= 0.5 ? 0 : 1;
            return {
                readiness: Math.max(0, Math.min((top - 0.5) / (config.threshold - 0.5), 1)),
                side: top >= config.threshold ? opposite(heavy) : null,
                detail: `${Math.round(top * 100)}% ${heavy === 0 ? 'even' : 'odd'} of last ${config.window}`,
            };
        }
        case 'fixed':
        default:
            return {
                readiness: 1,
                side: config.fixed_side === 0 ? 'DIGITEVEN' : 'DIGITODD',
                detail: 'Next tick',
            };
    }
};
