import type RootStore from '@/stores/root-store';

/**
 * The app's root store for code outside React (Auto Trades strategies run as
 * a module singleton). Set once by the StoreProvider when the store is made.
 */
let root_store: RootStore | null = null;

export const setRootStore = (store: RootStore) => {
    root_store = store;
};

export const getRootStore = () => root_store;
