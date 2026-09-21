/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

// Workbox injects the precache manifest here at build time.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Tapping a "Leave now" notification focuses the app window (or opens it).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const base = new URL(self.registration.scope).pathname;
      for (const client of windows) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client && !client.url.includes(base)) {
            await (client as WindowClient).navigate(base);
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(base);
      }
    })(),
  );
});
