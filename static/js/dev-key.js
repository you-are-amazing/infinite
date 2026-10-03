/* Developer key: an extra lock in front of the admin inbox.
 * Only the developer's signed-in account can read/write the key document (see firestore.rules),
 * and only a salted PBKDF2 hash is stored, never the key itself.
 */
(function () {
  'use strict';
  var ADMIN_EMAIL = 'parmardarshan918@gmail.com';
  var ITER = 150000;
  var FLAG = 'infiniteDevUnlocked';

  function getDb() {
    try { return window.firebase && firebase.apps && firebase.apps.length ? firebase.firestore() : null; } catch (_) { return null; }
  }
  function withDb(fn) {
    return new Promise(function (resolve, reject) {
      var waited = 0;
      (function step() {
        var db = getDb();
        if (db) { try { resolve(fn(db)); } catch (e) { reject(e); } return; }
        if (waited >= 12000) { reject(new Error('Firestore is not ready')); return; }
        waited += 250; setTimeout(step, 250);
      })();
    });
  }
  function user() { try { return window.firebase && firebase.apps && firebase.apps.length ? firebase.auth().currentUser : null; } catch (_) { return null; } }
  function isOwner() { var u = user(); return !!(u && u.email && u.email.toLowerCase() === ADMIN_EMAIL); }

  function b64(buf) { return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))); }
  function derive(key, saltB64, iter) {
    var salt = Uint8Array.from(atob(saltB64), function (c) { return c.charCodeAt(0); });
    return crypto.subtle.importKey('raw', new TextEncoder().encode(key), 'PBKDF2', false, ['deriveBits'])
      .then(function (k) { return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' }, k, 256); })
      .then(b64);
  }

  function getConfig() {
    return withDb(function (db) { return db.collection('adminConfig').doc('devKey').get(); })
      .then(function (s) { return s.exists ? s.data() : null; });
  }
  function setKey(key) {
    var saltB64 = b64(crypto.getRandomValues(new Uint8Array(16)));
    return derive(key, saltB64, ITER).then(function (hash) {
      return withDb(function (db) {
        return db.collection('adminConfig').doc('devKey').set({
          salt: saltB64, hash: hash, iter: ITER,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
    });
  }
  function verify(key, cfg) { return derive(key, cfg.salt, cfg.iter || ITER).then(function (h) { return h === cfg.hash; }); }

  function unlock() { var u = user(); try { sessionStorage.setItem(FLAG, u ? u.uid : ''); } catch (_) {} }
  function lock() { try { sessionStorage.removeItem(FLAG); } catch (_) {} }
  function isUnlocked() { var u = user(); try { return !!u && sessionStorage.getItem(FLAG) === u.uid; } catch (_) { return false; } }

  window.DevKey = { isOwner: isOwner, getConfig: getConfig, setKey: setKey, verify: verify, unlock: unlock, lock: lock, isUnlocked: isUnlocked, MIN: 6 };
})();
