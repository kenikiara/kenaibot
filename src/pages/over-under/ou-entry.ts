import { TMarket } from '../scanner/scanner-feed';
import { readContract, TOUContract, TOUPair } from './catalog';

/**
 * When and where an Over/Under session trades. As with Even/Odd, these only
 * pace the session; every tick keeps the contract's fixed win chance.
 */

export type TOUEntryMode = 'cold' | 'lagging' | 'every';
export type TOUSides = 'pair' | 'over' | 'under';

export type TOUEntry = {
    mode: TOUEntryMode;
    sides: TOUSides;
    /** cold: losses in a row for the side */
    streak: number;
    /** lagging: ticks to look back over */
    window: number;
    /** lagging: how far (0-1) below its expected rate the side must be */
    gap: number;
};

export const DEFAULT_OU_ENTRY: TOUEntry = { mode: 'cold', sides: 'pair', streak: 1, window: 50, gap: 0.1 };

export const ENTRY_MODES: TOUEntryMode[] = ['cold', 'lagging', 'every'];

export type TOUReading = {
    readiness: number;
    contract: TOUContract | null;
    detail: string;
};

export const sidesFor = (pair: TOUPair, sides: TOUSides) =>
    sides === 'over' ? [pair.over] : sides === 'under' ? [pair.under] : [pair.over, pair.under];

const readOne = (market: TMarket, contract: TOUContract, entry: TOUEntry): TOUReading => {
    if (!market.digits.length) return { readiness: 0, contract: null, detail: '—' };
    switch (entry.mode) {
        case 'cold': {
            const { loss_streak } = readContract(market, contract, entry.streak + 1);
            return {
                readiness: Math.min(loss_streak / entry.streak, 1),
                contract: loss_streak >= entry.streak ? contract : null,
                detail: `${contract.label} lost ${loss_streak} in a row`,
            };
        }
        case 'lagging': {
            const r = readContract(market, contract, entry.window);
            if (r.sample < entry.window) return { readiness: 0, contract: null, detail: 'Collecting ticks' };
            const shortfall = contract.win_probability - r.rate;
            return {
                readiness: Math.max(0, Math.min(shortfall / entry.gap, 1)),
                contract: shortfall >= entry.gap ? contract : null,
                detail: `${contract.label} ${Math.round(r.rate * 100)}% vs ${Math.round(contract.win_probability * 100)}%`,
            };
        }
        case 'every':
        default:
            return { readiness: 1, contract, detail: 'Next tick' };
    }
};

/** Reads a market for a pair; when both sides fire, the one that is further behind wins. */
export const readOverUnder = (market: TMarket, pair: TOUPair, entry: TOUEntry): TOUReading => {
    const readings = sidesFor(pair, entry.sides).map(c => readOne(market, c, entry));
    return readings.reduce((best, r) => (r.readiness > best.readiness ? r : best));
};
