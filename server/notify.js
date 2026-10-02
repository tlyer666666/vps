// Generic webhook notifier. Failures are logged and reported as `false` —
// a dead webhook must never take down ingest or the alert engine.
export function createNotifier({ webhookUrl, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  return async function notify(event, server) {
    if (!webhookUrl) return true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(webhookUrl, {
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
        console.warn(`[notify] webhook ${webhookUrl} responded ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      const reason = err?.name === 'AbortError' ? 'timeout' : err?.message;
      console.warn(`[notify] webhook ${webhookUrl} failed: ${reason}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
