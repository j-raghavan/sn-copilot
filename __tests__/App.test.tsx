/**
 * Tests for App.tsx — the component the host mounts for the plugin's
 * own full-screen view.
 *
 * Pins:
 *   1. Opened by the PilotChat button (id 400) → PilotChatScreen.
 *   2. Opened by anything else, or with no press recorded → CopilotPanel.
 *   3. A button press arriving after mount switches between them.
 */
import React from 'react';
import {Text} from 'react-native';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';
import App from '../App';
import {__testing__, installPluginRouter} from '../src/pluginRouter';

type Press = {onButtonPress: (e: Record<string, unknown>) => void};

jest.mock('sn-plugin-lib', () => ({
  PluginManager: {registerButtonListener: jest.fn()},
}));

// The listener the router registered with the host most recently.
const hostListener = (): Press => {
  const {PluginManager} = jest.requireMock('sn-plugin-lib') as {
    PluginManager: {registerButtonListener: jest.Mock};
  };
  return PluginManager.registerButtonListener.mock.calls.at(-1)[0] as Press;
};

jest.mock('../src/ui/PilotChatScreen', () => {
  const {Text: T} = require('react-native');
  return {__esModule: true, default: () => <T testID="pilotchat">pilotchat</T>};
});

jest.mock('../src/ui/CopilotPanel', () => {
  const {Text: T} = require('react-native');
  return {__esModule: true, default: () => <T testID="panel">panel</T>};
});

const press = (id: number) => ({
  id,
  pressEvent: 3,
  name: '',
  icon: '',
  color: 0,
  bgColor: 0,
});

const shown = (tree: ReactTestRenderer): string[] =>
  tree.root.findAllByType(Text).map(t => t.props.testID as string);

describe('App', () => {
  beforeEach(() => {
    // A fresh router per test: no remembered press, one listener.
    __testing__.reset();
    installPluginRouter();
  });

  const render = async (): Promise<ReactTestRenderer> => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<App />);
    });
    return tree;
  };

  it('shows the Copilot panel when no press has been recorded', async () => {
    expect(shown(await render())).toEqual(['panel']);
  });

  it('shows the PilotChat when the PilotChat button opened the view', async () => {
    hostListener().onButtonPress(press(400));
    expect(shown(await render())).toEqual(['pilotchat']);
  });

  it('shows the Copilot panel for any other button', async () => {
    hostListener().onButtonPress(press(100));
    expect(shown(await render())).toEqual(['panel']);
  });

  it('follows a press that lands after the view mounted', async () => {
    const tree = await render();
    await act(async () => hostListener().onButtonPress(press(400)));
    expect(shown(tree)).toEqual(['pilotchat']);
  });

  it('keeps the PilotChat, and its conversation, through other buttons pressed later', async () => {
    hostListener().onButtonPress(press(400));
    const tree = await render();
    for (const id of [100, 200, 300]) {
      await act(async () => hostListener().onButtonPress(press(id)));
      expect(shown(tree)).toEqual(['pilotchat']);
    }
  });
});
