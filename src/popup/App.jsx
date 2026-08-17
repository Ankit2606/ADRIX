import { useEffect, useState } from 'react';
import { useBackgroundState } from '../lib/ui.js';
import Onboarding from './views/Onboarding.jsx';
import Unlock from './views/Unlock.jsx';
import Home from './views/Home.jsx';
import Send from './views/Send.jsx';
import Receive from './views/Receive.jsx';
import Accounts from './views/Accounts.jsx';
import Networks from './views/Networks.jsx';
import AddToken from './views/AddToken.jsx';
import Settings from './views/Settings.jsx';
import Swap from './views/Swap.jsx';
import Bridge from './views/Bridge.jsx';
import Buy from './views/Buy.jsx';
import BatchSend from './views/BatchSend.jsx';

export default function App() {
  const { state, error, refresh } = useBackgroundState();
  const [view, setView] = useState('home');

  useEffect(() => {
    document.documentElement.dataset.theme = state?.theme ?? 'dark';
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [state?.theme]);

  if (error) {
    return (
      <div className="screen">
        <div className="scroll pad stack">
          <h1>Something went wrong</h1>
          <p>{error}</p>
          <button className="ghost" onClick={refresh}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="screen">
        <div className="scroll pad">
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (!state.hasVault) return <Onboarding onDone={refresh} />;
  if (!state.unlocked) return <Unlock onDone={refresh} />;

  const props = { state, refresh, go: setView };

  switch (view) {
    case 'send':
      return <Send {...props} />;
    case 'batchSend':
      return <BatchSend {...props} />;
    case 'receive':
      return <Receive {...props} />;
    case 'swap':
      return <Swap {...props} />;
    case 'bridge':
      return <Bridge {...props} />;
    case 'buy':
      return <Buy {...props} />;
    case 'accounts':
      return <Accounts {...props} />;
    case 'networks':
      return <Networks {...props} />;
    case 'addToken':
      return <AddToken {...props} />;
    case 'settings':
      return <Settings {...props} />;
    default:
      return <Home {...props} />;
  }
}
