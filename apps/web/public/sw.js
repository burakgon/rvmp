self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data?.json() ?? {}; } catch { return; }
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.some(client => client.visibilityState === "visible")) return;
    await self.registration.showNotification(data.title || "rvmp", {
      body: data.body || "attention needed",
      tag: data.tag || "rvmp",
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      data: { url: data.url || "/" },
    });
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("navigate" in client) await client.navigate(target);
      if ("focus" in client) return client.focus();
    }
    return self.clients.openWindow(target);
  })());
});
