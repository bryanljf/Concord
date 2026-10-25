import { useState } from 'react';
import type { UserInfo } from '@concord/shared';
import { capabilities } from '../../lib/capabilities';
import { DEFAULT_SERVER_URL } from '../../lib/constants';
import { KeyStep } from './KeyStep';
import { DiscordStep } from './DiscordStep';
import { PreferencesStep } from './PreferencesStep';
import { ServerStep } from './ServerStep';
import '../../styles/onboarding.css';

/** `full` = first run (3 steps); `rekey` = sign in again (Discord, or an access key). */
export type OnboardingFlow = 'full' | 'rekey';

type Step = 'server' | 'discord' | 'key' | 'prefs';

interface OnboardingProps {
  flow: OnboardingFlow;
  initialServerUrl: string;
  /** Web client: why the last Discord sign-in failed (shown on the Discord screen). */
  loginError?: string | null;
  onLogin(serverUrl: string, key: string): Promise<UserInfo>;
  onDiscordLogin(serverUrl: string): Promise<UserInfo>;
  onFinish(): void;
}

/**
 * The steps of the first run, by what this client offers: the server is typed on the desktop
 * (the web is served by its own server), preferences only exist with a tray or a shortcut. The
 * web client is left with the Discord screen alone.
 */
function stepsFor(can: ReturnType<typeof capabilities>): Step[] {
  const steps: Step[] = [];
  if (can.serverChoice) steps.push('server');
  steps.push('discord');
  if (can.tray || can.shortcut) steps.push('prefs');
  return steps;
}

export function Onboarding({
  flow,
  initialServerUrl,
  loginError = null,
  onLogin,
  onDiscordLogin,
  onFinish,
}: OnboardingProps) {
  const can = capabilities();
  const steps = stepsFor(can);
  const [step, setStep] = useState<Step>(
    flow === 'rekey' || !can.serverChoice ? 'discord' : 'server',
  );
  const [serverUrl, setServerUrl] = useState(initialServerUrl || DEFAULT_SERVER_URL);
  const [user, setUser] = useState<UserInfo | null>(null);

  const stepIndex = steps.indexOf(step);
  // After signing in: the preferences when the flow has them, else done.
  const afterSignIn = (): void => {
    if (flow === 'rekey' || !steps.includes('prefs')) onFinish();
    else setStep('prefs');
  };

  return (
    <div className="onboarding">
      <div className="onboarding__card">
        <div className="onboarding__brand">CONCORD</div>
        {flow === 'full' && steps.length > 1 && (
          <ol
            className="onboarding__steps"
            aria-label={`Passo ${stepIndex + 1} de ${steps.length}`}
          >
            {steps.map((name, index) => (
              <li
                key={name}
                className={
                  index <= stepIndex
                    ? 'onboarding__step onboarding__step--done'
                    : 'onboarding__step'
                }
                aria-current={name === step ? 'step' : undefined}
              />
            ))}
          </ol>
        )}
        {step === 'server' && (
          <ServerStep
            value={serverUrl}
            onSubmit={(url) => {
              setServerUrl(url);
              setStep('discord');
            }}
          />
        )}
        {step === 'discord' && (
          <DiscordStep
            serverUrl={serverUrl}
            user={user}
            initialError={loginError}
            onBack={can.serverChoice ? () => setStep('server') : undefined}
            onLogin={async () => setUser(await onDiscordLogin(serverUrl))}
            onUseKey={can.keyLogin ? () => setStep('key') : undefined}
            onContinue={afterSignIn}
          />
        )}
        {step === 'key' && (
          <KeyStep
            serverUrl={serverUrl}
            user={user}
            continueLabel={flow === 'rekey' ? 'Concluir' : 'Continuar'}
            onBack={() => setStep('discord')}
            onLogin={async (key) => setUser(await onLogin(serverUrl, key))}
            onContinue={afterSignIn}
          />
        )}
        {step === 'prefs' && <PreferencesStep onFinish={onFinish} />}
      </div>
    </div>
  );
}
