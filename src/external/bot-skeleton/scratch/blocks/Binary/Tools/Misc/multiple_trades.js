import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../../utils';

window.Blockly.Blocks.multiple_trades = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Execute {{ trade_count }} identical trades', { trade_count: '%1' }),
            args0: [
                {
                    type: 'input_value',
                    name: 'TRADE_COUNT',
                    check: 'Number',
                },
            ],
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            previousStatement: null,
            nextStatement: null,
            tooltip: localize(
                'Execute multiple identical trades simultaneously. Connect a number to specify how many trades to execute at the same time.'
            ),
            category: window.Blockly.Categories.Miscellaneous,
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
    meta() {
        return {
            display_name: localize('Multiple Identical Trades'),
            description: localize(
                'Place this block before a Purchase block. The next purchase buys the same contract the given number of times (1-50) at the same moment.'
            ),
            key_words: localize('multiple, identical, simultaneous, bulk, trades'),
        };
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.multiple_trades = block => {
    const trade_count =
        window.Blockly.JavaScript.javascriptGenerator.valueToCode(
            block,
            'TRADE_COUNT',
            window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC
        ) || '5';

    return `Bot.setMultipleTradesInfo(${trade_count});\n`;
};
