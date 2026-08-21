import { useEffect, useState } from 'react';
import { useBackgroundState, useTranslation } from '../lib/ui.js';
import { ErrorState } from './components/common.jsx';
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
import Search from './views/Search.jsx';
import SmartAccount from './views/SmartAccount.jsx';

const VIEWS = {
  send: Send,
  batchSend: BatchSend,
  receive: Receive,
  swap: Swap,
  bridge: Bridge,
  buy: Buy,
  accounts: Accounts,
  networks: Networks,
  addToken: AddToken,
  settings: Settings,
  search: Search,
  smartAccount: SmartAccount,
};

export default function App() {
  const { state, error, loading, refresh } = useBackgroundState();
  // A view plus its arguments. Search results have to be able to say "open the
  // home screen *at this transaction*", which a bare view name cannot express.
  const [route, setRoute] = useState({ name: 'home', params: null });

  const go = (name, params = null) =>
    setRoute(typeof name === 'string' ? { name, params } : { name: 'home', params: null });

  // Locale has to be applied before any child renders a translated string.
  useTranslation(state?.locale);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = state?.theme ?? 'dark';
    root.lang = state?.locale ?? 'en';
  }, [state?.theme, state?.locale]);

  // Coming back to a locked wallet should never leave a stale inner screen up.
  useEffect(() => {
    if (state && (!state.hasVault || !state.unlocked)) setRoute({ name: 'home', params: null });
  }, [state?.hasVault, state?.unlocked]);

  if (error) {
    return (
      <div className="screen">
        <div className="scroll pad stack" style={{ justifyContent: 'center' }}>
          <ErrorState message={error} onRetry={refresh} />
        </div>
      </div>
    );
  }

  if (loading || !state) {
    return (
      <div className="screen">
        <div className="scroll pad stack center" style={{ justifyContent: 'center' }} aria-busy="true">
          <span className="spinner" />
          <p className="small faint">Opening ADRIX…</p>
        </div>
      </div>
    );
  }

  if (!state.hasVault) return <Onboarding onDone={refresh} />;
  if (!state.unlocked) return <Unlock onDone={refresh} />;

  const View = VIEWS[route.name] ?? Home;
  return <View state={state} refresh={refresh} go={go} params={route.params} />;
}
