import { useState } from 'react';
import type { UserInfo } from '@concord/shared';
import { DEFAULT_SERVER_URL } from '../../lib/constants';
import { KeyStep } from './KeyStep';
import { DiscordStep } from './DiscordStep';
import { PreferencesStep } from './PreferencesStep';
import { ServerStep } from './ServerStep';
import '../../styles/onboarding.css';

/** `full` = first run (3 steps); `rekey` = sign in again (Discord, or an access key). */
export type OnboardingFlow = 'full' | 'rekey';

type Step = 'server' | 'discord' | 'key' | 'prefs';

const STEPS: Step[] = ['server', 'discord', 'prefs'];

interface OnboardingProps {
  flow: OnboardingFlow;
  initialServerUrl: string;
  onLogin(serverUrl: string, key: string): Promise<UserInfo>;
  onDiscordLogin(serverUrl: string): Promise<UserInfo>;
  onFinish(): void;
}

export function Onboarding({
  flow,
  initialServerUrl,
  onLogin,
  onDiscordLogin,
  onFinish,
}: OnboardingProps) {
  const [step, setStep] = useState<Step>(flow === 'rekey' ? 'discord' : 'server');
  const [serverUrl, setServerUrl] = useState(initialServerUrl || DEFAULT_SERVER_URL);
  const [user, setUser] = useState<UserInfo | null>(null);

  const stepIndex = STEPS.indexOf(step);

  return (
    <div className="onboarding">
      <div className="onboarding__card">
        <div className="onboarding__brand">CONCORD</div>
        {flow === 'full' && (
          <ol
            className="onboarding__steps"
            aria-label={`Passo ${stepIndex + 1} de ${STEPS.length}`}
          >
            {STEPS.map((name, index) => (
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
            onBack={() => setStep('server')}
            onLogin={async () => setUser(await onDiscordLogin(serverUrl))}
            onUseKey={() => setStep('key')}
            onContinue={() => (flow === 'rekey' ? onFinish() : setStep('prefs'))}
          />
        )}
        {step === 'key' && (
          <KeyStep
            serverUrl={serverUrl}
            user={user}
            continueLabel={flow === 'rekey' ? 'Concluir' : 'Continuar'}
            onBack={() => setStep('discord')}
            onLogin={async (key) => setUser(await onLogin(serverUrl, key))}
            onContinue={() => (flow === 'rekey' ? onFinish() : setStep('prefs'))}
          />
        )}
        {step === 'prefs' && <PreferencesStep onFinish={onFinish} />}
      </div>
    </div>
  );
}
