import { BootScreen } from './components/BootScreen';
import { Onboarding } from './components/onboarding/Onboarding';
import { ToastProvider } from './components/toast/ToastProvider';
import { Workspace } from './components/Workspace';
import { useSession } from './hooks/useSession';

export function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}

/** Session gate: loading → boot screen; no user (or onboarding in progress) → Onboarding. */
function Root() {
  const session = useSession();

  if (session.loading) return <BootScreen />;
  if (session.error && !session.user) return <BootScreen error={session.error} />;
  if (session.onboarding !== 'none' || !session.user) {
    return (
      <Onboarding
        key={session.onboarding}
        flow={session.onboarding === 'rekey' ? 'rekey' : 'full'}
        initialServerUrl={session.serverUrl}
        onLogin={session.login}
        onFinish={session.finishOnboarding}
      />
    );
  }
  return <Workspace user={session.user} onRekey={() => void session.startRekey()} />;
}
