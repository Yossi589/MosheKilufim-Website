const CACHE_NAME = 'moshe-v3';
const urlsToCache = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
  // כופה על הדפדפן להתקין את העדכון החדש מיד בלי לחכות שייסגרו כל החלונות
  self.skipWaiting();
});

// מחיקת גרסאות ישנות של ה-Cache כשיש גרסה חדשה
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME)
                  .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// אסטרטגיית רשת קודם (Network First) עם גיבוי של מטמון
self.addEventListener('fetch', event => {
  // קודם כל מנסים למשוך את הגרסה הכי חדשה מהרשת
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // אם הצלחנו להביא גרסה חדשה מהרשת, נשמור אותה ב-Cache לפעם הבאה
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        // אם אין אינטרנט או שהרשת נפלה - נשתמש בגרסה האחרונה ששמרנו ב-Cache
        return caches.match(event.request);
      })
  );
});