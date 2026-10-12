type TTabsTitle = {
    [key: string]: string | number;
};

type TDashboardTabIndex = {
    [key: string]: number;
};

export const tabs_title: TTabsTitle = Object.freeze({
    WORKSPACE: 'Workspace',
    CHART: 'Chart',
});

export const DBOT_TABS: TDashboardTabIndex = Object.freeze({
    DASHBOARD: 0,
    BOT_BUILDER: 1,
    BEST_BOTS: 2,
    CHART: 3,
    SCANNER: 4,
    EVEN_ODD_SESSION: 5,
    OVER_UNDER: 6,
    MILLION_BOT: 7,
    MANUAL_TRADER: 8,
    AUTO_TRADES: 9,
    TUTORIAL: 10,
});

export const MAX_STRATEGIES = 10;

export const TAB_IDS = [
    'id-dbot-dashboard',
    'id-bot-builder',
    'id-best-bots',
    'id-charts',
    'id-scanner',
    'id-even-odd-session',
    'id-over-under',
    'id-million-bot',
    'id-manual-trader',
    'id-auto-trades',
    'id-tutorials',
];

export const DEBOUNCE_INTERVAL_TIME = 500;
