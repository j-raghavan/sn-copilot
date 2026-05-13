import {classifyFileKind} from '../src/scope/fileKind';

describe('classifyFileKind', () => {
  it('classifies .note as note', () => {
    expect(classifyFileKind('/sd/notes/foo.note')).toBe('note');
    expect(classifyFileKind('/sd/notes/FOO.NOTE')).toBe('note');
  });

  it('classifies .pdf as doc', () => {
    expect(classifyFileKind('/sd/Documents/book.pdf')).toBe('doc');
    expect(classifyFileKind('/sd/Documents/book.PDF')).toBe('doc');
  });

  it('classifies .epub as doc', () => {
    expect(classifyFileKind('/sd/Documents/book.epub')).toBe('doc');
    expect(classifyFileKind('/sd/Documents/book.EPUB')).toBe('doc');
  });

  it('classifies anything else as unsupported', () => {
    expect(classifyFileKind('/sd/foo.txt')).toBe('unsupported');
    expect(classifyFileKind('/sd/foo')).toBe('unsupported');
    expect(classifyFileKind('')).toBe('unsupported');
  });
});
