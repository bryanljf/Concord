import { BootScreen } from './components/BootScreen';
import { Onboarding } from './components/onboarding/Onboarding';
import { PopoutView } from './components/popout/PopoutView';
import { ToastProvider } from './components/toast/ToastProvider';
import { Workspace } from './components/Workspace';
import { useSession } from './hooks/useSession';
import { concord } from './lib/concord';

export function App() {
  // The pop-out BrowserWindow loads the same bundle; main tells the preload which one it is.
  if (concord().windowKind === 'popout') return <PopoutView />;
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
