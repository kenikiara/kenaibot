import { DigitRunner } from '../digit-session/digit-runner';
import { getPair, TPricedPair } from '../over-under/catalog';
import { DEFAULT_OU_ENTRY, ENTRY_MODES, readOverUnder, TOUEntry, TOUEntryMode } from '../over-under/ou-entry';
import { suggestParameters, TGoal, TSuggestion } from './analysis';

/**
 * Million Bot: trades the suggested Over/Under pair on whichever market fires
 * first, and after a run of losses re-scans every pair from the session's
 * current position, switching contract, stake plan and entry rule.
 */

export const millionRunner = new DigitRunner();

/** What the bot is trading right now; changes when it switches. */
const live = { pair: getPair(2), entry: DEFAULT_OU_ENTRY };
export const getMillionLive = () => live;

export type TBotSetup = {
    goal: TGoal;
    pairs: TPricedPair[];
    suggestion: TSuggestion;
    entry: TOUEntry;
    /** Re-scan and switch after this many losses in a row (0 = never). */
    switch_after: number;
    rotate_entry: boolean;
    min_probability: number;
    /** Payout guard as a share of the pair's payout, e.g. 0.98. */
    payout_factor: number;
};

const ENTRY_NAMES: Record<TOUEntryMode, string> = {
    cold: 'after losses',
    lagging: 'when lagging',
    every: 'every tick',
};

const describe = (s: TSuggestion, mode: TOUEntryMode) =>
    `${s.pair.label} · ${s.stake_plan} stake · entry ${ENTRY_NAMES[mode]}`;

export const startMillionBot = (setup: TBotSetup) => {
    live.pair = getPair(setup.suggestion.pair.b);
    live.entry = { ...setup.entry };

    millionRunner.start({
        plan: setup.suggestion.plan,
        min_probability: setup.min_probability,
        min_payout: setup.suggestion.pair.payout * setup.payout_factor,
        pick: market => {
            const { contract } = readOverUnder(market, live.pair, live.entry);
            return contract ? { contract_type: contract.contract_type, barrier: contract.barrier } : null;
        },
        afterTrade: (state, result) => {
            if (result.is_win || !setup.switch_after || state.losing_streak < setup.switch_after) return undefined;

            const [best] = suggestParameters(
                setup.goal,
                setup.pairs,
                { net: state.net, trades_done: state.trades_done, losing_streak: 0 },
                500
            );
            if (!best) return undefined;

            if (setup.rotate_entry) {
                const next = ENTRY_MODES[(ENTRY_MODES.indexOf(live.entry.mode) + 1) % ENTRY_MODES.length];
                live.entry = { ...live.entry, mode: next };
            }
            live.pair = getPair(best.pair.b);
            return {
                plan: best.plan,
                min_payout: best.pair.payout * setup.payout_factor,
                event: `${state.losing_streak} losses in a row → re-scanned. Now ${describe(best, live.entry.mode)} (chance of target ${Math.round(best.outcome.p_target * 100)}%).`,
            };
        },
    });

    if (millionRunner.state.is_running) {
        millionRunner.addEvent(`Started: ${describe(setup.suggestion, live.entry.mode)}, scanning all markets.`);
    }
};
