/* eslint-env serviceworker */

// -- App Shell Cache & Offline Fallback --
const SW_VERSION = '2.1.0-e2ee-push';
const CACHE_NAME = 'prado-v1';
const OFFLINE_ASSETS = ['/icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(OFFLINE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only intercept navigation requests (HTML pages)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(
          `<!DOCTYPE html>
          <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
          <title>Prado Chat - Offline</title>
          <style>
            body{font-family:system-ui,sans-serif;background:#1c1b1f;color:#e6e1e5;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:2rem}
            h1{font-size:2rem;margin-bottom:1rem}p{opacity:0.7;max-width:300px;line-height:1.6}
            button{margin-top:2rem;padding:12px 32px;border:none;border-radius:100px;background:#4CAF50;color:#fff;font-size:1rem;cursor:pointer}
          </style></head><body>
          <img src="/icon.png" width="64" height="64" style="border-radius:14px;margin-bottom:24px" alt="Prado">
          <h1>You're Offline</h1>
          <p>Prado Chat needs an internet connection. Check your WiFi or cellular data and try again.</p>
          <button onclick="location.reload()">Retry</button>
          </body></html>`,
          { headers: { 'Content-Type': 'text/html' } }
        );
      })
    );
    return;
  }
  // For non-navigation requests, try cache first for static assets, network otherwise
  if (event.request.url.match(/\.(png|jpg|jpeg|svg|ico|woff2?)$/)) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
  }
});

// -- E2EE Push Helpers --
function base64ToUint8Array(base64) {
  const binary_string = atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary_string.charCodeAt(i);
  return bytes;
}

function getRoomKey(spaceId) {
  return new Promise((resolve) => {
    const req = indexedDB.open('prado_crypto_db', 1);
    req.onsuccess = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('room_keys')) return resolve(null);
      const tx = db.transaction('room_keys', 'readonly');
      const store = tx.objectStore('room_keys');
      const getReq = store.get(String(spaceId));
      getReq.onsuccess = () => resolve(getReq.result ? getReq.result.jwk : null);
      getReq.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}

// -- Push Event: Decrypt E2EE payload and display rich notification --
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : null;
  if (!data) return;

  event.waitUntil((async () => {
    let plainText = data.body || 'Sent a message';
    const spaceId = data.data?.spaceId;
    const encryptedBody = data.data?.encryptedBody;
    
    // Try client-side E2EE decryption using cached IDB room keys
    if (spaceId && encryptedBody) {
      try {
        const jwkObj = await getRoomKey(spaceId);
        if (jwkObj) {
          const aesKey = await self.crypto.subtle.importKey(
            "jwk", jwkObj, { name: "AES-GCM" }, false, ["decrypt"]
          );
          
          const rawData = base64ToUint8Array(encryptedBody);
          const iv = rawData.slice(0, 12);
          const ciphertext = rawData.slice(12);
          
          const decBuffer = await self.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv }, aesKey, ciphertext
          );
          let decrypted = new TextDecoder().decode(decBuffer);
          // Strip markdown for clean notification text
          decrypted = decrypted.replace(/\*\*(.*?)\*\*/g, '$1')
                               .replace(/\*(.*?)\*/g, '$1')
                               .replace(/~~(.*?)~~/g, '$1')
                               .replace(/`([^`]+)`/g, '$1')
                               .replace(/^#+\s*/gm, '')
                               .replace(/\n/g, ' ')
                               .trim();
          if (decrypted) plainText = decrypted.substring(0, 200);
        }
      } catch (e) {
        // Decryption failed — use fallback body (already set)
        console.error('SW E2EE decryption failed, using fallback', e);
      }
    }

    // Build notification tag for grouping by space
    const tag = `prado-space-${spaceId || 'unknown'}`;

    // Check for existing notifications in this group to stack them
    const existingNotifications = await self.registration.getNotifications({ tag });
    let body = plainText;
    
    if (existingNotifications.length > 0) {
      // Stack: count previous messages and show summary
      const prevCount = existingNotifications[0].data?.messageCount || 1;
      const newCount = prevCount + 1;
      
      // Close previous notification to replace it
      existingNotifications.forEach(n => n.close());
      
      body = `${plainText}\n— ${newCount} new messages`;
      
      // Preserve the message count in data
      data.data = { ...data.data, messageCount: newCount };
    } else {
      data.data = { ...data.data, messageCount: 1 };
    }

    const options = {
      body,
      icon: data.icon || '/icon.png',
      badge: '/icon.png',
      tag, // Groups notifications by space
      renotify: true, // Vibrate/sound even when replacing a grouped notification
      data: data.data || {},
      vibrate: [100, 50, 100],
      timestamp: data.data?.timestamp || Date.now(),
      actions: [
        { action: 'reply', title: '💬 Reply', type: 'text', placeholder: 'Type a reply...' },
        { action: 'open', title: '📱 Open' }
      ]
    };

    await self.registration.showNotification(data.title, options);
  })());
});

// -- Notification Click: Navigate to the correct space --
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = event.notification.data || {};
  const spaceId = notifData.spaceId;
  const action = event.action;

  // Handle reply action
  if (action === 'reply') {
    // On Android, event.reply contains the inline text
    if (event.reply) {
      event.waitUntil((async () => {
        const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (clientList.length > 0) {
          clientList[0].postMessage({
            type: 'PUSH_REPLY',
            spaceId: spaceId,
            text: event.reply
          });
          return clientList[0].focus();
        }
        return clients.openWindow(`/?space=${spaceId}`);
      })());
      return;
    }
    // On desktop, open the app focused on the space with input focused
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        if (clientList.length > 0) {
          const client = clientList.find(c => c.focused) || clientList[0];
          client.postMessage({
            type: 'NAVIGATE_TO_SPACE',
            spaceId: spaceId,
            focusInput: true
          });
          return client.focus();
        }
        return clients.openWindow(`/?space=${spaceId}`);
      })
    );
    return;
  }

  // Handle open / default click — navigate to the correct space
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If an app window exists, focus it and send navigation command
      if (clientList.length > 0) {
        const client = clientList.find(c => c.focused) || clientList[0];
        client.postMessage({
          type: 'NAVIGATE_TO_SPACE',
          spaceId: spaceId
        });
        return client.focus();
      }
      // No window open — launch a new one targeting the space
      return clients.openWindow(`/?space=${spaceId}`);
    })
  );
});
