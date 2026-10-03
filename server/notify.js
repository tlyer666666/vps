// Generic webhook notifier. Failures are logged and reported as `false` —
// a dead webhook must never take down ingest or the alert engine.
// webhookUrl may be a string or a getter (re-evaluated per call) so admin
// settings can change it live.
export function createNotifier({ webhookUrl, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  return async function notify(event, server) {
    const url = typeof webhookUrl === 'function' ? webhookUrl() : webhookUrl;
    if (!url) return true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'vpswatch/1.0',
        },
        body: JSON.stringify({
          text: `[VPSWatch] ${event.message}`,
          event,
          server,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[notify] webhook ${url} responded ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      const reason = err?.name === 'AbortError' ? 'timeout' : err?.message;
      console.warn(`[notify] webhook ${url} failed: ${reason}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

// Notification dispatcher: reads the admin settings, fans the event out to
// every configured channel in parallel, and NEVER throws — a dead channel or
// a failing settings read must not crash the hub (review iteration 4).
export function createDispatch({ store, notifier, sendTelegram: telegramImpl }) {
  return async function dispatch(event, subject) {
    let channels;
    try {
      const settings = store.getSetting('settings', {}) ?? {};
      channels = [];
      if (settings.webhookUrl) {
        channels.push(() => notifier(event, subject));
      }
      if (settings.telegram_bot_token && settings.telegram_chat_id) {
        channels.push(() => telegramImpl({
          botToken: settings.telegram_bot_token,
          chatId: settings.telegram_chat_id,
          text: `[VPSWatch] ${event.message}`,
        }));
      }
    } catch (err) {
      console.warn(`[notify] cannot read settings, notification dropped: ${err.message}`);
      return false;
    }
    if (!channels.length) return false;
    const results = await Promise.allSettled(channels.map((run) => run()));
    const delivered = results.map((r) => r.status === 'fulfilled' && r.value === true);
    if (delivered.some((ok) => !ok)) {
      console.warn(`[notify] ${delivered.filter((ok) => !ok).length}/${delivered.length} channel(s) failed for event ${event.type}`);
    }
    return delivered.length > 0 && delivered.every(Boolean);
  };
}
