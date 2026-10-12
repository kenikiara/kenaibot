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
    AI_ANALYSIS: 3,
    CHART: 4,
    AUTO_TRADES: 5,
    TRADING_VIEW: 6,
    SCANNER: 7,
    EVEN_ODD_SESSION: 8,
    OVER_UNDER: 9,
    MILLION_BOT: 10,
    MANUAL_TRADER: 11,
    RISK_MANAGEMENT: 12,
    TUTORIAL: 13,
});

export const MAX_STRATEGIES = 10;

export const TAB_IDS = [
    'id-dbot-dashboard',
    'id-bot-builder',
    'id-best-bots',
    'id-ai-analysis',
    'id-charts',
    'id-auto-trades',
    'id-trading-view',
    'id-scanner',
    'id-even-odd-session',
    'id-over-under',
    'id-million-bot',
    'id-manual-trader',
    'id-risk-management',
    'id-tutorials',
];

export const DEBOUNCE_INTERVAL_TIME = 500;
