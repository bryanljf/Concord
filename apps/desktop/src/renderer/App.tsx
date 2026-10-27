import { useState } from 'react';
import { BootScreen } from './components/BootScreen';
import { Onboarding } from './components/onboarding/Onboarding';
import { PipView } from './components/pip/PipView';
import { PopoutView } from './components/popout/PopoutView';
import { ToastProvider } from './components/toast/ToastProvider';
import { TitleBar } from './components/TitleBar';
import { Workspace } from './components/Workspace';
import { useSession } from './hooks/useSession';
import { concord } from './lib/concord';

export function App() {
  // The pop-out and picture-in-picture windows load the same bundle; main tells the preload
  // which one it is.
  const windowKind = concord().windowKind;
  if (windowKind === 'popout') return <PopoutView />;
  if (windowKind === 'pip') return <PipView />;
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}

/**
 * Session gate: loading → boot screen; no user (or onboarding in progress) → Onboarding (on the
 * web with the reason the last Discord sign-in failed, if it did).
 */
function Root() {
  const [title, setTitle] = useState<string | null>(null);
  const { client, windowKind } = concord();
  const content = <Gate onTitleChange={setTitle} />;
  // The desktop main window has no native frame: our bar sits above every screen, and the screen
  // takes the rest. The web build (and its phone layout) renders the screen alone.
  if (client !== 'desktop' || windowKind !== 'main') return content;
  return (
    <div className="app-frame">
      <TitleBar title={title} />
      <div className="app-frame__content">{content}</div>
    </div>
  );
}

function Gate({ onTitleChange }: { onTitleChange: (title: string | null) => void }) {
  const session = useSession();

  if (session.loading) return <BootScreen />;
  if (session.error && !session.user) return <BootScreen error={session.error} />;
  if (session.onboarding !== 'none' || !session.user) {
    return (
      <Onboarding
        key={session.onboarding}
        flow={session.onboarding === 'rekey' ? 'rekey' : 'full'}
        initialServerUrl={session.serverUrl}
        loginError={session.loginError}
        onLogin={session.login}
        onDiscordLogin={session.loginWithDiscord}
        onFinish={session.finishOnboarding}
      />
    );
  }
  return (
    <Workspace
      user={session.user}
      onRekey={() => void session.startRekey()}
      onSetNickname={session.setNickname}
      onTitleChange={onTitleChange}
    />
  );
}
