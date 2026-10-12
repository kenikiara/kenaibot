import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../../utils';

// A fixed list keeps the market saved in a strategy file: a dropdown that is filled in later
// would reject the saved value while the XML loads and fall back to "disable".
const ONE_SECOND_MARKETS = [
    ['disable', 'disable'],
    ['Volatility 10 (1s) Index', '1HZ10V'],
    ['Volatility 15 (1s) Index', '1HZ15V'],
    ['Volatility 25 (1s) Index', '1HZ25V'],
    ['Volatility 30 (1s) Index', '1HZ30V'],
    ['Volatility 50 (1s) Index', '1HZ50V'],
    ['Volatility 75 (1s) Index', '1HZ75V'],
    ['Volatility 90 (1s) Index', '1HZ90V'],
    ['Volatility 100 (1s) Index', '1HZ100V'],
];

window.Blockly.Blocks.one_s_markets = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('1s Markets: {{ market_selection }}', { market_selection: '%1' }),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'MARKET_LIST',
                    options: ONE_SECOND_MARKETS,
                },
            ],
            colour: window.Blockly.Colours.Special3.colour,
            colourSecondary: window.Blockly.Colours.Special3.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special3.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize('Switch the bot to one of the 1-second continuous indices'),
            category: window.Blockly.Categories.Miscellaneous,
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
    meta() {
        return {
            display_name: localize('1s Markets'),
            description: localize(
                'Switches the market the bot trades to the selected 1-second continuous index. "disable" leaves the market unchanged.'
            ),
        };
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.one_s_markets = block => {
    const symbol = block.getFieldValue('MARKET_LIST');
    return symbol === 'disable' ? '' : `Bot.selectMarket('${symbol}');\n`;
};
