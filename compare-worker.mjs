import { compareFiles } from './compare-core.mjs';

self.onmessage = async ({ data }) => {
  try {
    const result = await compareFiles(data.fileA, data.fileB, {
      expectedHash: data.expectedHash,
      onRead: (read) => self.postMessage({ type: 'read', ...read }),
      onProgress: (progress) => self.postMessage({ type: 'progress', ...progress }),
    });
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({ type: 'error', name: error?.name || 'Error' });
  }
};
