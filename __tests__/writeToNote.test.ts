/**
 * Tests for src/pilotchat/writeToNote — writing the PilotChat into the note.
 *
 * Pins:
 *   1. resolveNoteTarget: the open note's path, page and page size; refuses
 *      anything that is not an open .note page.
 *   2. writeToNote: saves the open note first, inserts one new page per
 *      content page right after the target page, writes each page's
 *      elements with one insertElements call, then reloads and shows the
 *      first new page.
 *   3. Strokes: main layer, the page's EMR range, pen fields copied from a
 *      stroke already on the page (or the defaults), EMR points rounded,
 *      one pressure per point.
 *   4. Text: a main-layer text box at the laid-out rect, size and weight.
 *   4a. Bars: each answer bar is one wide light-gray needle stroke.
 *   5. The page template is reused, by its bare name (the device suffix the
 *      note reports is dropped), when it is a system template, else plain
 *      white; a template the host refuses falls back to plain white.
 *   6. Every failure names its step, and every element made is recycled.
 *   7. No content writes nothing.
 *   8. The note is left on the first page written, or the last when asked.
 *   9. A failure after pages were added removes them again, last first, so
 *      no empty page is left in the note.
 */
import {
  DEFAULT_PEN,
  NoteWriteError,
  removeInsertion,
  resolveNoteTarget,
  signaturesOf,
  writeToNote,
  type Insertion,
  type NoteTarget,
  type NoteWriterDeps,
} from '../src/pilotchat/writeToNote';
import type {NotePageContent} from '../src/pilotchat/noteLayout';

const ok = (result: unknown = true) => ({success: true, result});
const fail = (message: string) => ({success: false, error: {code: 1, message}});

const TARGET: NoteTarget = {
  notePath: '/Note/presenting.note',
  page: 3,
  pageSize: {width: 1920, height: 2560},
};

type Made = {
  type: number;
  recycle: jest.Mock;
  stroke?: {points: {setRange: jest.Mock}; pressures: {setRange: jest.Mock}};
  [key: string]: unknown;
};

const makeDeps = () => {
  const made: Made[] = [];
  const deps = {
    getCurrentFilePath: jest.fn(async () => ok(TARGET.notePath)),
    getCurrentPageNum: jest.fn(async () => ok(TARGET.page)),
    getPageSize: jest.fn(async () => ok(TARGET.pageSize)),
    saveCurrentNote: jest.fn(async () => ok()),
    getNotePageTemplate: jest.fn(async () =>
      ok({name: 'style_5mm_engineering_grid_a5x2', md5: '0'}),
    ),
    insertNotePage: jest.fn(
      async (_params: {notePath: string; page: number; template: string}) =>
        ok(),
    ),
    removeNotePage: jest.fn(async (_notePath: string, _page: number) => ok()),
    getElements: jest.fn(async (_page: number, _notePath?: string) =>
      ok([
        {type: 500, textBox: {}},
        {type: 0, thickness: 600, stroke: {penType: 16, penColor: 0}},
      ]),
    ),
    createElement: jest.fn(async (type: number) => {
      const e: Made = {type, recycle: jest.fn(async () => undefined)};
      if (type === 0) {
        e.stroke = {
          points: {setRange: jest.fn(async () => true)},
          pressures: {setRange: jest.fn(async () => true)},
        };
      }
      made.push(e);
      return ok(e);
    }),
    insertElements: jest.fn(
      async (_notePath: string, _page: number, _elements: object[]) => ok(),
    ),
    reloadFile: jest.fn(async () => ok()),
    jumpToPage: jest.fn(async () => ok()),
    // A stand-in mapping: x→x*10+0.4, y→y*10+0.6, so rounding is visible.
    toEmr: jest.fn((p: {x: number; y: number}) => ({
      x: p.x * 10 + 0.4,
      y: p.y * 10 + 0.6,
    })),
    maxX: jest.fn(() => 21632),
    maxY: jest.fn(() => 16224),
  };
  return {deps: deps as unknown as NoteWriterDeps & typeof deps, made};
};

const PAGE_A: NotePageContent = {
  bars: [],
  strokes: [[1, 2, 3, 4]],
  texts: [
    {
      text: 'A qubit…',
      rect: {left: 96, top: 300, right: 1824, bottom: 400},
      fontSize: 44,
      bold: false,
    },
  ],
};
const PAGE_B: NotePageContent = {
  bars: [],
  strokes: [],
  texts: [
    {
      text: 'more',
      rect: {left: 96, top: 128, right: 1824, bottom: 200},
      fontSize: 44,
      bold: false,
    },
  ],
};

describe('resolveNoteTarget', () => {
  it('returns the open note, page and page size', async () => {
    const {deps} = makeDeps();
    await expect(resolveNoteTarget(deps)).resolves.toEqual(TARGET);
    expect(deps.getPageSize).toHaveBeenCalledWith(TARGET.notePath, TARGET.page);
  });

  it.each([
    ['a document', {getCurrentFilePath: async () => ok('/Document/book.pdf')}],
    ['no path', {getCurrentFilePath: async () => ok(null)}],
    ['no page', {getCurrentPageNum: async () => ({success: true})}],
  ])('refuses %s', async (_l, over) => {
    const {deps} = makeDeps();
    await expect(resolveNoteTarget({...deps, ...over})).rejects.toThrow(
      'No open note to write into',
    );
  });

  it('names getPageSize when the size cannot be read', async () => {
    const {deps} = makeDeps();
    deps.getPageSize.mockResolvedValueOnce(fail('nope') as never);
    await expect(resolveNoteTarget(deps)).rejects.toThrow(
      'getPageSize failed: nope',
    );
  });

  it('refuses a size that is not one', async () => {
    const {deps} = makeDeps();
    deps.getPageSize.mockResolvedValueOnce(ok({width: '1920'}) as never);
    await expect(resolveNoteTarget(deps)).rejects.toBeInstanceOf(
      NoteWriteError,
    );
  });
});

describe('writeToNote', () => {
  it('writes nothing for no content', async () => {
    const {deps} = makeDeps();
    await expect(writeToNote([], TARGET, deps)).resolves.toBe(0);
    expect(deps.saveCurrentNote).not.toHaveBeenCalled();
    expect(deps.insertNotePage).not.toHaveBeenCalled();
  });

  it('saves, adds pages after the target, writes each, then reloads and shows the first', async () => {
    const {deps} = makeDeps();
    await expect(writeToNote([PAGE_A, PAGE_B], TARGET, deps)).resolves.toBe(2);

    expect(deps.insertNotePage.mock.calls).toEqual([
      [
        {
          notePath: TARGET.notePath,
          page: 4,
          template: 'style_5mm_engineering_grid',
        },
      ],
      [
        {
          notePath: TARGET.notePath,
          page: 5,
          template: 'style_5mm_engineering_grid',
        },
      ],
    ]);
    expect(deps.insertElements).toHaveBeenCalledTimes(2);
    expect(deps.insertElements.mock.calls[0][1]).toBe(4);
    expect(deps.insertElements.mock.calls[1][1]).toBe(5);
    expect(deps.jumpToPage).toHaveBeenCalledWith(4);

    const order = (m: jest.Mock) => m.mock.invocationCallOrder[0];
    expect(order(deps.saveCurrentNote)).toBeLessThan(
      order(deps.insertNotePage),
    );
    expect(order(deps.insertElements)).toBeLessThan(order(deps.reloadFile));
    expect(order(deps.reloadFile)).toBeLessThan(order(deps.jumpToPage));
  });

  it('can leave the note on the last page written', async () => {
    const {deps} = makeDeps();
    await writeToNote([PAGE_A, PAGE_B], TARGET, deps, 'last');
    expect(deps.jumpToPage).toHaveBeenCalledWith(5);
  });

  it('builds strokes on the main layer with the page range and the page pen', async () => {
    const {deps, made} = makeDeps();
    await writeToNote([PAGE_A], TARGET, deps);
    const stroke = made.find(e => e.type === 0)!;
    expect(stroke).toMatchObject({
      pageNum: 4,
      layerNum: 0,
      maxX: 21632,
      maxY: 16224,
      thickness: 600,
      stroke: {penType: 16, penColor: 0},
    });
    expect(deps.toEmr).toHaveBeenCalledWith({x: 1, y: 2}, TARGET.pageSize);
    expect(stroke.stroke!.points.setRange).toHaveBeenCalledWith(0, 2, [
      {x: 10, y: 21},
      {x: 30, y: 41},
    ]);
    expect(stroke.stroke!.pressures.setRange).toHaveBeenCalledWith(
      0,
      2,
      [2800, 2800],
    );
  });

  it('builds a main-layer text box at the laid-out rect and size', async () => {
    const {deps, made} = makeDeps();
    await writeToNote([PAGE_A], TARGET, deps);
    const text = made.find(e => e.type === 500)!;
    expect(text).toMatchObject({
      pageNum: 4,
      layerNum: 0,
      textBox: {
        textContentFull: 'A qubit…',
        textRect: PAGE_A.texts[0].rect,
        fontSize: 44,
        textAlign: 0,
        textFrameWidthType: 0,
        textFrameStyle: 0,
        textEditable: 0,
      },
    });
  });

  it.each([
    ['no stroke on the page', ok([{type: 500}])],
    [
      'a stroke without thickness',
      ok([{type: 0, stroke: {penType: 1, penColor: 0}}]),
    ],
    ['unreadable elements', fail('nope')],
  ])('uses the default pen for %s', async (_l, elements) => {
    const {deps, made} = makeDeps();
    deps.getElements.mockResolvedValueOnce(elements as never);
    await writeToNote([PAGE_A], TARGET, deps);
    expect(made.find(e => e.type === 0)).toMatchObject({
      thickness: DEFAULT_PEN.thickness,
      stroke: {penType: DEFAULT_PEN.penType, penColor: DEFAULT_PEN.penColor},
    });
  });

  it('uses the default pen when reading the page throws', async () => {
    const {deps, made} = makeDeps();
    deps.getElements.mockRejectedValueOnce(new Error('boom') as never);
    await writeToNote([PAGE_A], TARGET, deps);
    expect(made.find(e => e.type === 0)).toMatchObject({
      thickness: DEFAULT_PEN.thickness,
    });
  });

  it.each([
    ['a custom template', ok({name: 'my_grid', md5: 'abc'})],
    ['no template', fail('nope')],
    ['a nameless one', ok({md5: '0'})],
  ])('uses the blank template for %s', async (_l, info) => {
    const {deps} = makeDeps();
    deps.getNotePageTemplate.mockResolvedValueOnce(info as never);
    await writeToNote([PAGE_B], TARGET, deps);
    expect(deps.insertNotePage).toHaveBeenCalledWith(
      expect.objectContaining({template: 'style_white'}),
    );
  });

  it('drops the a5x device suffix as well', async () => {
    const {deps} = makeDeps();
    deps.getNotePageTemplate.mockResolvedValueOnce(
      ok({name: 'style_10mm_ruled_line_a5x', md5: '0'}) as never,
    );
    await writeToNote([PAGE_B], TARGET, deps);
    expect(deps.insertNotePage).toHaveBeenCalledWith(
      expect.objectContaining({template: 'style_10mm_ruled_line'}),
    );
  });

  it('uses the blank template when reading it throws', async () => {
    const {deps} = makeDeps();
    deps.getNotePageTemplate.mockRejectedValueOnce(new Error('boom') as never);
    await writeToNote([PAGE_B], TARGET, deps);
    expect(deps.insertNotePage).toHaveBeenCalledWith(
      expect.objectContaining({template: 'style_white'}),
    );
  });

  it('falls back to the blank template when the host refuses the page template', async () => {
    const {deps} = makeDeps();
    deps.insertNotePage.mockResolvedValueOnce(fail('bad template') as never);
    await writeToNote([PAGE_B], TARGET, deps);
    expect(deps.insertNotePage.mock.calls.map(c => c[0].template)).toEqual([
      'style_5mm_engineering_grid',
      'style_white',
    ]);
    expect(deps.insertElements).toHaveBeenCalled();
  });

  it.each([
    ['saveCurrentNote', 'saveCurrentNote'],
    ['insertNotePage', 'insertNotePage'],
    ['createElement', 'createElement'],
    ['insertElements', 'insertElements'],
  ] as const)(
    'names %s when it fails, and writes nothing after it',
    async (_l, step) => {
      const {deps} = makeDeps();
      deps[step].mockResolvedValue(fail('refused') as never);
      const run = writeToNote([PAGE_A], TARGET, deps);
      await expect(run).rejects.toBeInstanceOf(NoteWriteError);
      await expect(writeToNote([PAGE_A], TARGET, deps)).rejects.toThrow(
        `${step} failed: refused`,
      );
      // The note is never moved to a page, and any page added is taken away again.
      expect(deps.jumpToPage).not.toHaveBeenCalled();
      // Two runs; a page is added before createElement and insertElements run.
      const pageWasAdded =
        step === 'createElement' || step === 'insertElements';
      expect(deps.removeNotePage).toHaveBeenCalledTimes(pageWasAdded ? 2 : 0);
    },
  );

  it('reports a failure without a message', async () => {
    const {deps} = makeDeps();
    deps.saveCurrentNote.mockResolvedValueOnce({success: false} as never);
    await expect(writeToNote([PAGE_A], TARGET, deps)).rejects.toThrow(
      /^saveCurrentNote failed$/,
    );
  });

  it('recycles every element, after a write and when building stops part way', async () => {
    const {deps, made} = makeDeps();
    await writeToNote([PAGE_A], TARGET, deps);
    expect(made).toHaveLength(2);
    made.forEach(e => expect(e.recycle).toHaveBeenCalledTimes(1));

    const second = makeDeps();
    second.deps.createElement
      .mockImplementationOnce(async (type: number) => {
        const e: Made = {
          type,
          recycle: jest.fn(async () => {
            throw new Error('recycle boom');
          }),
          stroke: {
            points: {setRange: jest.fn(async () => true)},
            pressures: {setRange: jest.fn(async () => true)},
          },
        };
        second.made.push(e);
        return ok(e);
      })
      .mockResolvedValueOnce(fail('no text') as never);
    await expect(writeToNote([PAGE_A], TARGET, second.deps)).rejects.toThrow(
      'createElement failed',
    );
    expect(second.made).toHaveLength(1);
    expect(second.made[0].recycle).toHaveBeenCalledTimes(1);
  });

  it('removes the pages it added when a later step fails, last first', async () => {
    const {deps} = makeDeps();
    // The first page writes; the second fails after being added.
    deps.insertElements
      .mockResolvedValueOnce(ok() as never)
      .mockResolvedValueOnce(fail('textRect.top must be an integer') as never);
    await expect(writeToNote([PAGE_A, PAGE_B], TARGET, deps)).rejects.toThrow(
      'insertElements failed',
    );
    expect(deps.removeNotePage.mock.calls).toEqual([
      [TARGET.notePath, 5],
      [TARGET.notePath, 4],
    ]);
    expect(deps.reloadFile).toHaveBeenCalledTimes(1);
    expect(deps.jumpToPage).not.toHaveBeenCalled();
  });

  it('removes nothing when no page was added', async () => {
    const {deps} = makeDeps();
    deps.insertNotePage.mockResolvedValue(fail('no template') as never);
    await expect(writeToNote([PAGE_A], TARGET, deps)).rejects.toThrow(
      'insertNotePage failed',
    );
    expect(deps.removeNotePage).not.toHaveBeenCalled();
    expect(deps.reloadFile).not.toHaveBeenCalled();
  });

  it('still reports the original failure when removing a page fails', async () => {
    const {deps} = makeDeps();
    deps.insertElements.mockResolvedValueOnce(fail('bad rect') as never);
    deps.removeNotePage.mockRejectedValueOnce(
      new Error('remove boom') as never,
    );
    await expect(writeToNote([PAGE_A], TARGET, deps)).rejects.toThrow(
      'insertElements failed: bad rect',
    );
  });

  it('draws each answer bar as one wide light-gray stroke', async () => {
    const {deps, made} = makeDeps();
    const page: NotePageContent = {
      bars: [[250, 300, 250, 900]],
      strokes: [[1, 2, 3, 4]],
      texts: [
        {
          text: 'A',
          rect: {left: 1, top: 2, right: 3, bottom: 4},
          fontSize: 52,
          bold: true,
        },
      ],
    };
    await writeToNote([page], TARGET, deps);
    expect(made.map(e => e.type)).toEqual([0, 0, 500]);
    expect(made[0]).toMatchObject({
      thickness: 2500,
      stroke: {penType: 10, penColor: 0xc9},
    });
    expect(made[1]).toMatchObject({
      thickness: 600,
      stroke: {penType: 16, penColor: 0},
    });
    expect(made[2]).toMatchObject({
      textBox: {textContentFull: 'A', fontSize: 52, textBold: 1},
    });
  });
});

describe('signaturesOf', () => {
  it('records each page as its texts and how many strokes it has', () => {
    const page: NotePageContent = {...PAGE_A, bars: [[1, 2, 1, 9]]};
    expect(signaturesOf([page, PAGE_B])).toEqual([
      {texts: ['A qubit…'], strokes: 2},
      {texts: ['more'], strokes: 0},
    ]);
  });
});

describe('removeInsertion', () => {
  const INSERTION: Insertion = {
    notePath: TARGET.notePath,
    firstPage: 3,
    pages: [
      {texts: ['PilotChat · Oct 3, 2026', 'Q'], strokes: 2},
      {texts: ['more'], strokes: 0},
    ],
  };
  // The pages as written: texts in any order, one bar and one handwriting stroke.
  const asWritten = (page: number) =>
    ok(
      page === 3
        ? [
            {type: 500, textBox: {textContentFull: 'Q'}},
            {type: 0},
            {type: 500, textBox: {textContentFull: 'PilotChat · Oct 3, 2026'}},
            {type: 0},
          ]
        : [{type: 500, textBox: {textContentFull: 'more'}}],
    );

  it('removes pages still exactly as written, last first, then reloads the note', async () => {
    const {deps} = makeDeps();
    deps.getElements.mockImplementation(async (page: number) =>
      asWritten(page),
    );
    await expect(removeInsertion(INSERTION, deps)).resolves.toEqual({
      removed: true,
    });
    expect(deps.saveCurrentNote).toHaveBeenCalledTimes(1);
    expect(deps.getElements.mock.calls.map(c => c[0])).toEqual([3, 4]);
    expect(deps.removeNotePage.mock.calls).toEqual([
      [TARGET.notePath, 4],
      [TARGET.notePath, 3],
    ]);
    expect(deps.reloadFile.mock.invocationCallOrder[0]).toBeGreaterThan(
      deps.removeNotePage.mock.invocationCallOrder[1],
    );
  });

  it.each([
    ['the user wrote on it', [{type: 0}], 'page 3 has 3 strokes, 2 written'],
    ['the user erased a stroke', null, 'page 3 has 1 strokes, 2 written'],
    ['a text was edited', 'edited', 'page 3 texts differ (2, 2 written)'],
    [
      'it holds something else',
      [{type: 700}],
      'page 3 holds an element of type 700',
    ],
  ])('keeps them all when %s', async (_name, change, why) => {
    const {deps} = makeDeps();
    deps.getElements.mockImplementation(async (page: number) => {
      const written = asWritten(page).result as Array<Record<string, unknown>>;
      if (page !== 3) {
        return ok(written);
      }
      if (change === null) {
        return ok(written.slice(0, 3));
      }
      if (change === 'edited') {
        return ok([
          {type: 500, textBox: {textContentFull: 'Q!'}},
          ...written.slice(1),
        ]);
      }
      return ok([...written, ...(change as object[])]);
    });
    await expect(removeInsertion(INSERTION, deps)).resolves.toEqual({
      removed: false,
      why,
    });
    expect(deps.removeNotePage).not.toHaveBeenCalled();
    expect(deps.reloadFile).not.toHaveBeenCalled();
  });

  it('keeps them when a page cannot be read or is gone', async () => {
    const {deps} = makeDeps();
    deps.getElements.mockImplementation(async (page: number) =>
      page === 3 ? asWritten(3) : (fail('no page') as never),
    );
    await expect(removeInsertion(INSERTION, deps)).resolves.toEqual({
      removed: false,
      why: 'page 4 unreadable',
    });
    deps.getElements.mockRejectedValue(new Error('gone'));
    await expect(removeInsertion(INSERTION, deps)).resolves.toEqual({
      removed: false,
      why: 'page 3 unreadable: Error: gone',
    });
    expect(deps.removeNotePage).not.toHaveBeenCalled();
  });

  it('counts a text box without content as empty text', async () => {
    const {deps} = makeDeps();
    deps.getElements.mockResolvedValue(ok([{type: 500, textBox: {}}]));
    const blank: Insertion = {...INSERTION, pages: [{texts: [''], strokes: 0}]};
    await expect(removeInsertion(blank, deps)).resolves.toEqual({
      removed: true,
    });
  });

  it('removes nothing for an insertion with no pages', async () => {
    const {deps} = makeDeps();
    await expect(
      removeInsertion({...INSERTION, pages: []}, deps),
    ).resolves.toEqual({removed: false, why: 'nothing inserted'});
    expect(deps.saveCurrentNote).not.toHaveBeenCalled();
  });

  it('fails when a page cannot be removed', async () => {
    const {deps} = makeDeps();
    deps.getElements.mockImplementation(async (page: number) =>
      asWritten(page),
    );
    deps.removeNotePage.mockResolvedValue(fail('locked') as never);
    await expect(removeInsertion(INSERTION, deps)).rejects.toThrow(
      new NoteWriteError('removeNotePage failed: locked'),
    );
  });

  it('re-reads the note when a page could not be removed after another was', async () => {
    const {deps} = makeDeps();
    deps.getElements.mockImplementation(async (page: number) =>
      asWritten(page),
    );
    deps.removeNotePage
      .mockResolvedValueOnce(ok() as never)
      .mockResolvedValueOnce(fail('locked') as never);
    await expect(removeInsertion(INSERTION, deps)).rejects.toThrow(
      NoteWriteError,
    );
    expect(deps.reloadFile).toHaveBeenCalledTimes(1);
  });

  it('does not re-read the note when no page went', async () => {
    const {deps} = makeDeps();
    deps.getElements.mockImplementation(async (page: number) =>
      asWritten(page),
    );
    deps.removeNotePage.mockResolvedValue(fail('locked') as never);
    await expect(removeInsertion(INSERTION, deps)).rejects.toThrow(
      NoteWriteError,
    );
    expect(deps.reloadFile).not.toHaveBeenCalled();
  });
});

describe('writeToNote — showing the pages', () => {
  it('counts the pages written even when the note cannot show them', async () => {
    const {deps} = makeDeps();
    deps.jumpToPage.mockRejectedValue(new Error('busy'));
    await expect(writeToNote([PAGE_A], TARGET, deps)).resolves.toBe(1);
  });
});
