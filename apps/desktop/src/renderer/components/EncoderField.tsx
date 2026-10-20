import type { VideoEncoderPreference } from '../../preload/api';

interface EncoderFieldProps {
  /** Prefix of the select's id ("picker", "settings"). */
  idPrefix: string;
  /** `Settings.videoEncoder`. */
  value: VideoEncoderPreference;
  onChange(encoder: VideoEncoderPreference): void;
  /** You are live: the current live keeps its encoder, the hint says so. */
  live?: boolean;
}

const ENCODER_LABELS: Record<VideoEncoderPreference, string> = {
  cpu: 'CPU (padrão)',
  gpu: 'GPU (placa de vídeo)',
};

const ENCODER_HINTS: Record<VideoEncoderPreference, string> = {
  cpu: 'Codifica no processador (OpenH264), como sempre: funciona em qualquer PC, mas disputa a CPU com o jogo.',
  gpu: 'Usa o encoder H.264 da placa de vídeo e alivia a CPU. Sem suporte na placa, continua na CPU.',
};

/**
 * Who encodes the lives and the webcam (`lib/encoderPreference.ts`). Applies to the next live or
 * camera: what is already being sent keeps its encoder.
 */
export function EncoderField({ idPrefix, value, onChange, live = false }: EncoderFieldProps) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={`${idPrefix}-encoder`}>
        Codificação de vídeo
      </label>
      <select
        id={`${idPrefix}-encoder`}
        className="select"
        value={value}
        onChange={(event) => onChange(event.target.value === 'gpu' ? 'gpu' : 'cpu')}
      >
        {(['cpu', 'gpu'] as const).map((encoder) => (
          <option key={encoder} value={encoder}>
            {ENCODER_LABELS[encoder]}
          </option>
        ))}
      </select>
      <p className="field__hint">
        {ENCODER_HINTS[value]}
        {live && ' A live atual continua como está: vale a partir da próxima.'}
      </p>
    </div>
  );
}
