/**
 * Builds the Osman Deriv Bot (Blockly XML) for one setup found by the Osman
 * scan. One cycle of the bot:
 *
 * - waits for an entry digit, then buys a 1-tick Over/Under contract;
 * - after a loss it switches to the recovery contract with a stake sized to
 *   win back what the cycle has lost (from the live payout), still waiting
 *   for an entry digit before each trade;
 * - stops after the target number of wins, after a recovery win, when the
 *   recovery limit is passed, or when the take profit / stop loss left for
 *   the session is reached. The Osman Bot controller then scans again.
 */

export type TOsmanBotParams = {
    symbol: string;
    is_over: boolean;
    prediction: number;
    recovery_prediction: number;
    /** Profit per 1 staked on a winning recovery contract (e.g. 0.95). */
    recovery_ratio: number;
    entry_digits: number[];
    stake: number;
    target_wins: number;
    max_recovery: number;
    /** Profit and loss (positive amounts) left before the session's limits. */
    take_profit: number;
    stop_loss: number;
};

const VARIABLES = [
    'Stake',
    'InitialStake',
    'Prediction',
    'MainPrediction',
    'RecoveryPrediction',
    'RecoveryRatio',
    'IsOver',
    'EntryA',
    'EntryB',
    'EntryC',
    'Wins',
    'TargetWins',
    'InRecovery',
    'Recovered',
    'RecoveryLosses',
    'MaxRecovery',
    'CycleProfit',
    'TakeProfit',
    'StopLoss',
] as const;

type TVar = (typeof VARIABLES)[number];

/** A statement block that takes the XML of the block after it. */
type TStatement = (next: string) => string;

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const buildOsmanBotXml = (p: TOsmanBotParams) => {
    let counter = 0;
    const id = () => `osman_${++counter}`;
    const vid = (name: TVar) => `osman_var_${name}`;
    const nextOf = (next: string) => (next ? `<next>${next}</next>` : '');
    const chain = (statements: TStatement[]) => statements.reduceRight((next, statement) => statement(next), '');

    const num = (n: number) => `<block type="math_number" id="${id()}"><field name="NUM">${n}</field></block>`;
    const bool = (b: boolean) => `<block type="logic_boolean" id="${id()}"><field name="BOOL">${b ? 'TRUE' : 'FALSE'}</field></block>`;
    const get = (name: TVar) =>
        `<block type="variables_get" id="${id()}"><field name="VAR" id="${vid(name)}">${name}</field></block>`;
    const binary = (type: string, op: string, a: string, b: string) =>
        `<block type="${type}" id="${id()}"><field name="OP">${op}</field><value name="A">${a}</value><value name="B">${b}</value></block>`;
    const compare = (op: 'EQ' | 'GT' | 'GTE' | 'LTE', a: string, b: string) => binary('logic_compare', op, a, b);
    const or = (a: string, b: string) => binary('logic_operation', 'OR', a, b);
    const arith = (op: 'ADD' | 'MINUS' | 'MULTIPLY' | 'DIVIDE', a: string, b: string) => binary('math_arithmetic', op, a, b);
    const roundUp = (value: string) =>
        `<block type="math_round" id="${id()}"><field name="OP">ROUNDUP</field><value name="NUM">${value}</value></block>`;
    const lastDigit = () => `<block type="last_digit" id="${id()}"></block>`;
    const profit = () => `<block type="read_details" id="${id()}"><field name="DETAIL_INDEX">4</field></block>`;
    const won = () => `<block type="contract_check_result" id="${id()}"><field name="CHECK_RESULT">win</field></block>`;

    const set =
        (name: TVar, value: string): TStatement =>
        next =>
            `<block type="variables_set" id="${id()}"><field name="VAR" id="${vid(name)}">${name}</field><value name="VALUE">${value}</value>${nextOf(next)}</block>`;
    const increment =
        (name: TVar): TStatement =>
        next =>
            `<block type="math_change" id="${id()}"><field name="VAR" id="${vid(name)}">${name}</field><value name="DELTA"><shadow type="math_number" id="${id()}"><field name="NUM">1</field></shadow></value>${nextOf(next)}</block>`;
    const notify =
        (type: 'success' | 'info' | 'warn' | 'error', text: string): TStatement =>
        next =>
            `<block type="notify" id="${id()}"><field name="NOTIFICATION_TYPE">${type}</field><field name="NOTIFICATION_SOUND">silent</field><value name="MESSAGE"><shadow type="text" id="${id()}"><field name="TEXT">${escape(text)}</field></shadow></value>${nextOf(next)}</block>`;
    const purchase = (contract: 'DIGITOVER' | 'DIGITUNDER'): TStatement => () =>
        `<block type="purchase" id="${id()}"><field name="PURCHASE_LIST">${contract}</field></block>`;
    const tradeAgain: TStatement = () => `<block type="trade_again" id="${id()}"></block>`;
    /** if / else-if … / else. `branches` pairs a condition with its statements. */
    const ifChain =
        (branches: [string, TStatement[]][], otherwise?: TStatement[]): TStatement =>
        next => {
            const mutation = `<mutation xmlns="http://www.w3.org/1999/xhtml"${branches.length > 1 ? ` elseif="${branches.length - 1}"` : ''}${
                otherwise ? ' else="1"' : ''
            }></mutation>`;
            const parts = branches
                .map(([condition, body], i) => `<value name="IF${i}">${condition}</value><statement name="DO${i}">${chain(body)}</statement>`)
                .join('');
            const other = otherwise ? `<statement name="ELSE">${chain(otherwise)}</statement>` : '';
            return `<block type="controls_if" id="${id()}">${mutation}${parts}${other}${nextOf(next)}</block>`;
        };

    const entries = [...p.entry_digits, ...p.entry_digits, ...p.entry_digits].slice(0, 3);

    const initialization = chain([
        set('Stake', num(p.stake)),
        set('InitialStake', num(p.stake)),
        set('MainPrediction', num(p.prediction)),
        set('RecoveryPrediction', num(p.recovery_prediction)),
        set('Prediction', num(p.prediction)),
        set('RecoveryRatio', num(Math.round(p.recovery_ratio * 10000) / 10000)),
        set('IsOver', bool(p.is_over)),
        set('EntryA', num(entries[0])),
        set('EntryB', num(entries[1])),
        set('EntryC', num(entries[2])),
        set('Wins', num(0)),
        set('TargetWins', num(p.target_wins)),
        set('InRecovery', bool(false)),
        set('Recovered', bool(false)),
        set('RecoveryLosses', num(0)),
        set('MaxRecovery', num(p.max_recovery)),
        set('CycleProfit', num(0)),
        set('TakeProfit', num(Math.round(p.take_profit * 100) / 100)),
        set('StopLoss', num(-Math.round(p.stop_loss * 100) / 100)),
    ]);

    // Runs before every trade: pick the main or recovery prediction.
    const choosePrediction = ifChain(
        [[get('InRecovery'), [set('Prediction', get('RecoveryPrediction'))]]],
        [set('Prediction', get('MainPrediction'))]
    );

    const tradeOptions = `<block type="trade_definition_tradeoptions" id="${id()}"><mutation xmlns="http://www.w3.org/1999/xhtml" has_first_barrier="false" has_second_barrier="false" has_prediction="true"></mutation><field name="DURATIONTYPE_LIST">t</field><value name="DURATION"><shadow type="math_number_positive" id="${id()}"><field name="NUM">1</field></shadow></value><value name="AMOUNT"><shadow type="math_number_positive" id="${id()}"><field name="NUM">0.35</field></shadow>${get(
        'Stake'
    )}</value><value name="PREDICTION"><shadow type="math_number_positive" id="${id()}"><field name="NUM">1</field></shadow>${get(
        'Prediction'
    )}</value></block>`;

    const isEntry = or(
        compare('EQ', lastDigit(), get('EntryA')),
        or(compare('EQ', lastDigit(), get('EntryB')), compare('EQ', lastDigit(), get('EntryC')))
    );
    const beforePurchase = chain([
        ifChain([[isEntry, [ifChain([[get('IsOver'), [purchase('DIGITOVER')]]], [purchase('DIGITUNDER')])]]]),
    ]);

    // Recovery stake: enough to win back what the cycle has lost, never below the initial stake.
    const recoveryStake = roundUp(arith('DIVIDE', arith('MULTIPLY', arith('MINUS', num(0), get('CycleProfit')), num(100)), get('RecoveryRatio')));
    const afterPurchase = chain([
        set('CycleProfit', arith('ADD', get('CycleProfit'), profit())),
        ifChain(
            [
                [
                    won(),
                    [
                        increment('Wins'),
                        ifChain([[get('InRecovery'), [set('Recovered', bool(true))]]]),
                        set('InRecovery', bool(false)),
                        set('Stake', get('InitialStake')),
                    ],
                ],
            ],
            [
                set('InRecovery', bool(true)),
                increment('RecoveryLosses'),
                set('Stake', arith('DIVIDE', recoveryStake, num(100))),
                ifChain([[compare('GT', get('InitialStake'), get('Stake')), [set('Stake', get('InitialStake'))]]]),
            ]
        ),
        ifChain(
            [
                [compare('GTE', get('CycleProfit'), get('TakeProfit')), [notify('success', 'Osman: take profit reached')]],
                [compare('LTE', get('CycleProfit'), get('StopLoss')), [notify('error', 'Osman: stop loss reached')]],
                [get('Recovered'), [notify('success', 'Osman: loss recovered — scanning for the next setup')]],
                [compare('GTE', get('Wins'), get('TargetWins')), [notify('success', 'Osman: target wins reached — scanning for the next setup')]],
                [compare('GT', get('RecoveryLosses'), get('MaxRecovery')), [notify('warn', 'Osman: recovery limit reached')]],
            ],
            [tradeAgain]
        ),
    ]);

    const definition = `<block type="trade_definition" id="${id()}" deletable="false" x="0" y="60"><statement name="TRADE_OPTIONS"><block type="trade_definition_market" id="${id()}" deletable="false" movable="false"><field name="MARKET_LIST">synthetic_index</field><field name="SUBMARKET_LIST">random_index</field><field name="SYMBOL_LIST">${escape(
        p.symbol
    )}</field><next><block type="trade_definition_tradetype" id="${id()}" deletable="false" movable="false"><field name="TRADETYPECAT_LIST">digits</field><field name="TRADETYPE_LIST">overunder</field><next><block type="trade_definition_contracttype" id="${id()}" deletable="false" movable="false"><field name="TYPE_LIST">both</field><next><block type="trade_definition_candleinterval" id="${id()}" deletable="false" movable="false"><field name="CANDLEINTERVAL_LIST">60</field><next><block type="trade_definition_restartbuysell" id="${id()}" deletable="false" movable="false"><field name="TIME_MACHINE_ENABLED">FALSE</field><next><block type="trade_definition_restartonerror" id="${id()}" deletable="false" movable="false"><field name="RESTARTONERROR">TRUE</field></block></next></block></next></block></next></block></next></block></next></block></statement><statement name="INITIALIZATION">${initialization}</statement><statement name="SUBMARKET">${choosePrediction(
        tradeOptions
    )}</statement></block>`;

    const variables = VARIABLES.map(name => `<variable id="${vid(name)}">${name}</variable>`).join('');

    return `<xml xmlns="https://developers.google.com/blockly/xml" is_dbot="true" collection="false"><variables>${variables}</variables>${definition}<block type="after_purchase" id="${id()}" x="893" y="60"><statement name="AFTERPURCHASE_STACK">${afterPurchase}</statement></block><block type="before_purchase" id="${id()}" deletable="false" x="0" y="1100"><statement name="BEFOREPURCHASE_STACK">${beforePurchase}</statement></block></xml>`;
};
