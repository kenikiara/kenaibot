import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import TradingViewComponent from '@/components/trading-view-chart/trading-view';
import { useStore } from '@/hooks/useStore';
import { hasLoadedBot, setWorkspaceMarket } from '@/utils/bot-workspace';
import { Localize, localize } from '@deriv-com/translations';
import './trading-view-tab.scss';

const SYNC_MARKETS = [
    ['R_10', 'Volatility 10 Index'],
    ['R_25', 'Volatility 25 Index'],
    ['R_50', 'Volatility 50 Index'],
    ['R_75', 'Volatility 75 Index'],
    ['R_100', 'Volatility 100 Index'],
    ['1HZ10V', 'Volatility 10 (1s) Index'],
    ['1HZ15V', 'Volatility 15 (1s) Index'],
    ['1HZ25V', 'Volatility 25 (1s) Index'],
    ['1HZ30V', 'Volatility 30 (1s) Index'],
    ['1HZ50V', 'Volatility 50 (1s) Index'],
    ['1HZ75V', 'Volatility 75 (1s) Index'],
    ['1HZ90V', 'Volatility 90 (1s) Index'],
    ['1HZ100V', 'Volatility 100 (1s) Index'],
    ['JD10', 'Jump 10 Index'],
    ['JD25', 'Jump 25 Index'],
    ['JD50', 'Jump 50 Index'],
    ['JD75', 'Jump 75 Index'],
    ['JD100', 'Jump 100 Index'],
];

/** Deriv's TradingView charts, with a bar that points the loaded bot at the market you are watching. */
const TradingViewTab = observer(() => {
    const { dashboard } = useStore();
    const current = dashboard.bot_builder_symbol as string | undefined;
    const [symbol, setSymbol] = useState(() =>
        SYNC_MARKETS.some(([value]) => value === current) ? (current as string) : 'R_100'
    );
    const [status, setStatus] = useState('');

    const sync = () => {
        if (!hasLoadedBot()) {
            setStatus(localize('Load a bot first, then sync its market.'));
            return;
        }
        setStatus(
            setWorkspaceMarket(symbol)
                ? localize('The bot now trades {{market}}.', {
                      market: SYNC_MARKETS.find(([value]) => value === symbol)?.[1] ?? symbol,
                  })
                : localize('The market could not be changed. Open the Bot Builder once, then try again.')
        );
    };

    return (
        <div className='trading-view-tab'>
            <div className='trading-view-tab__sync'>
                <span className='trading-view-tab__label'>
                    <Localize i18n_default_text='Sync with Bot:' />
                </span>
                <select
                    aria-label={localize('Market')}
                    value={symbol}
                    onChange={e => {
                        setSymbol(e.target.value);
                        setStatus('');
                    }}
                >
                    {SYNC_MARKETS.map(([value, name]) => (
                        <option key={value} value={value}>
                            {name}
                        </option>
                    ))}
                </select>
                <button type='button' onClick={sync}>
                    <Localize i18n_default_text='Apply to bot' />
                </button>
                {status && <span className='trading-view-tab__status'>{status}</span>}
            </div>
            <div className='trading-view-tab__chart'>
                <TradingViewComponent />
            </div>
        </div>
    );
});

export default TradingViewTab;
