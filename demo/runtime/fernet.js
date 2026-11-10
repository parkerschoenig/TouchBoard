/* TouchBoard demo — the backup envelope from backend/backup.py, in WebCrypto:
 * PBKDF2-HMAC-SHA256 (200k) → Fernet (AES-128-CBC + HMAC-SHA256). Exports made
 * here are real TouchBoard backups, and real backups import here. */
(function (g) {
  'use strict';
  var subtle = g.crypto.subtle;
  var enc = new TextEncoder(), dec = new TextDecoder();

  function b64(bytes, urlsafe) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    var s = btoa(bin);
    return urlsafe ? s.replace(/\+/g, '-').replace(/\//g, '_') : s;
  }
  function unb64(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); });
  }
  function concat() {
    var parts = Array.from(arguments), n = parts.reduce(function (s, p) { return s + p.length; }, 0);
    var out = new Uint8Array(n), o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  }

  async function deriveKey(passphrase, salt, iterations) {
    var base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    var bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations }, base, 256);
    var key = new Uint8Array(bits);
    return {
      sign: await subtle.importKey('raw', key.slice(0, 16), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
      crypt: await subtle.importKey('raw', key.slice(16), { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']),
    };
  }

  async function fernetEncrypt(keys, plaintext) {
    var iv = g.crypto.getRandomValues(new Uint8Array(16));
    var ts = new Uint8Array(8);
    new DataView(ts.buffer).setBigUint64(0, BigInt(Math.floor(Date.now() / 1000)));
    var ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: iv }, keys.crypt, enc.encode(plaintext)));
    var body = concat(new Uint8Array([0x80]), ts, iv, ct);
    var mac = new Uint8Array(await subtle.sign('HMAC', keys.sign, body));
    return b64(concat(body, mac), true);
  }

  async function fernetDecrypt(keys, token) {
    var raw = unb64(token);
    if (raw[0] !== 0x80 || raw.length < 57) throw new Error('bad token');
    var body = raw.slice(0, raw.length - 32), mac = raw.slice(raw.length - 32);
    if (!(await subtle.verify('HMAC', keys.sign, mac, body))) throw new Error('bad signature');
    var pt = await subtle.decrypt({ name: 'AES-CBC', iv: body.slice(9, 25) }, keys.crypt, body.slice(25));
    return dec.decode(pt);
  }

  async function exportEnvelope(snapshot, passphrase) {
    if (!passphrase) throw new Error('passphrase required');
    var salt = g.crypto.getRandomValues(new Uint8Array(16));
    var keys = await deriveKey(passphrase, salt, 200000);
    return {
      format: 'touchboard-backup',
      version: 1,
      exported_at: new Date().toISOString(),
      kdf: 'pbkdf2-sha256',
      iterations: 200000,
      salt: b64(salt, false),
      data: await fernetEncrypt(keys, JSON.stringify(snapshot)),
    };
  }

  async function importEnvelope(envelope, passphrase) {
    if (!envelope || envelope.format !== 'touchboard-backup') throw new Error('not a TouchBoard backup file');
    if (!passphrase) throw new Error('passphrase required');
    try {
      var keys = await deriveKey(passphrase, unb64(envelope.salt), Number(envelope.iterations || 200000));
      return JSON.parse(await fernetDecrypt(keys, envelope.data));
    } catch (e) {
      throw new Error('incorrect passphrase or corrupt backup file');
    }
  }

  g.TouchBoardDemoFernet = { exportEnvelope: exportEnvelope, importEnvelope: importEnvelope };
})(window);
