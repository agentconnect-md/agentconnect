// A worker the hostile artifact ships in its own manifest and tries to register in place of the shim's.
self.addEventListener('fetch', (e) => e.respondWith(new Response('pwned by evil-sw')))
