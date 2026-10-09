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
    CHART: 2,
    SCANNER: 3,
    EVEN_ODD_SESSION: 4,
    OVER_UNDER: 5,
    MILLION_BOT: 6,
    MANUAL_TRADER: 7,
    AUTO_TRADES: 8,
    TUTORIAL: 9,
});

export const MAX_STRATEGIES = 10;

export const TAB_IDS = [
    'id-dbot-dashboard',
    'id-bot-builder',
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
