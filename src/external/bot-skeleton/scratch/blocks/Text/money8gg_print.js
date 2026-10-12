import { localize } from '@deriv-com/translations';

// Same behaviour as the Print block, kept under its own type so imported strategies that use
// "Money8gg print" load unchanged.
window.Blockly.Blocks.money8gg_print = {
    ...window.Blockly.Blocks.text_print,
    definition() {
        return {
            ...window.Blockly.Blocks.text_print.definition.call(this),
            message0: localize('Money8gg print {{ input_text }}', { input_text: '%1' }),
        };
    },
    meta() {
        return {
            display_name: localize('Money8gg Print'),
            description: localize(
                'This block displays a dialog box with a customised message. When the dialog box is displayed, your strategy is paused and will only resume after you click "OK".'
            ),
        };
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.money8gg_print =
    window.Blockly.JavaScript.javascriptGenerator.forBlock.text_print;
