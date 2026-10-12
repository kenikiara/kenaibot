import { useEffect, useSyncExternalStore } from 'react';
import { scannerFeed, TMarket } from '@/pages/scanner/scanner-feed';

/**
 * Live view of one market from the shared public tick feed (synthetic
 * Volatility and Jump indices only). Starts the feed if it is not running.
 */
export const useFeedMarket = (symbol: string | undefined): TMarket | undefined => {
    useEffect(() => {
        scannerFeed.start();
    }, []);
    useSyncExternalStore(scannerFeed.subscribe, scannerFeed.getVersion);
    return symbol ? scannerFeed.markets.get(symbol) : undefined;
};

/** All markets currently streaming on the shared feed, sorted for display. */
export const useFeedMarkets = (): TMarket[] => {
    useEffect(() => {
        scannerFeed.start();
    }, []);
    useSyncExternalStore(scannerFeed.subscribe, scannerFeed.getVersion);
    return scannerFeed.sortedMarkets;
};
