const gatewayStatuses = new Set(['sent', 'dry-run', 'duplicate', 'partial-failure', 'no-targets']);

class NotificationBridge {
  constructor(service, config, fetcher = fetch) {
    this.service = service;
    this.config = config;
    this.fetcher = fetcher;
    this.running = false;
  }

  async send(item) {
    const fallbackData = item.commandId
      ? { type: 'device.command', commandId: item.commandId }
      : { type: 'room.notification' };
    const response = await this.fetcher(this.config.notificationUrl, {
      method: 'POST',
      headers: {
        'X-Internal-Key': this.config.notificationKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eventId: item.id,
        title: item.title ?? '자취방 원격 케어',
        body: item.message,
        data: item.data ?? fallbackData,
      }),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Gateway notification request failed');
    const result = await response.json();
    if (!gatewayStatuses.has(result?.status)) throw new Error('Unknown Gateway notification result');
    return result;
  }

  async flush() {
    if (this.running || !this.config.notificationUrl || this.config.demo) return;
    const now = Date.now();
    const due = item => item.pushStatus === 'PENDING' && (item.nextAttemptAt ?? 0) <= now;
    if (!this.service.state.notifications.some(due)) return;

    this.running = true;
    try {
      // Only send rows that survived the originating transaction.
      const saved = await this.service.store.load();
      const pending = (saved?.notifications ?? []).filter(due).slice(0, 10);
      for (const item of pending) {
        let result;
        try {
          result = await this.send(item);
        } catch {
          // Retry transport or response failures with the original event ID.
        }
        await this.service.run(() => {
          const notification = this.service.state.notifications.find(row => row.id === item.id);
          if (!notification) return;
          notification.pushAttempts = (notification.pushAttempts ?? 0) + 1;
          if (!result) {
            notification.pushStatus = notification.pushAttempts >= 3 ? 'FAILED' : 'PENDING';
            if (notification.pushStatus === 'PENDING') notification.nextAttemptAt = Date.now() + 30000;
            else delete notification.nextAttemptAt;
            return;
          }
          delete notification.nextAttemptAt;
          notification.pushStatus = result.status.toUpperCase();
          notification.pushResult = {
            status: result.status,
            targetCount: result.targetCount ?? null,
            successCount: result.successCount ?? null,
          };
        });
      }
    } finally {
      this.running = false;
    }
  }
}

module.exports = { NotificationBridge };
