onmessage = ev => {
  ev.waitUntil(self.registration.showNotification(ev.data));
};
