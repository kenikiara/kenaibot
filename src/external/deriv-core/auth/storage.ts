import type { AuthInfo, DerivAccount, StoredCSRFToken, StoredCodeVerifier } from '../types';

const CSRF_TOKEN_KEY = 'oauth_csrf_token';
const CODE_VERIFIER_KEY = 'oauth_code_verifier';
const AUTH_INFO_KEY = 'auth_info';
const DERIV_ACCOUNTS_KEY = 'deriv_accounts';
const ACTIVE_LOGINID_KEY = 'active_loginid';
const ACCOUNT_TYPE_KEY = 'account_type';

// Long enough for a sign-up that waits on an email verification.
const TOKEN_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

// The CSRF token and PKCE verifier are kept in localStorage (with a sessionStorage
// copy) so a login that finishes in another tab of the same browser — social
// logins and email verification links often open one — can still complete.
function storeFlowValue(key: string, value: string): void {
  const raw = JSON.stringify({ value, createdAt: Date.now() });
  sessionStorage.setItem(key, raw);
  try {
    localStorage.setItem(key, raw);
  } catch {
    // localStorage unavailable (private mode): the tab-scoped copy still works
  }
}

function readFlowValue(key: string): string | null {
  let raw = sessionStorage.getItem(key);
  try {
    raw = raw ?? localStorage.getItem(key);
  } catch {
    // localStorage unavailable
  }
  if (!raw) return null;

  const stored: StoredCSRFToken | StoredCodeVerifier = JSON.parse(raw);
  if (Date.now() - stored.createdAt > TOKEN_MAX_AGE_MS) {
    clearFlowValue(key);
    return null;
  }
  return stored.value;
}

function clearFlowValue(key: string): void {
  sessionStorage.removeItem(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // localStorage unavailable
  }
}

// --- CSRF Token ---

export function storeCSRFToken(token: string): void {
  storeFlowValue(CSRF_TOKEN_KEY, token);
}

export function getCSRFToken(): string | null {
  return readFlowValue(CSRF_TOKEN_KEY);
}

export function clearCSRFToken(): void {
  clearFlowValue(CSRF_TOKEN_KEY);
}

// --- PKCE Code Verifier ---

export function storeCodeVerifier(verifier: string): void {
  storeFlowValue(CODE_VERIFIER_KEY, verifier);
}

export function getCodeVerifier(): string | null {
  return readFlowValue(CODE_VERIFIER_KEY);
}

export function clearCodeVerifier(): void {
  clearFlowValue(CODE_VERIFIER_KEY);
}

// --- Auth Info ---

export function storeAuthInfo(authInfo: AuthInfo): void {
  localStorage.setItem(AUTH_INFO_KEY, JSON.stringify(authInfo));
}

export function getAuthInfo(): AuthInfo | null {
  const raw = localStorage.getItem(AUTH_INFO_KEY);
  if (!raw) return null;

  const authInfo: AuthInfo = JSON.parse(raw);
  if (authInfo.expires_at && Date.now() > authInfo.expires_at * 1000) {
    return null; // Token expired
  }
  return authInfo;
}

export function clearAuthInfo(): void {
  localStorage.removeItem(AUTH_INFO_KEY);
}

// --- Deriv Accounts ---

export function storeDerivAccounts(accounts: DerivAccount[]): void {
  localStorage.setItem(DERIV_ACCOUNTS_KEY, JSON.stringify(accounts));
}

export function getDerivAccounts(): DerivAccount[] | null {
  const raw = localStorage.getItem(DERIV_ACCOUNTS_KEY);
  if (!raw) return null;
  return JSON.parse(raw);
}

export function clearDerivAccounts(): void {
  localStorage.removeItem(DERIV_ACCOUNTS_KEY);
}

// --- Active Login ID (localStorage) ---

export function setActiveLoginId(loginId: string): void {
  localStorage.setItem(ACTIVE_LOGINID_KEY, loginId);
}

export function getActiveLoginId(): string | null {
  return localStorage.getItem(ACTIVE_LOGINID_KEY);
}

// --- Account Type (localStorage) ---

export function setAccountType(type: 'demo' | 'real'): void {
  localStorage.setItem(ACCOUNT_TYPE_KEY, type);
}

export function getAccountType(): string | null {
  return localStorage.getItem(ACCOUNT_TYPE_KEY);
}

// --- Clear All Auth Data ---

export function clearAllAuthData(): void {
  clearCSRFToken();
  clearCodeVerifier();
  clearAuthInfo();
  clearDerivAccounts();
  localStorage.removeItem(ACTIVE_LOGINID_KEY);
  localStorage.removeItem(ACCOUNT_TYPE_KEY);
}
