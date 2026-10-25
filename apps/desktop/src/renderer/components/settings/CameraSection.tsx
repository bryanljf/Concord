import { useEffect, useState } from 'react';
import type { PipLayout } from '../../../preload/api';
import { useVideoInputs } from '../../hooks/useVideoInputs';
import { cameraConstraints, cameraErrorMessage } from '../../lib/cameraEncoding';
import type { Settings } from '../../lib/concord';
import { Spinner } from '../Spinner';
import { CameraIcon, CameraOffIcon } from '../icons';
import { LocalPreview } from '../stream/LocalPreview';
import { SettingsSection } from './SettingsSection';

interface CameraSectionProps {
  settings: Settings;
  /** This client has the cameras' picture-in-picture window (`capabilities.pip`). */
  pip?: boolean;
  onUpdate(patch: Partial<Settings>): void;
}

const LAYOUTS: { id: PipLayout; label: string; desc: string }[] = [
  { id: 'vertical', label: 'Vertical', desc: 'Uma câmera embaixo da outra.' },
  { id: 'horizontal', label: 'Horizontal', desc: 'Uma câmera ao lado da outra.' },
];

type TestState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'on'; track: MediaStreamTrack }
  | { status: 'error'; message: string };

/** Outcome of one test run (`key` = which run, so a stale one never shows). */
interface TestResult {
  key: string;
  state: TestState;
}

/**
 * "Testar câmera": a local, mirrored preview of `deviceId` (nothing is published) while
 * `runKey` is set; a new key opens the camera again. The capture stops when the test is turned
 * off, the device changes or the section unmounts.
 */
function useCameraTest(
  runKey: string | null,
  deviceId: string | null,
  onOpened: () => void,
): TestState {
  const [result, setResult] = useState<TestResult | null>(null);

  useEffect(() => {
    if (runKey === null) return;
    let active = true;
    let stream: MediaStream | null = null;
    const stopAll = (): void => {
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
    const fail = (message: string): void => {
      if (active) setResult({ key: runKey, state: { status: 'error', message } });
    };
    navigator.mediaDevices.getUserMedia(cameraConstraints(deviceId)).then(
      (opened) => {
        stream = opened;
        if (!active) {
          stopAll();
          return;
        }
        const track = opened.getVideoTracks()[0];
        if (!track) {
          stopAll();
          fail('A câmera não retornou vídeo.');
          return;
        }
        track.addEventListener('ended', () => fail('A câmera foi desconectada.'), { once: true });
        setResult({ key: runKey, state: { status: 'on', track } });
        onOpened();
      },
      (err: unknown) => fail(cameraErrorMessage(err)),
    );
    return () => {
      active = false;
      stopAll();
    };
  }, [runKey, deviceId, onOpened]);

  if (runKey === null) return { status: 'idle' };
  if (result?.key !== runKey) return { status: 'starting' };
  return result.state;
}

/**
 * "Câmera e picture-in-picture": webcam device, test preview and PiP behaviour (just "Câmera"
 * on a client without the PiP window).
 */
export function CameraSection({ settings, pip = true, onUpdate }: CameraSectionProps) {
  const { devices, refresh } = useVideoInputs();
  const [testing, setTesting] = useState(false);
  // Every press of "Testar câmera" is a new run (a failed one can be retried).
  const [testRun, setTestRun] = useState(0);
  const deviceId = settings.cameraDeviceId;
  // Names show up once a camera was opened: list again after the test opened one.
  const test = useCameraTest(testing ? `${testRun}:${deviceId ?? ''}` : null, deviceId, refresh);

  const selected = deviceId ?? '';
  const selectedIsUnknown = selected !== '' && !devices.some((device) => device.id === selected);
  const testOn = testing && test.status !== 'error';

  function toggleTest(): void {
    if (testOn) {
      setTesting(false);
      return;
    }
    setTesting(true);
    setTestRun((previous) => previous + 1);
  }

  return (
    <SettingsSection id="camera" title={pip ? 'Câmera e picture-in-picture' : 'Câmera'}>
      <div className="field">
        <label className="field__label" htmlFor="settings-camera-device">
          Câmera
        </label>
        <select
          id="settings-camera-device"
          className="select"
          value={selected}
          onChange={(event) => onUpdate({ cameraDeviceId: event.target.value || null })}
        >
          <option value="">Padrão do sistema</option>
          {selectedIsUnknown && <option value={selected}>Câmera salva (desconectada)</option>}
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label}
            </option>
          ))}
        </select>
        <p className="field__hint">
          Ligue pelo botão “Câmera” na barra de baixo, dentro de uma sala. Ela só aparece para quem
          clicar em “Assistir”.
        </p>
      </div>
      <div className="camera-test">
        <div className="settings__actions">
          <button
            type="button"
            className={testOn ? 'btn btn--sm' : 'btn btn--primary btn--sm'}
            aria-pressed={testOn}
            onClick={toggleTest}
          >
            {testOn ? <CameraOffIcon size={16} /> : <CameraIcon size={16} />}
            {testOn ? 'Parar teste' : 'Testar câmera'}
          </button>
        </div>
        {testOn && (
          <div className="camera-test__preview" role="status">
            {test.status === 'on' ? (
              <LocalPreview track={test.track} className="camera-test__video" />
            ) : (
              <Spinner label="Abrindo a câmera" />
            )}
          </div>
        )}
        {test.status === 'error' && (
          <p className="field__error" role="alert">
            {test.message}
          </p>
        )}
      </div>

      {pip && (
        <>
          <h3 className="settings__subheading">Picture-in-picture das câmeras</h3>
          <label className="switch">
            <span className="switch__text">
              <span className="switch__title">Por cima de tudo, inclusive jogos em tela cheia</span>
              <span className="switch__desc">
                Desligado, a janelinha vira uma janela comum e pode ficar atrás das outras.
              </span>
            </span>
            <input
              type="checkbox"
              checked={settings.pipAlwaysOnTop}
              onChange={(event) => onUpdate({ pipAlwaysOnTop: event.target.checked })}
            />
          </label>
          <fieldset className="settings__fieldset">
            <legend className="field__label">Disposição das câmeras</legend>
            <div className="radio-group radio-group--inline">
              {LAYOUTS.map((layout) => (
                <label key={layout.id} className="radio">
                  <input
                    type="radio"
                    name="pip-layout"
                    value={layout.id}
                    checked={settings.pipLayout === layout.id}
                    onChange={() => onUpdate({ pipLayout: layout.id })}
                  />
                  <span className="radio__text">
                    <span className="radio__title">{layout.label}</span>
                    <span className="radio__desc">{layout.desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="settings__actions">
            <button
              type="button"
              className="btn btn--sm"
              disabled={settings.pipPosition === null}
              data-tooltip={
                settings.pipPosition === null ? 'Já está no canto superior direito' : undefined
              }
              onClick={() => onUpdate({ pipPosition: null })}
            >
              Voltar o picture-in-picture ao canto superior direito
            </button>
          </div>
          <p className="field__hint">
            Jogos em tela cheia exclusiva ficam por cima do picture-in-picture; use tela cheia sem
            bordas. O picture-in-picture não aparece nas suas transmissões nem em capturas de tela.
          </p>
        </>
      )}
    </SettingsSection>
  );
}
