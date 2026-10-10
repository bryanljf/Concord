import { useState } from 'react';
import type { UserInfo } from '@concord/shared';
import { DEFAULT_SERVER_URL } from '../../lib/constants';
import { KeyStep } from './KeyStep';
import { PreferencesStep } from './PreferencesStep';
import { ServerStep } from './ServerStep';
import '../../styles/onboarding.css';

/** `full` = first run (3 steps); `rekey` = only swap the access key. */
export type OnboardingFlow = 'full' | 'rekey';

type Step = 'server' | 'key' | 'prefs';

const STEPS: Step[] = ['server', 'key', 'prefs'];

interface OnboardingProps {
  flow: OnboardingFlow;
  initialServerUrl: string;
  onLogin(serverUrl: string, key: string): Promise<UserInfo>;
  onFinish(): void;
}

export function Onboarding({ flow, initialServerUrl, onLogin, onFinish }: OnboardingProps) {
  const [step, setStep] = useState<Step>(flow === 'rekey' ? 'key' : 'server');
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
              setStep('key');
            }}
          />
        )}
        {step === 'key' && (
          <KeyStep
            serverUrl={serverUrl}
            user={user}
            continueLabel={flow === 'rekey' ? 'Concluir' : 'Continuar'}
            onBack={() => setStep('server')}
            onLogin={async (key) => setUser(await onLogin(serverUrl, key))}
            onContinue={() => (flow === 'rekey' ? onFinish() : setStep('prefs'))}
          />
        )}
        {step === 'prefs' && <PreferencesStep onFinish={onFinish} />}
      </div>
    </div>
  );
}
