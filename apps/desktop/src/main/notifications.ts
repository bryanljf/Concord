import { Notification } from 'electron';
import { log } from './log';
import { resourcePath } from './resources';

const logger = log('notify');

export interface NotificationRequest {
  title: string;
  body: string;
  onClick?: () => void;
}

export interface Notifier {
  show(request: NotificationRequest): void;
}

/** Native OS notifications. Keeps shown notifications referenced so their click events fire. */
export function createNotifier(): Notifier {
  const shown = new Set<Notification>();
  return {
    show({ title, body, onClick }) {
      if (!Notification.isSupported()) {
        logger.warn(`notifications unsupported; dropped "${title}"`);
        return;
      }
      const notification = new Notification({ title, body, icon: resourcePath('icon.png') });
      shown.add(notification);
      notification.on('click', () => {
        shown.delete(notification);
        onClick?.();
      });
      notification.on('close', () => shown.delete(notification));
      notification.on('failed', (_event, error) => {
        shown.delete(notification);
        logger.warn(`notification failed: ${error}`);
      });
      notification.show();
      logger.info(`shown "${title}"`);
    },
  };
}
