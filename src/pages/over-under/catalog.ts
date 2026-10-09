import { computeWindowStats, TSide } from '../scanner/scanner-engine';
import { scannerFeed, TMarket } from '../scanner/scanner-feed';

/**
 * Every Over/Under contract and its natural pair. Over b and Under (9 - b)
 * have the same win chance and the same payout, e.g. Over 2 / Under 7 both win
 * 70% of ticks. Payouts are the same on every synthetic market, but the house
 * edge differs a lot by barrier, which is what makes some pairs better value.
 */

export type TOUContract = {
    key: string;
    contract_type: 'DIGITOVER' | 'DIGITUNDER';
    barrier: number;
    label: string;
    win_probability: number;
    wins: (digit: number) => boolean;
};

export type TOUPair = {
    key: string;
    /** The Over barrier; the Under side is 9 - b. */
    b: number;
    over: TOUContract;
    under: TOUContract;
    label: string;
    win_probability: number;
};

const over = (b: number): TOUContract => ({
    key: `over_${b}`,
    contract_type: 'DIGITOVER',
    barrier: b,
    label: `Over ${b}`,
    win_probability: (9 - b) / 10,
    wins: d => d > b,
});

const under = (b: number): TOUContract => ({
    key: `under_${b}`,
    contract_type: 'DIGITUNDER',
    barrier: b,
    label: `Under ${b}`,
    win_probability: b / 10,
    wins: d => d < b,
});

export const OU_PAIRS: TOUPair[] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(b => ({
    key: `pair_${b}`,
    b,
    over: over(b),
    under: under(9 - b),
    label: `Over ${b} / Under ${9 - b}`,
    win_probability: (9 - b) / 10,
}));

export const getPair = (b: number) => OU_PAIRS.find(p => p.b === b) ?? OU_PAIRS[2];

/** Live payouts measured on 2026-10-09, used until the live quote arrives. */
const FALLBACK_PAYOUT: Record<number, number> = {
    0: 1.096,
    1: 1.232,
    2: 1.404,
    3: 1.634,
    4: 1.953,
    5: 2.427,
    6: 3.205,
    7: 4.717,
    8: 8.929,
};

export type TPricedPair = TOUPair & {
    payout: number;
    /** Expected return per 1 staked (negative = house edge). */
    ev: number;
    break_even: number;
    /** Wins needed to make back one lost stake. */
    wins_per_loss: number;
};

export const pricePair = (pair: TOUPair, payout = FALLBACK_PAYOUT[pair.b]): TPricedPair => ({
    ...pair,
    payout,
    ev: pair.win_probability * payout - 1,
    break_even: 1 / payout,
    wins_per_loss: 1 / (payout - 1),
});

/** Fetches live payouts for every pair (one proposal per pair; both sides pay the same). */
export const fetchPairPayouts = async (symbol: string): Promise<Record<number, number>> => {
    const entries = await Promise.all(
        OU_PAIRS.map(pair =>
            scannerFeed
                .getPayout(symbol, { contract_type: 'DIGITOVER', barrier: pair.b })
                .then(value => [pair.b, value] as const)
                .catch(() => [pair.b, FALLBACK_PAYOUT[pair.b]] as const)
        )
    );
    return Object.fromEntries(entries);
};

export const priceAll = (payouts: Record<number, number>) =>
    OU_PAIRS.map(pair => pricePair(pair, payouts[pair.b] ?? FALLBACK_PAYOUT[pair.b]));

const asSide = (c: TOUContract): TSide => ({
    key: c.key,
    label: c.label,
    contract_type: c.contract_type,
    barrier: c.barrier,
    expected: c.win_probability,
    wins: c.wins,
});

export type TContractReading = { rate: number; z: number; loss_streak: number; sample: number };

export const readContract = (market: TMarket, contract: TOUContract, window: number): TContractReading => {
    const stats = computeWindowStats(market.digits, window, [asSide(contract)]);
    const side = stats.sides[0];
    return { rate: side.rate, z: side.z, loss_streak: side.loss_streak, sample: stats.sample_size };
};

/** Hit rate of a contract pooled across all markets over the last `window` ticks of each. */
export const pooledHitRate = (markets: TMarket[], contract: TOUContract, window: number) => {
    let hits = 0;
    let n = 0;
    markets.forEach(m => {
        const digits = m.digits.slice(-window);
        hits += digits.filter(contract.wins).length;
        n += digits.length;
    });
    return n ? hits / n : 0;
};
