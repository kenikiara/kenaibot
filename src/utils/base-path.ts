/**
 * Sub-path a standalone deploy is served under, e.g. '/kenaibot' on GitHub Pages.
 * Empty when served at the domain root. Set at build time via PUBLIC_BASE_PATH.
 */
export const BASE_PATH = (process.env.PUBLIC_BASE_PATH || '').replace(/\/+$/, '');

/** Prefixes a root-relative path with the deploy's base path. */
export const withBase = (path: string) => `${BASE_PATH}${path.startsWith('/') ? path : `/${path}`}`;

/**
 * Absolute URL of the app's home, used as the OAuth redirect URI. Must match a
 * Redirect URI registered for the Deriv app (e.g. https://user.github.io/kenaibot/).
 */
export const getAppUrl = () => (BASE_PATH ? `${window.location.origin}${BASE_PATH}/` : window.location.origin);
