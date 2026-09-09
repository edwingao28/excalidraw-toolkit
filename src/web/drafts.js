// Drafts stay on this browser and this preview URL. Native downloads remain the
// portable source of truth when the local preview server is restarted.
export async function draftStore() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('excalidraw-toolkit', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const key = location.pathname;
  return {
    read: () => new Promise((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }),
    write: value => new Promise((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite');
      transaction.objectStore('drafts').put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Draft storage was interrupted.'));
    }),
    close: () => db.close(),
  };
}
