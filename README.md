# ADRIX 0.2

An EVM wallet browser extension built with React + Vite on Manifest V3. It covers the core
of what MetaMask does day to day: an HD keyring with multiple accounts, token and network
management, gas control, transaction history, and a full EIP-1193 provider that any dApp can
connect to without knowing ADRIX exists.

**Use testnet keys only.** See "What this is not" at the bottom.

## Build and load

```bash
npm install
npm run build
```

Chrome (or Edge/Brave) → `chrome://extensions` → Developer mode on → **Load unpacked** →
select `dist/`. After each rebuild, press reload on the extension card and reload any open
dApp tabs.

To try it end to end:

```bash
npx serve demo
```

Content scripts do not inject into `file://` pages, so the demo has to be served.

## What it does

**Accounts**
- 12-word BIP-39 recovery phrase, BIP-44 derivation at `m/44'/60'/0'/0/N`
- Add accounts, import private keys, rename, remove imported accounts
- Export a private key or reveal the recovery phrase, each behind a password check

**Networks**
- Ethereum, Sepolia, Polygon, Arbitrum, OP Mainnet, Base, BNB Chain, Localhost 8545
- Add and remove custom networks from the UI or via `wallet_addEthereumChain`

**Tokens**
- Add ERC-20s by contract address; symbol, decimals, and name are read on chain
- Per-network token lists with live balances
- Send tokens; `wallet_watchAsset` prompts the user
- Track ERC-721/ERC-1155 NFTs by contract and token ID, including metadata images when available
- Token and NFT approvals are decoded, shown with warnings, and can be revoked from the wallet UI

**Transactions**
- Slow / Market / Fast fee presets from live `getFeeData`, EIP-1559 where supported
- Gas estimated with 20% headroom; failed simulations surface the revert reason
- Activity list with pending/confirmed/failed status and explorer links
- Speed up and cancel by replacing a pending nonce with a 12.5% fee bump
- Contract method names are decoded for common ERC-20/ERC-721/ERC-1155 calls
- Transaction notes and tags can be saved and exported with activity CSVs
- Desktop notification when a transaction settles
- ENS names resolve in the recipient field

**Security**
- Vault encrypted with PBKDF2-SHA256 (600k iterations) + AES-GCM via WebCrypto
- Keys held in `chrome.storage.session`, which is memory-only and cleared when the browser
  closes; nothing decrypted ever touches disk
- Configurable auto-lock, change password, erase wallet
- Per-origin permissions: each site sees only the accounts and networks you ticked for it
- Connected site history records dApp connects, permission changes, switches, signing, and sends

## dApp API

`eth_requestAccounts`, `eth_accounts`, `eth_coinbase`, `eth_chainId`, `net_version`,
`personal_sign`, `eth_signTypedData` / `_v3` / `_v4`, `eth_sendTransaction`,
`wallet_switchEthereumChain`, `wallet_addEthereumChain`, `wallet_watchAsset`,
`wallet_requestPermissions`, `wallet_getPermissions`, `wallet_revokePermissions`.
Anything else is forwarded to the network's RPC endpoint.

Events: `connect`, `disconnect`, `accountsChanged`, `chainChanged`. Discovery via EIP-6963
and legacy `window.ethereum`, so wagmi / RainbowKit / ConnectKit pick it up with no
connector config.

`eth_sign` is deliberately refused - it signs opaque bytes that can be a valid transaction.

## Architecture

```
page (MAIN world)          isolated world        service worker
window.ethereum   ---->    content.js    ---->   rpc.js
  inpage.js               postMessage           chrome.runtime
                                                    |
                                          approvals.js -> approval window
                                          keyring.js   (keys, signing)
                                          transactions.js, tokens.js, networks.js
```

The provider must run in the page's own JS context to define `window.ethereum`, but that
context has no `chrome.*` access - hence the two-script split. Keys exist only in the
service worker; the UI never receives key material except when you explicitly export it.

```
src/background/
  index.js         message router, auto-lock alarm, state snapshots
  keyring.js       HD derivation, imported keys, lock/unlock
  vault.js         PBKDF2 + AES-GCM
  networks.js      chain registry, provider cache
  permissions.js   per-origin account/network grants and dApp history
  rpc.js           the dApp-facing JSON-RPC surface
  approvals.js     approval queue and window lifecycle
  transactions.js  gas, sending, replacement, activity, notes, receipt polling
  tokens.js        ERC-20/NFT reads, approval tracking, calldata decoding
src/popup/         React UI
src/approval/      confirmation window
```

## Two MV3 details worth knowing

**The service worker dies constantly.** Chrome tears it down after ~30 seconds idle, which
would lock the wallet mid-session if keys lived in a module variable. They live in
`chrome.storage.session` instead, which survives worker restarts without persisting to disk.

**An open approval window keeps the worker alive.** The approval page opens a
`chrome.runtime.connect` port. That both prevents the worker dying while a request is
pending, and turns "user closed the window" into a clean 4001 rejection.

## What this is not

Real wallets carry years of adversarial hardening. This does not have:

- **No security audit.** The crypto uses standard primitives correctly as far as I can tell,
  but nobody has attacked it.
- **No phishing or scam detection**, no domain blocklist, no approval-spending warnings.
- **No transaction simulation.** MetaMask shows you the balance changes a transaction will
  cause. This shows you calldata.
- **No hardware wallet, no Snaps, no swaps, no bridge, no fiat on-ramp, no NFTs.**
- **No token price data**, so balances are token counts, not portfolio value.
- **Public RPC endpoints** are hardcoded and rate-limited. Swap in your own for real use.
- **Single derivation path.** No Ledger-style legacy paths, no account discovery on import.
- **No seed-phrase confirmation quiz** during onboarding, so it is easy to skip writing it
  down, and then the wallet is gone.

If you want to take this toward production, the order I would go in: seed-phrase
confirmation on onboarding, a spending-approval warning on `approve` calls with unlimited
amounts, transaction simulation, then a real audit before it touches mainnet value.

## Changelog

**0.2.1** - correctness pass: normalised stored transaction values to decimal wei, guarded
the notifications and `setAccessLevel` calls that return `undefined` on some Chrome builds,
raised receipt polling to the 30s floor Chrome actually honours, made the approval window
advance through a queue instead of closing on the first answer, and moved ERC-20 transfer
encoding into the background so the gas estimate and the broadcast transaction cannot drift.
# ADRIX
