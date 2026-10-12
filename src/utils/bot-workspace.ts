import { ApiHelpers, load, save_types } from '@/external/bot-skeleton';

/**
 * Small helpers for the bot in the Bot Builder workspace: loading a ready-made
 * strategy, pointing its XML at another market, and changing the numbers,
 * booleans and purchase side that it exposes as variables.
 */

/** Public URL of a file under public/xml, respecting the deploy base path. */
export const publicXmlUrl = (path: string) =>
    `${window.__webpack_public_path__ ?? '/'}xml/${path.split('/').map(encodeURIComponent).join('/')}`;

/** Loads a strategy XML into the Bot Builder workspace. Throws if the bot cannot be loaded. */
export const loadStrategyXml = async (xml: string, file_name: string) => {
    const result = await load({
        block_string: xml,
        file_name,
        workspace: window.Blockly?.derivWorkspace,
        from: save_types.UNSAVED,
        drop_event: {},
        strategy_id: null,
        showIncompatibleStrategyDialog: false,
    });
    if (result?.error) throw new Error(result.error);
};

const SYMBOL_SUBMARKET = (symbol: string) => {
    if (/^JD/i.test(symbol)) return 'jump_index';
    if (/^stpRNG/i.test(symbol)) return 'step_index';
    return 'random_index';
};

/** Rewrites every market field in a strategy XML so the bot trades `symbol`. */
export const setXmlMarket = (xml: string, symbol: string) =>
    xml
        .replace(/(<field name="MARKET_LIST">)[^<]*(<\/field>)/g, '$1synthetic_index$2')
        .replace(/(<field name="SUBMARKET_LIST">)[^<]*(<\/field>)/g, `$1${SYMBOL_SUBMARKET(symbol)}$2`)
        .replace(/(<field name="SYMBOL_LIST">)[^<]*(<\/field>)/g, `$1${symbol}$2`);

// The app's Blockly typings only cover a few workspace methods; these helpers use the full API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getWorkspace = (): any => window.Blockly?.derivWorkspace;

/** True when the Bot Builder has a strategy with a trade-parameters block. */
export const hasLoadedBot = () =>
    Boolean(getWorkspace()?.getAllBlocks(false).some((block: any) => block.type === 'trade_definition_market'));

/**
 * Switches the market of the bot in the Bot Builder to `symbol` (a synthetic
 * Volatility, Jump or Step index). Returns false when no bot is loaded.
 */
export const setWorkspaceMarket = (symbol: string) => {
    const block = getWorkspace()
        ?.getAllBlocks(false)
        .find((b: any) => b.type === 'trade_definition_market');
    const active_symbols = (ApiHelpers as any)?.instance?.active_symbols;
    if (!block || !active_symbols) return false;

    const submarket = SYMBOL_SUBMARKET(symbol);
    const event_group = `market-sync-${Date.now()}`;
    const update = (field: string, options: unknown, value: string) =>
        block.getField(field)?.updateOptions(options, { default_value: value, should_trigger_event: true, event_group });

    update('MARKET_LIST', active_symbols.getMarketDropdownOptions(), 'synthetic_index');
    update('SUBMARKET_LIST', active_symbols.getSubmarketDropdownOptions('synthetic_index'), submarket);
    update('SYMBOL_LIST', active_symbols.getSymbolDropdownOptions(submarket), symbol);
    return block.getFieldValue('SYMBOL_LIST') === symbol;
};

const variableSetBlocks = (name: string) => {
    const workspace = getWorkspace();
    if (!workspace) return [];
    const wanted = name.trim().toLowerCase();
    return workspace.getAllBlocks(false).filter((block: any) => {
        if (block.type !== 'variables_set') return false;
        const variable = workspace.getVariableById(block.getFieldValue('VAR'));
        return variable?.name?.trim().toLowerCase() === wanted;
    });
};

const setValueField = (name: string, block_type: string, field: string, value: string) => {
    let changed = false;
    variableSetBlocks(name).forEach((block: any) => {
        const target = block.getInput('VALUE')?.connection?.targetBlock();
        if (target?.type === block_type) {
            target.setFieldValue(value, field);
            changed = true;
        }
    });
    return changed;
};

/** Sets every "set <name> to <number>" block in the loaded bot. Returns false if none exist. */
export const setBotNumber = (name: string, value: number) =>
    Number.isFinite(value) && setValueField(name, 'math_number', 'NUM', String(value));

/** Sets every "set <name> to true/false" block in the loaded bot. */
export const setBotBoolean = (name: string, value: boolean) =>
    setValueField(name, 'logic_boolean', 'BOOL', value ? 'TRUE' : 'FALSE');

/** Points every Purchase block at `contract_type` (e.g. DIGITEVEN, PUT). */
export const setBotPurchaseSide = (contract_type: string) => {
    const workspace = getWorkspace();
    if (!workspace) return false;
    const purchases = workspace.getAllBlocks(false).filter((block: any) => block.type === 'purchase');
    purchases.forEach((block: any) => block.setFieldValue(contract_type, 'PURCHASE_LIST'));
    return purchases.length > 0;
};
