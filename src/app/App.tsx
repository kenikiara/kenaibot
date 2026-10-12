import { BASE_PATH, getAppUrl } from '@/utils/base-path';
import { lazy, Suspense } from 'react';
import React from 'react';
import { createBrowserRouter, createRoutesFromElements, Route, RouterProvider } from 'react-router';
import { cleanupUrl, handleOAuthCallback } from '@/external/deriv-core';
import ChunkLoader from '@/components/loader/chunk-loader';
import LocalStorageSyncWrapper from '@/components/localStorage-sync-wrapper';
import RoutePromptDialog from '@/components/route-prompt-dialog';
import { useAccountSwitching } from '@/hooks/useAccountSwitching';
import { useLanguageFromURL } from '@/hooks/useLanguageFromURL';
import { StoreProvider } from '@/hooks/useStore';
import { isPreviewMode, PREVIEW_BASE_PATH } from '@/utils/is-preview-mode';
import { localize, TranslationProvider } from '@deriv-com/translations';
import CoreStoreProvider from './CoreStoreProvider';
import i18nInstance from './i18n';
import './app-root.scss';

const Layout = lazy(() => import('../components/layout'));
const AppRoot = lazy(() => import('./app-root'));

/**
 * Component wrapper to handle language URL parameter
 * Uses the useLanguageFromURL hook to process language switching
 */
const LanguageHandler = ({ children }: { children: React.ReactNode }) => {
    useLanguageFromURL();
    return <>{children}</>;
};

// The static preview build is served under /bot/preview (see rsbuild.config.ts
// assetPrefix), so React Router must resolve routes under that prefix. Standalone
// partner deploys are served at the root, so no basename there.
const routerBasename = isPreviewMode() ? PREVIEW_BASE_PATH : BASE_PATH || undefined;

const router = createBrowserRouter(
    createRoutesFromElements(
        <Route
            path='/'
            element={
                <Suspense
                    fallback={<ChunkLoader message={localize('Please wait while we connect to the server...')} />}
                >
                    <TranslationProvider defaultLang='EN' i18nInstance={i18nInstance}>
                        <LanguageHandler>
                            <StoreProvider>
                                <LocalStorageSyncWrapper>
                                    <RoutePromptDialog />
                                    <CoreStoreProvider>
                                        <Layout />
                                    </CoreStoreProvider>
                                </LocalStorageSyncWrapper>
                            </StoreProvider>
                        </LanguageHandler>
                    </TranslationProvider>
                </Suspense>
            }
        >
            {/* All child routes will be passed as children to Layout */}
            <Route index element={<AppRoot />} />
            {/* App Builder embeds the template at /preview — render the same app shell */}
            <Route path='preview' element={<AppRoot />} />
        </Route>
    ),
    { basename: routerBasename }
);

/**
 * Main App component
 *
 * Responsibilities:
 * 1. OAuth callback handling (via vendored deriv-core handleOAuthCallback)
 * 2. Account switching from URL (via useAccountSwitching hook)
 * 3. Router provider setup
 */
/** Explains a failed login in words a user can act on. */
const describeLoginError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    if (/CSRF|state parameter|verifier/i.test(message)) {
        return localize(
            'Login could not be completed because it finished in a different browser or app, or took longer than 30 minutes. Open this site in your normal browser (Chrome or Safari, not an in-app browser) and log in again.'
        );
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
        return localize(
            "Could not reach Deriv's login server. Check your internet connection, turn off ad or tracker blockers for this site, and log in again."
        );
    }
    if (/OAuth error/i.test(message)) {
        return localize('Deriv cancelled the login ({{reason}}). Please try again.', {
            reason: message.replace(/^OAuth error:\s*/i, ''),
        });
    }
    if (/Token exchange failed/i.test(message)) {
        return localize('Deriv did not accept the login code ({{reason}}). Please log in again.', { reason: message });
    }
    if (/Failed to fetch accounts/i.test(message)) {
        return localize('You are signed in to Deriv, but your trading accounts could not be loaded ({{reason}}).', {
            reason: message,
        });
    }
    return localize('Login failed: {{reason}}', { reason: message });
};

const LoginErrorBanner = ({ message, onClose }: { message: string; onClose: () => void }) => (
    <div
        role='alert'
        style={{
            position: 'fixed',
            top: '1.2rem',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10000,
            display: 'flex',
            gap: '1.2rem',
            alignItems: 'flex-start',
            width: 'min(56rem, calc(100vw - 3.2rem))',
            padding: '1.4rem 1.6rem',
            borderRadius: '0.8rem',
            background: '#ff444f',
            color: '#fff',
            fontSize: '1.4rem',
            lineHeight: 1.4,
            boxShadow: '0 0.6rem 2rem rgba(0, 0, 0, 0.25)',
        }}
    >
        <span style={{ flex: 1 }}>{message}</span>
        <button
            type='button'
            onClick={onClose}
            aria-label={localize('Close')}
            style={{ border: 'none', background: 'none', color: '#fff', fontSize: '2rem', lineHeight: 1, cursor: 'pointer' }}
        >
            ×
        </button>
    </div>
);

function App() {
    // Handle account switching via URL parameter
    useAccountSwitching();
    const [login_error, setLoginError] = React.useState('');

    React.useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        if (!urlParams.has('code')) return;

        const handleCallback = async () => {
            try {
                const authInfo = await handleOAuthCallback(window.location.href, {
                    clientId: process.env.NEXT_PUBLIC_DERIV_APP_ID || '',
                    redirectUri: getAppUrl(),
                    scopes: 'trade',
                });

                const { DerivWSAccountsService } = await import('@/services/derivws-accounts.service');
                const accounts = await DerivWSAccountsService.fetchAccountsList(authInfo.access_token);

                if (accounts && accounts.length > 0) {
                    DerivWSAccountsService.storeAccounts(accounts);
                    const firstAccount = accounts[0];
                    localStorage.setItem('active_loginid', firstAccount.account_id);
                    const isDemo =
                        firstAccount.account_id.startsWith('VRT') || firstAccount.account_id.startsWith('VRTC');
                    localStorage.setItem('account_type', isDemo ? 'demo' : 'real');

                    const { api_base } = await import('@/external/bot-skeleton');
                    await api_base.init(true);
                } else {
                    console.error('No accounts returned after authentication');
                    setLoginError(
                        localize(
                            'You are signed in to Deriv, but no trading accounts were found for this app. Open Deriv, make sure you have an Options trading account (demo or real), then log in again.'
                        )
                    );
                }
            } catch (error) {
                console.error('OAuth callback error:', error);
                setLoginError(describeLoginError(error));
            } finally {
                cleanupUrl(getAppUrl());
            }
        };

        handleCallback();
    }, []);

    return (
        <>
            {login_error && <LoginErrorBanner message={login_error} onClose={() => setLoginError('')} />}
            <RouterProvider router={router} />
        </>
    );
}

export default App;
