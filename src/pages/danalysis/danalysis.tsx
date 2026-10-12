import React, { lazy, Suspense, useState } from 'react';
import { observer } from 'mobx-react-lite';
import DigitStats from '@/components/digit-stats';
import ChunkLoader from '@/components/loader/chunk-loader';
import { useFeedMarket } from '@/hooks/useFeedMarket';
import { useStore } from '@/hooks/useStore';
import { localize } from '@deriv-com/translations';
import './danalysis.scss';

const ChartWrapper = lazy(() => import('../chart/chart-wrapper'));

const TICK_WINDOWS = [10, 30, 50, 100, 500, 1000];
const WINDOW_KEY = 'danalysis_ticks';

const readWindow = () => {
    try {
        const saved = Number(localStorage.getItem(WINDOW_KEY));
        return TICK_WINDOWS.includes(saved) ? saved : 1000;
    } catch {
        return 1000;
    }
};

/** Live chart with a last-digit distribution bar for the charted market. */
const Danalysis = observer(() => {
    const { chart_store } = useStore();
    const market = useFeedMarket(chart_store.symbol);
    const [ticks, setTicks] = useState(readWindow);

    const changeWindow = (value: number) => {
        setTicks(value);
        try {
            localStorage.setItem(WINDOW_KEY, String(value));
        } catch {
            // storage unavailable
        }
    };

    return (
        <div className='danalysis'>
            <Suspense fallback={<ChunkLoader message={localize('Please wait, loading chart...')} />}>
                <ChartWrapper show_digits_stats={false} />
            </Suspense>
            {market && market.digits.length > 0 && (
                <div className='danalysis__digits'>
                    <DigitStats digits={market.digits.slice(-ticks)} />
                    <select
                        className='danalysis__window'
                        aria-label={localize('Ticks analysed')}
                        value={ticks}
                        onChange={e => changeWindow(Number(e.target.value))}
                    >
                        {TICK_WINDOWS.map(value => (
                            <option key={value} value={value}>
                                {localize('{{count}} ticks', { count: value })}
                            </option>
                        ))}
                    </select>
                </div>
            )}
        </div>
    );
});

export default Danalysis;
