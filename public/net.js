// Encrypted rooms over two free public MQTT brokers. Every message goes through both, so the
// game keeps going if one is down. The brokers only ever see ciphertext: the AES key lives in the
// invite link after the #, which browsers never send to any server. The room's topic is a hash
// of the code and key, so knowing the code alone does not find the room.

const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = {
  to(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  from(s) {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(b, (ch) => ch.charCodeAt(0));
  },
};

export const newKey = () => b64u.to(crypto.getRandomValues(new Uint8Array(16)));

export function validKey(s) {
  try { return /^[A-Za-z0-9_-]{22}$/.test(s) && b64u.from(s).length === 16; } catch { return false; }
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * subs: topic suffixes to listen on. onMessage(suffix, data). onStatus('online' | 'connecting').
 */
export async function openRoom(code, keyStr, { subs, onMessage, onStatus }) {
  const key = await crypto.subtle.importKey('raw', b64u.from(keyStr), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const room = `truecount/v1/${hex(await crypto.subtle.digest('SHA-256', enc.encode(`${code}:${keyStr}`))).slice(0, 32)}`;
  const seen = new Set();
  const order = [];

  const clients = BROKERS.map((url) => {
    const c = mqtt.connect(url, { reconnectPeriod: 2000, connectTimeout: 10000, keepalive: 30, clean: true });
    c.on('connect', () => { c.subscribe(subs.map((s) => `${room}/${s}`), { qos: 1 }); status(); });
    c.on('close', status);
    c.on('offline', status);
    c.on('error', () => { /* mqtt.js retries on its own */ });
    c.on('message', async (topic, payload) => {
      if (!payload || payload.length < 13) return;
      let data;
      try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.slice(0, 12) }, key, payload.slice(12));
        data = JSON.parse(dec.decode(plain));
      } catch { return; } // not ours, or tampered with
      if (data.mid) {
        if (seen.has(data.mid)) return;
        seen.add(data.mid);
        order.push(data.mid);
        if (order.length > 500) seen.delete(order.shift());
      }
      onMessage(topic.slice(room.length + 1), data);
    });
    return c;
  });

  function status() {
    onStatus(clients.some((c) => c.connected) ? 'online' : 'connecting');
  }

  return {
    get online() { return clients.some((c) => c.connected); },
    async publish(suffix, data, retain = false) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const body = enc.encode(JSON.stringify({ ...data, mid: crypto.randomUUID() }));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, body));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv);
      out.set(ct, 12);
      for (const c of clients) if (c.connected) c.publish(`${room}/${suffix}`, out, { qos: 1, retain });
    },
    close() { for (const c of clients) c.end(true); },
  };
}
