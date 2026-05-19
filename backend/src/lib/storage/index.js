/**
 * Barrel re-export for the storage helper.
 *
 *   import storage from '../lib/storage/index.js';
 *   storage.uploadObject({ ... });
 *
 *   // or named:
 *   import { uploadObject, safePath, NotFoundError } from '../lib/storage/index.js';
 */
export {
  uploadObject,
  downloadObject,
  getSignedUrl,
  getPublicUrl,
  deleteObject,
  listObjects,
  safePath,
  StorageError,
  NotFoundError,
  UnauthorizedError,
} from './supabase-storage.js';

export { default } from './supabase-storage.js';
