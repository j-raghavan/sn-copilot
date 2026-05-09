import React from 'react';
import CopilotPanel from './src/ui/CopilotPanel';
import {installPluginRouter} from './src/pluginRouter';

// installPluginRouter is idempotent. We call it from index.js (production
// startup path) AND from here, because some test harnesses render
// App.tsx directly without executing index.js. Calling twice in
// production is harmless.
installPluginRouter();

// App is the registered component for the host's plugin-view
// (registered against `appName` in index.js). With showType:0 the
// host doesn't open its plugin view and App is never mounted — the
// overlay's ReactRootView mounts CopilotPanel directly. App stays as
// a defensive registration for a hypothetical firmware build that
// ignores showType:0; in that fallback case the host gets the same
// panel tree.
export default function App(): React.JSX.Element {
  return <CopilotPanel />;
}
