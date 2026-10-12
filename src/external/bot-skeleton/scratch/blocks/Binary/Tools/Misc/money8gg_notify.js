import { localize } from '@deriv-com/translations';

// Same behaviour as the Notify block, kept under its own type so imported strategies that use
// "Money8gg notify" load unchanged.
window.Blockly.Blocks.money8gg_notify = {
    ...window.Blockly.Blocks.notify,
    definition() {
        return {
            ...window.Blockly.Blocks.notify.definition.call(this),
            message0: localize(
                'Money8gg notify {{ notification_type }} with sound: {{ notification_sound }} {{ input_message }}',
                {
                    notification_type: '%1',
                    notification_sound: '%2',
                    input_message: '%3',
                }
            ),
        };
    },
    meta() {
        return {
            display_name: localize('Money8gg Notify'),
            description: localize(
                'This block displays a message. You can specify the color of the message and choose from 6 different sound options.'
            ),
        };
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.money8gg_notify =
    window.Blockly.JavaScript.javascriptGenerator.forBlock.notify;
