export type TTradeTypeKey = 'even_odd' | 'over_under' | 'matches_differs' | 'rise_fall';

export type TContractType =
    'DIGITEVEN' | 'DIGITODD' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITMATCH' | 'DIGITDIFF' | 'CALL' | 'PUT';

export type TTradeOption = {
    contract_type: TContractType;
    label: string;
    /** Digits this contract accepts as a prediction, when it takes one. */
    valid_digits?: number[];
    tone: 'up' | 'down';
};

export type TTradeType = {
    key: TTradeTypeKey;
    label: string;
    needs_digit: boolean;
    options: [TTradeOption, TTradeOption];
    help: string;
};

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export const TRADE_TYPES: TTradeType[] = [
    {
        key: 'even_odd',
        label: 'Even/Odd',
        needs_digit: false,
        options: [
            { contract_type: 'DIGITEVEN', label: 'Even', tone: 'up' },
            { contract_type: 'DIGITODD', label: 'Odd', tone: 'down' },
        ],
        help: 'Win if the last digit of the final tick is even (0, 2, 4, 6, 8) or odd (1, 3, 5, 7, 9).',
    },
    {
        key: 'over_under',
        label: 'Over/Under',
        needs_digit: true,
        options: [
            { contract_type: 'DIGITOVER', label: 'Over', valid_digits: range(0, 8), tone: 'up' },
            { contract_type: 'DIGITUNDER', label: 'Under', valid_digits: range(1, 9), tone: 'down' },
        ],
        help: 'Win if the last digit of the final tick is strictly higher (Over) or lower (Under) than your digit.',
    },
    {
        key: 'matches_differs',
        label: 'Matches/Differs',
        needs_digit: true,
        options: [
            { contract_type: 'DIGITMATCH', label: 'Matches', valid_digits: range(0, 9), tone: 'up' },
            { contract_type: 'DIGITDIFF', label: 'Differs', valid_digits: range(0, 9), tone: 'down' },
        ],
        help: 'Win if the last digit of the final tick is exactly your digit (Matches) or anything else (Differs).',
    },
    {
        key: 'rise_fall',
        label: 'Rise/Fall',
        needs_digit: false,
        options: [
            { contract_type: 'CALL', label: 'Rise', tone: 'up' },
            { contract_type: 'PUT', label: 'Fall', tone: 'down' },
        ],
        help: 'Win if the final tick is strictly higher (Rise) or lower (Fall) than the entry tick.',
    },
];

export const getTradeType = (key: TTradeTypeKey) => TRADE_TYPES.find(t => t.key === key) ?? TRADE_TYPES[0];

export const DURATIONS = range(1, 10);

/** True win probability per tick for digit contracts if digits are uniform; undefined for rise/fall. */
export const fairWinRate = (contract_type: TContractType, digit?: number): number | undefined => {
    switch (contract_type) {
        case 'DIGITEVEN':
        case 'DIGITODD':
            return 0.5;
        case 'DIGITOVER':
            return digit === undefined ? undefined : (9 - digit) / 10;
        case 'DIGITUNDER':
            return digit === undefined ? undefined : digit / 10;
        case 'DIGITMATCH':
            return 0.1;
        case 'DIGITDIFF':
            return 0.9;
        default:
            return undefined;
    }
};
