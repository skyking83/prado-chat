/* eslint-env serviceworker */
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
    let plainText = '🔒 [Encrypted Message]';
    const spaceId = data.data?.spaceId;
    
    // Attempt E2EE decryption using IndexedDB room keys
    if (spaceId && data.body && data.body.length > 20) {
      try {
        const jwkObj = await getRoomKey(spaceId);
        if (jwkObj) {
          const aesKey = await self.crypto.subtle.importKey(
            "jwk", jwkObj, { name: "AES-GCM" }, false, ["decrypt"]
          );
          
          const rawData = base64ToUint8Array(data.body);
          const iv = rawData.slice(0, 12);
          const ciphertext = rawData.slice(12);
          
          const decBuffer = await self.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv }, aesKey, ciphertext
          );
          plainText = new TextDecoder().decode(decBuffer);
        }
      } catch (e) {
        console.error('SW Decryption Error', e);
        plainText = '🔒 [Decryption Failed]';
      }
    } else if (data.body) {
      plainText = data.body;
    }

    // Build notification tag for grouping by space
    const tag = `prado-space-${spaceId || 'unknown'}`;
    const senderName = data.data?.senderDisplayName || data.title || 'Someone';
    const isDm = data.data?.isDm;
    const spaceName = data.data?.spaceName;

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
