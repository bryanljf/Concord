import type { ReactNode } from 'react';

interface SettingsSectionProps {
  id: string;
  title: string;
  children: ReactNode;
}

export function SettingsSection({ id, title, children }: SettingsSectionProps) {
  const headingId = `settings-${id}-title`;
  return (
    <section id={`settings-${id}`} className="settings__section" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      {children}
    </section>
  );
}
