import React, {useEffect, useState} from 'react';
import CopilotPanel from './src/ui/CopilotPanel';
import PilotChatScreen from './src/ui/PilotChatScreen';
import {
  BUTTON_ID_PILOTCHAT,
  getLastButtonEvent,
  installPluginRouter,
  subscribeToButtonEvents,
} from './src/pluginRouter';

// installPluginRouter is idempotent. We call it from index.js (production
// startup path) AND from here, because some test harnesses render
// App.tsx directly without executing index.js. Calling twice in
// production is harmless.
installPluginRouter();

// App is the registered component for the host's plugin view
// (registered against `appName` in index.js). The Copilot button is
// headless (showType:0) and draws its own overlay, so the plugin view
// opens only for the PilotChat button (showType:1, full screen), and App
// shows the PilotChat. Until the PilotChat has opened, the view shows the
// Copilot panel, as a defensive fallback for a firmware build that ignores
// showType:0. Once open it stays: the view outlives each closing so the
// conversation carries on, and the headless buttons pressed meanwhile
// (Copilot, lasso, document selection) must not replace it.
const isPilotChat = (id: number | undefined): boolean =>
  id === BUTTON_ID_PILOTCHAT;

export default function App(): React.JSX.Element {
  const [pilotChat, setPilotChat] = useState(() =>
    isPilotChat(getLastButtonEvent()?.id),
  );
  // The press that opened the view can land just after the view mounts.
  useEffect(
    () =>
      subscribeToButtonEvents(e => {
        if (isPilotChat(e.id)) {
          setPilotChat(true);
        }
      }),
    [],
  );
  return pilotChat ? <PilotChatScreen /> : <CopilotPanel />;
}
