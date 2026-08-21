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
- Safe multisig: reads owners, threshold, and nonce from the chain, signs SafeTx
  payloads as an owner (EIP-712, with the pre/post-1.3.0 domain difference
  handled), shares signatures through the Safe Transaction Service, and executes
  once the threshold is met
- EIP-7702 delegation: points an existing account at contract code, with the
  target inspected first and an unrecognised one treated as hostile; atomic
  batching through the delegated code; revocation by delegating to the zero address
- Air-gapped QR signing in Keystone UR format — bytewords, CRC-32, and a CBOR
  subset implemented from the specification, single-frame only, with multi-part
  animated codes detected and refused rather than misread
- Recovery-phrase splitting via Shamir secret sharing over GF(256), any T of N,
  with a set identifier that stops shares from different splits silently
  combining into a valid-looking phrase for the wrong wallet
- ERC-4337 smart accounts: user operations built for EntryPoint v0.7, priced by
  the bundler, optionally sponsored via an ERC-7677 paymaster, signed by whichever
  owner key the wallet holds, and tracked to inclusion
- Add accounts, import private keys, rename, remove imported accounts
- Export a private key or reveal the recovery phrase, each behind a password check

**Networks**
- Ethereum, Sepolia, Polygon, Arbitrum, OP Mainnet, Base, BNB Chain, Localhost 8545
- Add and remove custom networks from the UI or via `wallet_addEthereumChain`
- Several RPC endpoints per network, tried in order with automatic failover; a
  failing endpoint is backed off with an increasing cooldown instead of retried
- Each endpoint is verified independently before it is saved, and the health
  panel shows which one is currently serving requests

**Earn**
- Direct staking deposits into Lido and Rocket Pool — the protocol's own deposit
  call, so no slippage and no spread, with the rebasing/appreciating distinction
  explained rather than left to surprise you
- Position tracking for any ERC-4626 vault without ADRIX knowing the protocol,
  plus Uniswap V3 liquidity and liquid-staking positions. No APR figures are
  shown: those need an off-chain source this wallet does not have

**Swap and bridge**
- Real routing through the LI.FI aggregator — same-chain swaps and cross-chain
  bridges, no API key, no integrator fee taken by ADRIX
- The aggregator's transaction is checked against the quote it claims to fulfil
  and then simulated locally, so the wallet forms its own view of what the
  calldata does rather than trusting the server that wrote it
- Approvals are for the exact amount being traded, never unlimited
- Slippage stated as what it costs — the worst case in the output token — and
  refused when the route's own price impact already exceeds it
- Cross-chain gas: a slice of a bridged amount can be delivered as the
  destination chain's native coin, so arriving tokens are not stranded
- Minimum-received is given more weight than the headline rate, price impact is
  shown, and slippage above 1% says what it costs you
- Bridges are tracked to arrival on the destination chain, because the source
  transaction confirming is not the same as the money landing

**Tokens**
- Add ERC-20s by contract address; symbol, decimals, and name are read on chain
- Per-network token lists with live balances
- Send tokens; `wallet_watchAsset` prompts the user
- Track ERC-721/ERC-1155 NFTs by contract and token ID, including metadata images when available
- NFT detail view with traits, collection floor price, market stats, and explorer links
- Token and NFT approvals are decoded, shown with warnings, and can be revoked from the wallet UI

**Transactions**
- Slow / Market / Fast fee presets built from the priority fees recent blocks
  actually paid (`eth_feeHistory` percentiles), with inclusion times derived
  from that data and the chain's measured block time
- Base fee sparkline over the last 20 blocks, with a wait-or-send hint when the
  current fee is meaningfully off its own median
- Gas estimated with 20% headroom; failed simulations surface the revert reason
- Activity list with pending/confirmed/failed status and explorer links
- Speed up and cancel by replacing a pending nonce with a 12.5% fee bump
- Nonce gap detection: names the missing nonce, lists what it is blocking, and
  offers a priced zero-value fill to unblock the queue
- Contract method names are decoded for common ERC-20/ERC-721/ERC-1155 calls
- Transaction notes and tags can be saved and exported with activity CSVs
- Desktop notifications for transactions sent and for funds arriving — the latter
  by polling transfer logs on the selected network, with spam filtering
- ENS names resolve in the recipient field

**Security**
- EIP-712 typed data parsed rather than dumped: the type tree is walked, nested
  structs and arrays are rendered, and each field is shown in its own units —
  deadlines as dates ("never expires"), amounts against the token's decimals,
  addresses labelled when the wallet recognises them, opaque bytes named as
  opaque. The signing digest is shown so it can be compared
- Permit detection covering EIP-2612, DAI, and the Permit2 family, with the
  grant — spender, amount, expiry — stated before the raw fields. "Unlimited" is
  detected per declared type, so a Permit2 uint160 sentinel is not rendered as a
  survivable-looking quantity
- Transaction simulation before signing: balance changes, incoming and outgoing, for native,
  ERC-20, ERC-721 and ERC-1155, plus any approval the transaction grants — decoded from the
  logs the call actually emits, so transfers the calldata never mentions still show up
- Phishing detection by impersonation rather than blocklist: character swaps, ligatures
  (`vv` for `w`), digit substitutions, Unicode homographs, TLD swaps, and embedded names,
  checked against ~70 well-known dApps and explorers. Community feeds in
  eth-phishing-detect format can be imported on top
- Contract-age screening: a contract that did not exist a day ago and is asking for an
  approval is the standard drainer shape, and costs one archive read to catch
- Address-poisoning defence: a recipient is screened against your accounts, your
  address book, and everywhere you have confirmed a send, and flagged when it
  shares the leading and trailing characters a wallet abbreviation shows
- Recipient badges for first-time addresses, prior send counts, and whether the
  target is a wallet, a contract, or specifically a token contract
- Encrypted backup of contacts, account names, networks, tokens, notes, and
  settings — deliberately no key material; the recovery phrase remains the only
  key backup
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
- **Simulation depends on the endpoint.** `eth_simulateV1` gives full balance changes and is
  served by the shipped publicnode endpoints; nodes without it fall back to native-only
  tracing or a bare revert check, and the prompt says which it got. There is no third-party
  simulation backend to fall back on.
- **No USB hardware wallet signing, no Snaps, no WalletConnect.** Air-gapped QR signing
  covers the offline-signer case instead; USB devices are tracked but not signed for.
- **Passkeys cannot control anything yet.** Enrolment, P-256 key extraction, assertion
  production, and RIP-7212 precompile detection all work, but a passkey can only control a
  smart account that verifies WebAuthn on chain, and ADRIX cannot deploy one.
- **Share splitting is secret sharing, not MPC.** The phrase is reconstructed in memory on
  one device at recovery time. True threshold signing never assembles the key and needs live
  counterparties, which an extension does not have.
- **EIP-7702 delegation is the most dangerous action here.** It applies to the address
  already holding funds, and the delegate can move all of it until revoked.
- **ERC-4337 support requires a bundler**, which is third-party infrastructure. Public keyless
  ones are offered as defaults. Only EntryPoint v0.7 is implemented, only the
  `execute(address,uint256,bytes)` account convention is understood, and counterfactual
  accounts cannot be deployed — the account must already exist on chain.
- **Safe support needs the Safe Transaction Service** to share signatures between owners.
  Signing and executing work without it; coordinating with co-owners does not.
- **Incoming-transfer notifications are a poller, not an indexer.** They cover the selected
  network only, are bounded by what the endpoint allows `eth_getLogs` to return, and skip
  zero-value and spam-scored transfers.
- **Swap, bridge, and buy are unimplemented mock screens.** They show a hardcoded rate and
  an alert. They are not wired to any provider.
- **No bundled phishing blocklist.** Impersonation detection and contract-age checks run
  offline and need no feed, but the known-bad domain list is opt-in and empty until you
  import one.
- **No indexer**, so the activity list holds only transactions this wallet sent. Incoming
  transfers never appear, and neither do transactions made from the same account elsewhere.
- **Public RPC endpoints** are shipped as the defaults and are rate-limited. There are two or
  three per chain with automatic failover, so one going down is survivable, but they still
  see every address you query. Swap in your own for real use.
- **Price and NFT floor data come from CoinGecko's free tier**, which is heavily rate limited
  and does not know most collections. The wallet says when values are stale rather than
  presenting cached numbers as current.
- **Swap and bridge routing is a third-party dependency.** LI.FI chooses the venue and builds
  the calldata; ADRIX verifies and simulates it but cannot reverse a trade, and a bridge
  failure is recoverable only through that bridge.
- **No fiat on-ramp of its own.** Buy hands off to Ramp, MoonPay, Coinbase, or Transak with
  the address and network pre-filled; the purchase, KYC, payment, and any dispute are between
  the user and that provider. Providers that require an integrator key work as a plain
  hand-off unless the user supplies their own.
- **Batch transfers are not atomic.** They are separate transactions with sequential nonces.
  A plain EOA cannot do atomic batching without a smart account or an EIP-7702 delegation,
  and the screen says so rather than implying otherwise.
- **No automated tests and no CI.** For a wallet, that is the largest gap on this list.

If you want to take this toward production, the order I would go in: seed-phrase
confirmation on onboarding, a spending-approval warning on `approve` calls with unlimited
amounts, transaction simulation, then a real audit before it touches mainnet value.

## Changelog

**0.2.9** - fixed swap quoting for any token outside the wallet's tracked list (decimals now
come from the aggregator's token metadata, not the portfolio, which is why the receive field
sat at 0.0); rebuilt the token picker as a full-width panel with chain, price, balance, and
verification per row, fixing the horizontal overflow; price-impact warnings and
slippage-versus-impact checking; cross-chain gas delivery on bridges; direct Lido and Rocket
Pool staking; ERC-4626 position tracking.

**0.2.8** - EIP-7702 delegation with target inspection, atomic batching, and revocation;
air-gapped QR signing (UR/bytewords/CBOR implemented against BCR-2020-012 and verified with
its own test vector); Shamir splitting of the recovery phrase with set-identifier binding;
passkey enrolment and P-256 assertion production with honest reporting of what is still
missing before one can authorise a transaction.

**0.2.7** - Safe multisig support (chain-read state, EIP-712 SafeTx signing across contract
versions, Transaction Service coordination, threshold execution with Safe error-code
translation); ERC-4337 smart accounts with EntryPoint v0.7 user operations, bundler gas
estimation, ERC-7677 paymaster sponsorship, and receipt tracking; incoming-transfer
notifications with spam filtering and per-kind preferences.

**0.2.6** - EIP-712 typed data given a real parser (nested structs, arrays, per-type
"unlimited" detection, deadline and amount rendering, EIP-55 checking on embedded addresses,
signing digest) with Permit2 and EIP-2612 grants surfaced ahead of the raw fields; fiat
on-ramp replaced with pre-filled provider hand-offs; batch transfer replaced with real
sequential-nonce sending that reports partial failure honestly.

**0.2.5** - swap and bridge replaced with real LI.FI routing: quote, allowance,
exact-amount approval, independent verification of the aggregator's calldata by local
simulation, and destination-chain tracking for bridges. Prices gained 24h change and an
explicit staleness/rate-limit notice.

**0.2.4** - transaction simulation via `eth_simulateV1` with `debug_traceCall` and
`eth_call` fallbacks, driving a balance-change preview on both the dApp confirmation and the
send review; phishing detection rebuilt around impersonation heuristics plus importable
community feeds; contract-age and blocked-address screening; multi-chain portfolio given
allocation-by-chain and by-asset breakdowns, a result cache, surfaced per-chain failures,
and no more NFT metadata refetching per account per chain.

**0.2.3** - address-poisoning screening on the send recipient with a full
address comparison; richer first-time / send-count / token-contract badges;
encrypted backup and restore for everything the recovery phrase cannot bring
back; zero-value housekeeping transfers folded out of the history; balance
refresh made visible, manual, pull-to-refresh, and paused while the popup is
hidden with backoff on failure.

**0.2.2** - multiple RPC endpoints per network with automatic failover and
per-endpoint backoff; fee presets and inclusion estimates derived from
`eth_feeHistory` instead of fixed multipliers and hardcoded times; base fee
sparkline; nonce gap detection corrected to discount nonces the mempool already
holds, and surfaced on the home screen with a priced gap-fill; NFT collection
floor prices on the detail view.

**0.2.1** - correctness pass: normalised stored transaction values to decimal wei, guarded
the notifications and `setAccessLevel` calls that return `undefined` on some Chrome builds,
raised receipt polling to the 30s floor Chrome actually honours, made the approval window
advance through a queue instead of closing on the first answer, and moved ERC-20 transfer
encoding into the background so the gas estimate and the broadcast transaction cannot drift.
# ADRIX
