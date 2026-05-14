// Classifies a Supernote-managed file path by extension.
//
// 'note'        — native .note files (handwritten notebooks)
// 'doc'         — .pdf and .epub (the substrate Grill Me targets)
// 'unsupported' — everything else
//
// Lifted out of captureScreenshot.ts so non-capture call sites (the
// UI's "is Grill Me available?" check, future per-doc storage keys)
// can share the single classification source.

export type FileKind = 'note' | 'doc' | 'unsupported';

export const classifyFileKind = (path: string): FileKind => {
  if (/\.note$/i.test(path)) {
    return 'note';
  }
  if (/\.(pdf|epub)$/i.test(path)) {
    return 'doc';
  }
  return 'unsupported';
};
