import { DBOT_TABS } from '@/constants/bot-contents';
import { scannerFeed } from '@/pages/scanner/scanner-feed';
import { loadStrategyXml } from '@/utils/bot-workspace';
import { getRootStore } from '@/utils/store-bridge';
import { TStrategy } from '../engine/types';
import { DIGIT_OPTIONS, marketName, pct, rangeOptions, TSide, VOLATILITY_10 } from './helpers';
import { osman, osmanChecklist, scanOsman, sideName, TOsmanCandidate } from './osman';
import { buildOsmanBotXml } from './osman-bot-xml';

/**
 * Osman Bot: runs the Osman scan, and for the best ready setup loads an
 * Osman Deriv Bot into the Bot Builder and presses Run. The bot waits for an
 * entry digit, trades 1-tick contracts until the target wins (recovering a
 * loss first), then stops; this controller adds up the cycle's profit and
 * scans again until the session's take profit or stop loss.
 */

const BOT_NAME = 'Osman Bot';
/** Time allowed between pressing Run and the bot reporting that it runs. */
const START_TIMEOUT_MS = 20000;
/** Pause after a cycle before the next scan may pick a setup. */
const COOLDOWN_MS = 3000;
/** Used when the live payout for the recovery contract cannot be fetched. */
const FALLBACK_RECOVERY_RATIO = 0.9;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const money2 = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

type TPhase = 'scanning' | 'loading' | 'running';

export const osmanBot: TStrategy = {
    id: 'osman-bot',
    label: 'Osman Bot',
    group: 'Digits',
    uses_market: true,
    summary:
        'Scans with the Osman rules and, for the setup with the highest recent win share, loads an Osman Deriv Bot into the Bot Builder and runs it. The bot waits for the entry digit (Over: 5 or 6 · Under: 4, 7 or 9), trades 1-tick contracts until 3 wins, and after a loss switches to the recovery contract with a stake sized to win the loss back, then stops. The next scan starts afresh until take profit or stop loss. Martingale is not used: the recovery stake is worked out from the live payout.',
    fields: [
        ...osman.fields.filter(field => ['scope', 'side', 'over_barrier', 'under_barrier', 'window'].includes(field.key)),
        { key: 'target_wins', label: 'Wins per setup', type: 'select', options: rangeOptions(1, 10) },
        {
            key: 'recovery_over',
            label: 'Recovery after an Over loss',
            type: 'select',
            options: DIGIT_OPTIONS.slice(0, 9).map(option => ({ ...option, label: `Over ${option.label}` })),
            visible: s => s.side !== 'under',
            help: 'Over 4 wins on 5-9 and pays about 95%, so one win can cover the loss.',
        },
        {
            key: 'recovery_under',
            label: 'Recovery after an Under loss',
            type: 'select',
            options: DIGIT_OPTIONS.slice(1).map(option => ({ ...option, label: `Under ${option.label}` })),
            visible: s => s.side !== 'over',
            help: 'Under 5 wins on 0-4 and pays about 95%, so one win can cover the loss.',
        },
        {
            key: 'max_recovery',
            label: 'Recovery trades allowed',
            type: 'select',
            options: rangeOptions(1, 6),
            help: 'If the recovery keeps losing past this, the bot stops and the next scan starts.',
        },
    ],
    defaults: {
        scope: 'all',
        side: 'both',
        over_barrier: 1,
        under_barrier: 8,
        window: 1000,
        target_wins: 3,
        recovery_over: 4,
        recovery_under: 5,
        max_recovery: 3,
    },
    create: (s, money) => {
        const symbols = s.scope === 'single' ? [money.symbol] : VOLATILITY_10;
        const barrierFor = (side: TSide) => Number(side === 'over' ? s.over_barrier : s.under_barrier);
        const recoveryFor = (side: TSide) => Number(side === 'over' ? s.recovery_over : s.recovery_under);
        const scan_options = {
            symbols,
            side: String(s.side),
            window: Number(s.window),
            over_barrier: barrierFor('over'),
            under_barrier: barrierFor('under'),
        };

        let phase: TPhase = 'scanning';
        let current: TOsmanCandidate | null = null;
        let cycle = { start_profit: 0, started_at: 0, seen_running: false };
        let cooldown_until = 0;
        let net = 0;
        let cycles = 0;
        let stop_reason: string | false = false;
        let collecting = symbols.length;
        let notes: string[] = [];

        const headline = () =>
            phase === 'scanning' || !current
                ? `Scanning ${symbols.length} market${symbols.length === 1 ? '' : 's'}${
                      collecting ? ` (${collecting} still loading ticks)` : ''
                  }`
                : `${phase === 'loading' ? 'Loading' : 'Running'} ${BOT_NAME}: ${sideName(current.setup.side)} ${current.barrier} on ${marketName(
                      current.symbol
                  )} — waits for digit ${current.setup.entry.join('/')}`;

        const limitsReason = () => {
            if (net >= money.take_profit) return `Take profit reached: ${money2(net)} over ${cycles} setup${cycles === 1 ? '' : 's'}.`;
            if (money.stop_loss_mode === 'amount' && -net >= money.stop_loss) return `Stop loss reached: ${money2(net)}.`;
            return false;
        };

        const startCycle = async (candidate: TOsmanCandidate, log: (text: string) => void) => {
            const store = getRootStore();
            if (!store) {
                stop_reason = 'The app is still loading — try again in a moment.';
                return;
            }
            if (store.run_panel.is_running) {
                stop_reason = 'A bot is already running in the Bot Builder. Stop it, then start Osman Bot again.';
                return;
            }
            phase = 'loading';
            current = candidate;
            const side = candidate.setup.side;
            const recovery_prediction = recoveryFor(side);
            let recovery_ratio = FALLBACK_RECOVERY_RATIO;
            try {
                const payout = await scannerFeed.getPayout(candidate.symbol, {
                    contract_type: side === 'over' ? 'DIGITOVER' : 'DIGITUNDER',
                    barrier: recovery_prediction,
                });
                if (payout > 1) recovery_ratio = payout - 1;
            } catch {
                // keep the fallback
            }
            const xml = buildOsmanBotXml({
                symbol: candidate.symbol,
                is_over: side === 'over',
                prediction: candidate.barrier,
                recovery_prediction,
                recovery_ratio,
                entry_digits: candidate.setup.entry,
                stake: money.stake,
                target_wins: Number(s.target_wins),
                max_recovery: Number(s.max_recovery),
                take_profit: Math.max(0.01, money.take_profit - net),
                stop_loss: money.stop_loss_mode === 'amount' ? Math.max(0.01, money.stop_loss + net) : 1e9,
            });
            try {
                store.dashboard.setActiveTab(DBOT_TABS.BOT_BUILDER);
                await sleep(100);
                await loadStrategyXml(xml, BOT_NAME);
                await sleep(400);
            } catch (error) {
                stop_reason = `Could not load ${BOT_NAME}: ${(error as Error).message}`;
                return;
            }
            log(
                `Setup ${cycles + 1}: ${osmanChecklist(candidate)} · win share ${pct(candidate.win_share)}. Loaded ${BOT_NAME} — ${sideName(side)} ${candidate.barrier}, recovery ${sideName(side)} ${recovery_prediction} (pays ${Math.round(recovery_ratio * 100)}%).`
            );
            cycle = { start_profit: store.transactions.statistics.total_profit, started_at: Date.now(), seen_running: false };
            phase = 'running';
            await store.run_panel.onRunButtonClick();
        };

        const watchCycle = (log: (text: string) => void) => {
            const store = getRootStore();
            if (!store || !current) return;
            if (store.run_panel.is_running) {
                cycle.seen_running = true;
                return;
            }
            if (!cycle.seen_running) {
                if (Date.now() - cycle.started_at > START_TIMEOUT_MS) {
                    stop_reason = `${BOT_NAME} did not start. Check the Bot Builder for a message, then start again.`;
                }
                return;
            }
            // The bot finished its cycle (target wins, recovery, limits) or was stopped from the Bot Builder.
            const profit = Math.round((store.transactions.statistics.total_profit - cycle.start_profit) * 100) / 100;
            net = Math.round((net + profit) * 100) / 100;
            cycles += 1;
            log(`Setup ${cycles} on ${marketName(current.symbol)} finished: ${money2(profit)} · session ${money2(net)}.`);
            phase = 'scanning';
            current = null;
            cooldown_until = Date.now() + COOLDOWN_MS;
            stop_reason = limitsReason();
            if (!stop_reason) log('Scanning for the next setup…');
        };

        return {
            symbols,
            onTick: ctx => {
                const scan = scanOsman(ctx.markets, scan_options);
                const { ready, closest } = scan;
                collecting = scan.collecting;
                const best = ready[0];

                if (phase === 'running') watchCycle(ctx.log);
                else if (phase === 'scanning' && best && ctx.can_trade && Date.now() >= cooldown_until && !stop_reason) {
                    startCycle(best, ctx.log).catch(error => {
                        stop_reason = `${BOT_NAME} error: ${(error as Error).message}`;
                    });
                }

                notes = [
                    `Setups finished: ${cycles} · session ${money2(net)} of +${money.take_profit.toFixed(2)} take profit`,
                ];
                if (best) notes.push(`Best now: ${osmanChecklist(best)} · win share ${pct(best.win_share)}`);
                else if (closest) notes.push(`No setup meets every condition. Closest: ${osmanChecklist(closest)}`);
                return null;
            },
            stopReason: () => stop_reason,
            onStop: () => {
                const store = getRootStore();
                if (phase !== 'scanning' && store?.run_panel.is_running) store.run_panel.onStopButtonClick();
            },
            status: () => [headline(), ...notes],
        };
    },
};
