import { app, nativeImage, NativeImage, Notification } from 'electron';
import log from 'electron-log';
import os from 'os';
import path from 'path';
import { TunnelState } from '../shared/daemon-rpc-types';
import {
  BlockWhenDisconnectedNotificationProvider,
  ConnectedNotificationProvider,
  ConnectingNotificationProvider,
  DisconnectedNotificationProvider,
  ErrorNotificationProvider,
  NotificationAction,
  ReconnectingNotificationProvider,
  SystemNotification,
  SystemNotificationProvider,
} from '../shared/notifications/notification';
import consumePromise from '../shared/promise';

interface NotificationControllerDelegate {
  openApp(): void;
  openLink(url: string, withAuth?: boolean): Promise<void>;
  isWindowVisible(): boolean;
  areSystemNotificationsEnabled(): boolean;
}

export default class NotificationController {
  private lastTunnelStateAnnouncement?: { body: string; notification: Notification };
  private reconnecting = false;
  private presentedNotifications: { [key: string]: boolean } = {};
  private pendingNotifications: Notification[] = [];
  private notificationTitle = process.platform === 'linux' ? app.name : '';
  private notificationIcon?: NativeImage;

  constructor(private notificationControllerDelegate: NotificationControllerDelegate) {
    let usePngIcon;
    if (process.platform === 'linux') {
      usePngIcon = true;
    } else if (process.platform === 'win32') {
      usePngIcon = parseInt(os.release().split('.')[0], 10) >= 10;
    } else {
      usePngIcon = false;
    }

    if (usePngIcon) {
      const basePath = path.resolve(path.join(__dirname, '../../assets/images'));
      this.notificationIcon = nativeImage.createFromPath(
        path.join(basePath, 'icon-notification.png'),
      );
    }
  }

  public notifyTunnelState(
    tunnelState: TunnelState,
    blockWhenDisconnected: boolean,
    accountExpiry?: string,
  ) {
    const notificationProviders: SystemNotificationProvider[] = [
      new ConnectingNotificationProvider({ tunnelState, reconnecting: this.reconnecting }),
      new ConnectedNotificationProvider(tunnelState),
      new ReconnectingNotificationProvider(tunnelState),
      new BlockWhenDisconnectedNotificationProvider({ tunnelState, blockWhenDisconnected }),
      new DisconnectedNotificationProvider(tunnelState),
      new ErrorNotificationProvider({ tunnelState, accountExpiry }),
    ];

    const notificationProvider = notificationProviders.find((notification) =>
      notification.mayDisplay(),
    );

    if (notificationProvider) {
      const notification = notificationProvider.getSystemNotification();

      if (notification) {
        this.showTunnelStateNotification(notification);
      } else {
        log.error(
          `Notification providers mayDisplay() returned true but getSystemNotification() returned undefined for ${notificationProvider.constructor.name}`,
        );
      }
    }

    this.reconnecting =
      tunnelState.state === 'disconnecting' && tunnelState.details === 'reconnect';
  }

  public cancelPendingNotifications() {
    for (const notification of this.pendingNotifications) {
      notification.close();
    }
  }

  public resetTunnelStateAnnouncements() {
    this.lastTunnelStateAnnouncement = undefined;
  }

  public notify(systemNotification: SystemNotification) {
    if (this.evaluateNotification(systemNotification)) {
      const notification = this.createNotification(systemNotification);
      this.addPendingNotification(notification);
      notification.show();

      if (!systemNotification.critical) {
        setTimeout(() => notification.close(), 4000);
      }

      return notification;
    } else {
      return;
    }
  }

  private createNotification(systemNotification: SystemNotification) {
    // Action buttons are only available on macOS.
    const notificationAction =
      process.platform === 'darwin' && systemNotification.action
        ? [{ type: 'button' as 'button', text: systemNotification.action.text }]
        : undefined;

    const notification = new Notification({
      title: this.notificationTitle,
      body: systemNotification.message,
      silent: true,
      icon: this.notificationIcon,
      timeoutType: systemNotification.critical ? 'never' : 'default',
      actions: notificationAction,
    });

    notification.on('action', () => this.performAction(systemNotification.action!));
    notification.on('click', () => this.performClickAction(systemNotification));

    return notification;
  }

  private performAction({ withAuth, url }: NotificationAction) {
    consumePromise(this.notificationControllerDelegate.openLink(url, withAuth));
  }

  private performClickAction(systemNotification: SystemNotification) {
    // Action buttons are only available on macOS and if a button is shown the onclick should open
    // the app instead of performing the action.
    if (process.platform !== 'darwin' && systemNotification.action) {
      this.performAction(systemNotification.action);
    } else {
      this.notificationControllerDelegate.openApp();
    }
  }

  private showTunnelStateNotification(systemNotification: SystemNotification) {
    const message = systemNotification.message;
    const lastAnnouncement = this.lastTunnelStateAnnouncement;
    const sameAsLastNotification = lastAnnouncement && lastAnnouncement.body === message;

    if (sameAsLastNotification) {
      return;
    }

    if (lastAnnouncement) {
      lastAnnouncement.notification.close();
    }

    const newNotification = this.notify(systemNotification);

    if (newNotification) {
      this.lastTunnelStateAnnouncement = {
        body: message,
        notification: newNotification,
      };
    }
  }

  private addPendingNotification(notification: Notification) {
    notification.on('close', () => {
      this.removePendingNotification(notification);
    });

    this.pendingNotifications.push(notification);
  }

  private removePendingNotification(notification: Notification) {
    const index = this.pendingNotifications.indexOf(notification);
    if (index !== -1) {
      this.pendingNotifications.splice(index, 1);
    }
  }

  private evaluateNotification(notification: SystemNotification) {
    const suppressDueToDevelopment =
      notification.suppressInDevelopment && process.env.NODE_ENV === 'development';
    const suppressDueToVisibleWindow = this.notificationControllerDelegate.isWindowVisible();
    const suppressDueToPreference =
      !this.notificationControllerDelegate.areSystemNotificationsEnabled() &&
      !notification.critical;

    return (
      !suppressDueToDevelopment &&
      !suppressDueToVisibleWindow &&
      !suppressDueToPreference &&
      !this.suppressDueToAlreadyPresented(notification)
    );
  }

  private suppressDueToAlreadyPresented(notification: SystemNotification) {
    const presented = this.presentedNotifications;
    if (notification.presentOnce?.value) {
      if (presented[notification.presentOnce.name]) {
        return true;
      } else {
        presented[notification.presentOnce.name] = true;
        return false;
      }
    } else {
      return false;
    }
  }
}
