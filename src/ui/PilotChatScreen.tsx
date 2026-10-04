/**
 * The PilotChat: a full-screen page the user writes on with the pen, which
 * writes answers back under their writing. Shown as the plugin's own
 * full-screen view from the PilotChat sidebar button on a note (index.js),
 * the way sn-canvas shows its canvas, so the native page can claim the
 * firmware pen.
 *
 * The native page (PilotChatPageView) owns the ink and the layout; this
 * screen sends each written question, as an image of the handwriting, to
 * the provider and hands the answer back to the page. The device's own
 * handwriting recognition is deliberately not used (see askPilotChat): it
 * would save the user's PilotChat ink into their note. The key comes from
 * the same store as the Copilot panel.
 *
 * Nothing reaches the note unless the user asks: on Close, or New to start
 * a fresh page, a page with writing on it offers to insert the
 * conversation into the note (the user's handwriting as strokes, the
 * answers as text boxes, on new pages after the current one), discard it,
 * or keep writing.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import type {NativeSyntheticEvent} from 'react-native';
import {
  PluginCommAPI,
  PluginFileAPI,
  PluginManager,
  PluginNoteAPI,
  PointUtils,
} from 'sn-plugin-lib';
import {
  appendAnswer,
  appendNote,
  askNow,
  clearPage,
  PilotChatPageNativeView,
  scrollPage,
  exportForNote,
  type PilotChatPageRef,
  type ExportPayload,
  type NotePen,
  type QuestionPayload,
} from '../native/PilotChatPageView';
import {askPilotChat} from '../pilotchat/askPilotChat';
import {
  headerDate,
  layoutForNote,
  noteTextStyle,
} from '../pilotchat/noteLayout';
import {
  NoteWriteError,
  removeInsertion,
  resolveNoteTarget,
  signaturesOf,
  writeToNote,
  type Insertion,
  type NoteTarget,
  type NoteWriterDeps,
} from '../pilotchat/writeToNote';
import {infoLog} from '../diagnostics/log';
import type {ProviderTurn} from '../providers/ProviderClient';
import {REPLY_TIMEOUT_MS} from '../providers/replyBudget';
import {activeKeyFromState} from '../storage/activeProvider';
import {NEEDS_KEY, unavailableReason} from '../pilotchat/readiness';
import {BUTTON_ID_PILOTCHAT, subscribeToButtonEvents} from '../pluginRouter';
import {useCopilotState} from '../storage/useCopilotState';
import {buildWiringBundle, type WiringBundle} from '../storage/wiring';
import {sanitizeProviderError} from './sanitizeProviderError';
import {useProviderClient} from './useProviderClient';
import {controls, InsertPrompt} from './PilotChatInsertPrompt';

const TAG = '[PILOTCHAT]';

export const FAILED_REPLY = 'Something went wrong. Try writing that again.';
export const STILL_ANSWERING_REPLY =
  'Still answering your last question. Write this one again once that answer is in.';

const IDLE_STATUS = 'Write a question, then rest the pen';

// A question's place in the history when the model did not say what it read.
const HANDWRITTEN_QUESTION = '(a question written by hand)';

// What the page says when a question fails, by the step it failed at:
// only a failure while asking came from the provider.
const failureNote = (err: unknown, asking: boolean): string =>
  asking ? `(${sanitizeProviderError(err)})` : FAILED_REPLY;

// The SDK calls writeToNote makes, bound once.
const NOTE_WRITER: NoteWriterDeps = {
  getCurrentFilePath: () => PluginCommAPI.getCurrentFilePath(),
  getCurrentPageNum: () => PluginCommAPI.getCurrentPageNum(),
  getPageSize: (notePath, page) => PluginFileAPI.getPageSize(notePath, page),
  saveCurrentNote: () => PluginNoteAPI.saveCurrentNote(),
  getNotePageTemplate: (notePath, page) =>
    PluginFileAPI.getNotePageTemplate(notePath, page),
  insertNotePage: params => PluginFileAPI.insertNotePage(params),
  removeNotePage: (notePath, page) =>
    PluginFileAPI.removeNotePage(notePath, page),
  getElements: (page, notePath) => PluginFileAPI.getElements(page, notePath),
  createElement: type => PluginCommAPI.createElement(type),
  insertElements: (notePath, page, elements) =>
    PluginFileAPI.insertElements(notePath, page, elements),
  reloadFile: () => PluginCommAPI.reloadFile(),
  jumpToPage: page => PluginCommAPI.jumpToPage(page),
  toEmr: (point, pageSize) => PointUtils.androidPoint2Emr(point, pageSize),
  maxX: pageSize => PointUtils.getRealMaxX(pageSize),
  maxY: pageSize => PointUtils.getRealMaxY(pageSize),
};

const closeView = (): void => {
  PluginManager.closePluginView().catch(() => undefined);
};

const isNotePen = (pen: unknown): pen is NotePen =>
  pen !== null &&
  typeof pen === 'object' &&
  typeof (pen as NotePen).type === 'number' &&
  typeof (pen as NotePen).width === 'number' &&
  typeof (pen as NotePen).color === 'number';

export default function PilotChatScreen(): React.JSX.Element {
  const [bundle, setBundle] = useState<WiringBundle | null>(null);
  useEffect(() => {
    let cancelled = false;
    buildWiringBundle()
      .then(b => {
        if (!cancelled) {
          setBundle(b);
        }
      })
      .catch(e => infoLog(`${TAG} wiring failed: ${String(e)}`));
    return () => {
      cancelled = true;
    };
  }, []);
  return bundle === null ? (
    <PilotChatChrome status="Opening…" />
  ) : (
    <PilotChatPage bundle={bundle} />
  );
}

type ChromeProps = {
  status: string;
  onScroll?: (direction: 1 | -1) => void;
  onAsk?: () => void;
  onNew?: () => void;
  onClose?: () => void;
  children?: React.ReactNode;
};

function PilotChatChrome({
  status,
  onScroll,
  onAsk,
  onNew,
  onClose = closeView,
  children,
}: ChromeProps): React.JSX.Element {
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>✦ PilotChat</Text>
        <Text style={styles.status} numberOfLines={1} testID="pilotchat-status">
          {status}
        </Text>
        {onScroll !== undefined && (
          <>
            <Pressable
              onPress={() => onScroll(-1)}
              style={controls.button}
              testID="pilotchat-up">
              <Text style={controls.buttonText}>▲</Text>
            </Pressable>
            <Pressable
              onPress={() => onScroll(1)}
              style={controls.button}
              testID="pilotchat-down">
              <Text style={controls.buttonText}>▼</Text>
            </Pressable>
          </>
        )}
        {onAsk !== undefined && (
          <Pressable
            onPress={onAsk}
            style={controls.button}
            testID="pilotchat-ask">
            <Text style={controls.buttonText}>Ask</Text>
          </Pressable>
        )}
        {onNew !== undefined && (
          <Pressable
            onPress={onNew}
            style={controls.button}
            testID="pilotchat-new">
            <Text style={controls.buttonText}>New</Text>
          </Pressable>
        )}
        <Pressable
          onPress={onClose}
          style={controls.button}
          testID="pilotchat-close">
          <Text style={controls.buttonText}>Close</Text>
        </Pressable>
      </View>
      {children}
    </View>
  );
}

function PilotChatPage({bundle}: {bundle: WiringBundle}): React.JSX.Element {
  const stateDeps = useMemo(
    () => ({
      prefsDeps: bundle.prefsDeps,
      vaultDeps: bundle.vaultDeps,
      discoveryDeps: bundle.discoveryDeps,
      logger: bundle.vaultDeps.logger,
    }),
    [bundle],
  );
  const {state, refresh} = useCopilotState(stateDeps);
  const keyFile = activeKeyFromState(state);
  // The view stays alive between openings, so each opening looks at the
  // keys again: one set up or unlocked in Copilot meanwhile counts.
  useEffect(
    () =>
      subscribeToButtonEvents(e => {
        if (e.id === BUTTON_ID_PILOTCHAT) {
          refresh().catch(() => undefined);
        }
      }),
    [refresh],
  );
  const {client, apiKey, model} = useProviderClient(keyFile);

  const pageRef = useRef<PilotChatPageRef | null>(null);
  const history = useRef<ProviderTurn[]>([]);
  // The question being answered, if any; New aborts it, and an answer that
  // arrives for a request no longer here is dropped.
  const inFlight = useRef<AbortController | null>(null);
  const [status, setStatus] = useState(IDLE_STATUS);
  const [notePen, setNotePen] = useState<NotePen | null>(null);

  // The note's own pen, set back as the page gives the firmware pen back.
  useEffect(() => {
    PluginCommAPI.getPenInfo()
      .then(r => {
        const pen = (r as {result?: unknown} | null)?.result;
        if (isNotePen(pen)) {
          setNotePen({type: pen.type, width: pen.width, color: pen.color});
        }
      })
      .catch(() => undefined);
  }, []);

  // Shown on the page and never put in the note: the PilotChat's own words.
  const note = useCallback((text: string) => {
    appendNote(pageRef.current, text);
  }, []);

  // The user has written on the page this session, so Close offers to keep it.
  const wrote = useRef(false);
  const [prompt, setPrompt] = useState<'none' | 'confirm' | 'inserting'>(
    'none',
  );
  // What the prompt leads to once the user has chosen: leaving, or a new page.
  const [then, setThen] = useState<'close' | 'new'>('close');
  const target = useRef<NoteTarget | null>(null);
  // Where this conversation was last inserted, so inserting it again
  // replaces that copy rather than adding a second one.
  const inserted = useRef<Insertion | null>(null);

  const onQuestion = useCallback(
    async (event: NativeSyntheticEvent<QuestionPayload>) => {
      // Read before the first await: React Native recycles the event once
      // this handler yields, and nativeEvent is null after that.
      const {strokes, image} = event.nativeEvent;
      wrote.current = true;
      if (inFlight.current !== null) {
        // The page waits for a reply to each question; this one gets one.
        note(STILL_ANSWERING_REPLY);
        return;
      }
      let asking = false;
      const ctl = new AbortController();
      inFlight.current = ctl;
      const current = () => inFlight.current === ctl;
      const timeout = setTimeout(() => ctl.abort(), REPLY_TIMEOUT_MS);
      try {
        infoLog(
          `${TAG} question strokes=${strokes.length} ` +
            `imageAttached=${image !== undefined} ` +
            `history.turns=${history.current.length}`,
        );
        // The keys changed since the page opened (locked, or taken away):
        // the same words as when PilotChat cannot open.
        const unavailable = unavailableReason(state, keyFile);
        if (unavailable !== null || keyFile === undefined) {
          note(unavailable ?? NEEDS_KEY);
          setStatus(IDLE_STATUS);
          return;
        }
        if (image === undefined) {
          note(FAILED_REPLY);
          setStatus(IDLE_STATUS);
          return;
        }
        setStatus('Reading your writing…');
        asking = true;
        const {question, answer} = await askPilotChat({
          client,
          apiKey,
          model,
          imageBase64: image,
          history: history.current,
          signal: ctl.signal,
        });
        if (!current()) {
          return;
        }
        setStatus(question.length > 0 ? `Read: ${question}` : IDLE_STATUS);
        // History is text only, as in chat: an image is never resent.
        history.current = [
          ...history.current,
          {
            role: 'user',
            text: question.length > 0 ? question : HANDWRITTEN_QUESTION,
          },
          {role: 'assistant', text: answer},
        ];
        appendAnswer(pageRef.current, answer);
        infoLog(`${TAG} answer text.length=${answer.length}`);
      } catch (err) {
        if (!current()) {
          return;
        }
        console.log(`${TAG} question failed`, String(err));
        // Shown on the page, never replayed to the model as something it said.
        note(failureNote(err, asking));
        setStatus(IDLE_STATUS);
      } finally {
        clearTimeout(timeout);
        if (current()) {
          inFlight.current = null;
        }
      }
    },
    [apiKey, client, keyFile, model, note, state],
  );

  const onAsk = useCallback(() => askNow(pageRef.current), []);
  // The page scrolls only by these buttons: touch on it never moves it.
  const onScroll = useCallback(
    (direction: 1 | -1) => scrollPage(pageRef.current, direction),
    [],
  );

  // A new, empty page and conversation: the model no longer sees the old one.
  const startFresh = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    clearPage(pageRef.current);
    history.current = [];
    wrote.current = false;
    inserted.current = null;
    setPrompt('none');
    setStatus(IDLE_STATUS);
  }, []);

  // Close or New: straight through on a page with nothing written, else ask first.
  const leave = useCallback(
    (to: 'close' | 'new') => {
      if (wrote.current) {
        setThen(to);
        setPrompt('confirm');
      } else if (to === 'close') {
        closeView();
      } else {
        startFresh();
      }
    },
    [startFresh],
  );
  const onClose = useCallback(() => leave('close'), [leave]);
  const onNew = useCallback(() => leave('new'), [leave]);

  // Leaving without inserting keeps the conversation: reopened, the
  // PilotChat carries on from it.
  const onDiscard = useCallback(() => {
    if (then === 'close') {
      setPrompt('none');
      closeView();
    } else {
      startFresh();
    }
  }, [startFresh, then]);

  const insertFailed = useCallback((err: unknown) => {
    console.log(`${TAG} insert failed`, String(err));
    target.current = null;
    setPrompt('none');
    setStatus(
      err instanceof NoteWriteError
        ? `Couldn't write into the note: ${err.message}`
        : "Couldn't write into the note.",
    );
  }, []);

  // Insert: find the note page, then ask the page for its content measured
  // for that note; writing continues in onExport.
  const onInsert = useCallback(async () => {
    setPrompt('inserting');
    setStatus('Writing into your note…');
    try {
      const t = await resolveNoteTarget(NOTE_WRITER);
      target.current = t;
      const style = noteTextStyle(t.pageSize);
      exportForNote(
        pageRef.current,
        style.fontSize,
        style.textWidth,
        style.maxHeight,
      );
    } catch (err) {
      insertFailed(err);
    }
  }, [insertFailed]);

  const onExport = useCallback(
    async (event: NativeSyntheticEvent<ExportPayload>) => {
      // Held before the first await, as in onQuestion.
      const payload = event.nativeEvent;
      const t = target.current;
      if (t === null) {
        return;
      }
      try {
        // An earlier copy of this conversation is taken out first, and the
        // new one goes where it was; one the user has changed stays.
        let at = t;
        const earlier = inserted.current;
        if (earlier !== null && earlier.notePath === t.notePath) {
          inserted.current = null;
          const removal = await removeInsertion(earlier, NOTE_WRITER);
          infoLog(
            `${TAG} earlier insert ` +
              (removal.removed ? 'replaced' : `kept: ${removal.why}`),
          );
          if (removal.removed) {
            at = {...t, page: earlier.firstPage - 1};
          }
        }
        const pages = layoutForNote(
          payload,
          t.pageSize,
          headerDate(new Date()),
        );
        // Starting afresh, the note is left on the last page written, so
        // the next Insert follows it rather than landing in its middle.
        const written = await writeToNote(
          pages,
          at,
          NOTE_WRITER,
          then === 'close' ? 'first' : 'last',
        );
        infoLog(
          `${TAG} inserted pages=${written} items=${payload.items.length}`,
        );
        target.current = null;
        if (then === 'close') {
          // The page and the conversation stay, so the PilotChat reopens
          // where it was and the next Insert replaces this copy.
          inserted.current = {
            notePath: at.notePath,
            firstPage: at.page + 1,
            pages: signaturesOf(pages),
          };
          wrote.current = false;
          setPrompt('none');
          setStatus('Inserted into your note.');
          closeView();
        } else {
          startFresh();
        }
      } catch (err) {
        insertFailed(err);
      }
    },
    [insertFailed, startFresh, then],
  );

  // Not until the keys are known, and not at all without one it can use:
  // the page, which takes the pen, is only shown when PilotChat can answer.
  // A conversation already on the page stays; asking then says what is wrong.
  if (state === null) {
    return <PilotChatChrome status="Opening…" />;
  }
  const unavailable = unavailableReason(state, keyFile);
  if (unavailable !== null && !wrote.current && history.current.length === 0) {
    return (
      <PilotChatChrome status="">
        <View style={styles.unavailable}>
          <Text style={styles.unavailableText} testID="pilotchat-unavailable">
            {unavailable}
          </Text>
        </View>
      </PilotChatChrome>
    );
  }

  return (
    <PilotChatChrome
      status={status}
      onScroll={onScroll}
      onAsk={onAsk}
      onNew={onNew}
      onClose={onClose}>
      <PilotChatPageNativeView
        ref={pageRef}
        style={styles.page}
        notePen={notePen}
        inkEnabled={prompt === 'none'}
        onQuestion={onQuestion}
        onExport={onExport}
        testID="pilotchat-page"
      />
      {prompt !== 'none' && (
        <InsertPrompt
          title={
            then === 'close'
              ? 'Insert this conversation into your note?'
              : 'Start a new page? Insert this one into your note first?'
          }
          replaces={inserted.current !== null}
          leaveLabel={then === 'close' ? 'Not now' : 'Discard'}
          busy={prompt === 'inserting'}
          onInsert={onInsert}
          onDiscard={onDiscard}
          onKeepWriting={() => setPrompt('none')}
        />
      )}
    </PilotChatChrome>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#fff'},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: '#000',
  },
  title: {fontSize: 28, fontWeight: '700', color: '#000', marginRight: 16},
  status: {flex: 1, fontSize: 18, color: '#000'},
  page: {flex: 1},
  unavailable: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 48,
  },
  unavailableText: {
    fontSize: 26,
    color: '#000',
    textAlign: 'center',
    maxWidth: 900,
  },
});
