import { TStrategy } from '../engine/types';
import { bestAccumulators } from './accumulators';
import {
    onlyUpsDowns,
    over4,
    percentageEvenOdd,
    percentageOverUnder,
    rcEvenOdd,
    rcOver4Under5,
    rcRiseFall,
} from './patterns';
import { aiScanner, aMatchesDiffers, matchesSignalProvider, multipleMatches, over5Under4 } from './scanners';
import { demoEvenOdd, demoOver5, fastOverUnder, multimarket } from './virtual-gate';

/** Sidebar order, grouped as on the Auto Trades sidebar. */
export const AUTO_STRATEGIES: TStrategy[] = [
    aiScanner,
    multimarket,
    rcEvenOdd,
    rcOver4Under5,
    percentageEvenOdd,
    matchesSignalProvider,
    aMatchesDiffers,
    demoOver5,
    demoEvenOdd,
    percentageOverUnder,
    fastOverUnder,
    over4,
    multipleMatches,
    over5Under4,
    onlyUpsDowns,
    rcRiseFall,
    bestAccumulators,
];

export const DEFAULT_STRATEGY_ID = demoOver5.id;

export const findStrategy = (id: string) => AUTO_STRATEGIES.find(strategy => strategy.id === id);
