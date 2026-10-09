import { toast } from 'react-toastify';
import { localize } from '@deriv-com/translations';
import { getSides, TScanMode } from './scanner-engine';
import { scannerFeed, TMarket } from './scanner-feed';

export type TAlertConfig = {
    enabled: boolean;
    mode: TScanMode;
    barrier: number;
    streak: number;
};

let config: TAlertConfig = { enabled: false, mode: 'even_odd', barrier: 5, streak: 6 };
let audio_context: AudioContext | null = null;

export const setAlertConfig = (next: TAlertConfig) => {
    config = next;
};

/** Ask for notification permission. Must be called from a click handler. */
export const requestAlertPermission = () => {
    try {
        audio_context ??= new AudioContext();
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    } catch {
        // Sound and notifications are optional; the toast still shows
    }
};

const beep = () => {
    if (!audio_context) return;
    try {
        const osc = audio_context.createOscillator();
        const gain = audio_context.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.15, audio_context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audio_context.currentTime + 0.25);
        osc.connect(gain).connect(audio_context.destination);
        osc.start();
        osc.stop(audio_context.currentTime + 0.25);
    } catch {
        // ignore
    }
};

const lossRun = (digits: number[], wins: (d: number) => boolean) => {
    let run = 0;
    for (let i = digits.length - 1; i >= 0 && !wins(digits[i]); i--) run++;
    return run;
};

const checkMarket = (market: TMarket) => {
    if (!config.enabled) return;
    getSides(config.mode, config.barrier).forEach(side => {
        // Fire once, at the tick the streak reaches the threshold
        if (lossRun(market.digits, side.wins) !== config.streak) return;
        const message = localize('{{market}}: {{side}} has lost {{count}} ticks in a row', {
            market: market.name,
            side: side.label,
            count: config.streak,
        });
        toast.info(message, { autoClose: 6000 });
        beep();
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
            try {
                new Notification(localize('Scanner alert'), { body: message, tag: `${market.symbol}-${side.key}` });
            } catch {
                // Some mobile browsers only allow notifications from a service worker
            }
        }
    });
};

scannerFeed.onTick(checkMarket);
