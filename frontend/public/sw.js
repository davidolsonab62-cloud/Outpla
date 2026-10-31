/* Outpla service worker - web push only (no offline caching, so it can't break deploys). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const IS_IOS = /iPhone|iPad|iPod/i.test(self.navigator.userAgent || "");

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = { title: "Outpla", body: event.data ? event.data.text() : "" };
  }
  const title = d.title || "Outpla";

  event.waitUntil(
    (async () => {
      // If the player is looking at the app, the in-app toasts already tell them.
      // iOS forbids silent pushes, so there we always show the notification.
      if (!IS_IOS) {
        const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        if (wins.some((w) => w.visibilityState === "visible" && w.focused)) return;
      }
      await self.registration.showNotification(title, {
        body: d.body || "",
        icon: "/android-chrome-192x192.png",
        badge: "/favicon-32x32.png",
        tag: d.tag || undefined,
        renotify: !!d.tag,
        data: { url: d.url || "/lobby" },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/lobby";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await w.focus();
          w.postMessage({ type: "outpla:navigate", url });
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
