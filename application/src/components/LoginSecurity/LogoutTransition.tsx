'use client';

import { useSyncExternalStore } from 'react';
import { useLocalization } from '@/src/context/localization';
import { Button } from '@/src/components/ui/button';
import { finishLogoutAfterFailure, getLogoutPhase, retryAuthLogout, subscribeToLogout } from '@/src/utils/session-lifecycle';

export function useLogoutPhase() {
  return useSyncExternalStore(subscribeToLogout, getLogoutPhase, () => 'idle' as const);
}

/** The old document stays noninteractive until its owned navigation completes. */
export default function LogoutTransition() {
  const phase = useLogoutPhase();
  const { t } = useLocalization();
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-white p-6">
      <section className="max-w-md space-y-4 text-center" aria-label={t('Signing out...')}>
        <p role={phase === 'failed' || phase === 'navigation-failed' ? 'alert' : 'status'}>
          {phase === 'failed'
            ? t('Sign-out could not be confirmed. Retry, or return to sign-in after the request has stopped.')
            : phase === 'navigation-failed'
              ? t('The sign-in page did not open. Try again.')
              : t('Signing out...')}
        </p>
        {(phase === 'failed' || phase === 'navigation-failed') && (
          <div className="flex flex-wrap justify-center gap-3">
            {phase === 'failed' && <Button onClick={() => { void retryAuthLogout(); }}>{t('Retry sign-out')}</Button>}
            <Button variant="outline" onClick={finishLogoutAfterFailure}>{t('Return to sign-in')}</Button>
          </div>
        )}
      </section>
    </div>
  );
}
