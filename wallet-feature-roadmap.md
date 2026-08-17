# Crypto Wallet — Feature Roadmap (Updated)

Your original list is preserved verbatim. Everything under **Missing / Added** is new.
Updated: 17 Aug 2026

---

## Basic

### Your original list
- Better onboarding with password strength meter
- Seed phrase re-check before allowing wallet use
- Import wallet from private key directly
- Account hide/unhide for HD accounts
- Copy address with QR per account
- Token search and token auto-detection
- Better transaction history filters
- Export activity as CSV
- Dark/light theme
- Lock timer controls

### Missing / Added
- **Restore wallet from seed phrase** (12/24 words, with word validation and paste-whole-phrase support)
- **Import from JSON keystore file** (v3 keystore + password)
- **Custom derivation path on import** (Ledger Live path, legacy MetaMask path, custom `m/44'/60'/...`)
- **Multiple vaults** — more than one seed phrase in a single install
- **Rename accounts + identicon/jazzicon avatars**
- **Manual token add by contract address** (for tokens auto-detection misses)
- **Custom network add / edit / delete** — you have an RPC tester but not the underlying network CRUD
- **Block explorer URL configurable per network**
- **Show/hide testnets toggle**
- **Fiat currency selector** (USD / EUR / INR / etc.)
- **Localization (i18n) scaffolding** — even if you ship English only, retrofitting string extraction later is painful
- **Change password flow**
- **Reset wallet / forgot password** (wipe + restore from seed)
- **Speed up and cancel pending transaction** (RBF via same-nonce replacement) — arguably the single most-requested basic feature in any wallet
- **Pending transaction indicator + transaction queue view**
- **Transaction detail screen** — hash, nonce, gas used, block, copy hash, open in explorer
- **QR scanner for recipient address**
- **EIP-681 payment link handling** (`ethereum:0x...?value=...`)
- **Recipient address validation** — EIP-55 checksum check, ENS resolution in the send field
- **Max / Send-all button with fiat ⇄ token input toggle**
- **Backup reminder banner** until the seed is confirmed backed up
- **Empty states, skeleton loaders, and error states** for every async screen
- **Accessibility pass** — keyboard navigation, focus order, ARIA labels, respects OS font scaling and reduced-motion

---

## Intermediate

### Your original list
- Address book, contact labels, favorite recipients
- Custom gas price, priority fee, max fee controls
- Nonce management
- Send all minus estimated gas
- Network health indicator
- RPC URL tester before adding network
- Per-site connected account permissions
- Per-site network permissions
- DApp connection history
- Transaction notes/tags
- Show decoded contract method names
- Token approval warning
- Revoke token approval flow
- NFT display for ERC-721/ERC-1155
- Hide spam tokens/NFTs
- Watch-only accounts
- Multi-account portfolio view
- ENS reverse lookup for addresses
- ENS avatar display

### Missing / Added
- **NFT send/transfer flow** — you list NFT *display* but never NFT *sending*
- **NFT detail view** with metadata, traits, collection floor, and explorer link
- **Gas presets with time estimates** (Low / Market / Aggressive → "~30s", "~2 min") on top of the manual fee controls
- **Base fee history sparkline** so users can see whether to wait
- **Nonce gap detection** — warn when a stuck low nonce is blocking everything behind it
- **Multiple RPC endpoints per network with automatic failover**
- **Token list import** (Uniswap-style token list URLs) rather than only per-token adds
- **Custom token edit/remove** (fix wrong decimals, symbols)
- **`wallet_switchEthereumChain` / `wallet_addEthereumChain` request UI** — the dApp-initiated network prompt
- **Signature request history / message signing log** (what you signed, for whom, when)
- **Global search across transactions, tokens, and contacts**
- **Per-network activity separation** so history doesn't blend chains
- **Contact import/export** and address book sync with the encrypted backup
- **Zero-value / unsolicited transfer filtering** in history (the address-poisoning delivery vector)
- **First-time-recipient badge** — "you've never sent to this address before"
- **Contract-vs-EOA badge on recipient** — flags sending tokens straight to a token contract
- **Account balance auto-refresh + manual pull-to-refresh**

---

## Advanced

### Your original list
- Transaction simulation before signing
- Balance change preview before confirmation
- Token allowance dashboard
- Scam/phishing domain warning list
- Malicious contract/address warnings
- Hardware wallet support
- WalletConnect support
- Multi-chain portfolio aggregation
- Token prices and fiat balances
- Swap integration
- Bridge integration
- Fiat on-ramp integration
- Batch transactions
- Permit signature detection
- EIP-712 typed data human-readable parser
- Session keys / spending limits
- Social recovery or guardian recovery
- Multi-sig account support
- Smart account / account abstraction support
- Gas sponsorship / paymaster support
- Bundler support for ERC-4337
- Push notifications for incoming/outgoing transactions

### Missing / Added
- **EIP-7702 delegation support** — the big gap here. Post-Pectra, plain EOAs can delegate to smart-contract code, which is how most wallets are now delivering batching, sponsorship, and session keys without migrating users to a new 4337 address. Your list jumps straight to 4337/bundlers and skips the path most users will actually take.
- **Passkey / WebAuthn signing** (secp256r1, EIP-7212) for smart accounts
- **MPC / threshold-signature accounts** as an alternative to seed-phrase custody
- **Air-gapped QR signing** (Keystone/UR format) alongside USB hardware wallets
- **MEV protection / private transaction RPC** (Flashbots Protect–style default for swaps)
- **Slippage settings + price impact warning** on swaps
- **Cross-chain gas payment / pay fees in stablecoins**
- **Staking and liquid-staking integration**
- **DeFi position tracking** — LP, lending, and vault positions, not just token balances
- **Portfolio value chart over time** with cost basis
- **Tax / accounting export** (per-disposal CSV, not just raw activity)
- **Sign-In With Ethereum (EIP-4361)** with a proper human-readable SIWE prompt
- **Encrypted cloud backup** (iCloud / Google Drive) as an optional recovery path
- **Multi-device sync** for settings, contacts, custom tokens, and account names
- **Fiat off-ramp** (you have on-ramp only)
- **Simulation fallback provider** — self-hosted `eth_simulateV1` plus a third-party fallback so simulation degrades gracefully instead of disappearing

---

## Security

### Your original list
- Auto-lock on browser idle
- Require password before every signature/send
- Phishing warning before connecting to unknown dApps
- Blocklist/allowlist for dApps
- Clipboard address poisoning detection
- Transaction recipient mismatch warning
- Suspicious unlimited approval warning
- Seed phrase reveal cooldown
- Screenshot/clipboard warning on seed screen
- Password retry rate limiting
- Encrypted backup export/import
- Local security audit screen
- Testnet/mainnet warning mode

### Missing / Added
- **Biometric unlock** (Touch ID / Face ID / Windows Hello via WebAuthn) — password-only unlock is a big friction and abandonment source
- **Blind-signing warning** — loud, unmissable interstitial when signing raw hex the wallet can't decode
- **`eth_sign` disabled by default** — the classic full-account-drain primitive; require an explicit advanced-settings opt-in
- **EIP-712 domain vs. request origin check** — reject a typed-data payload whose `verifyingContract`/`chainId` doesn't match the connected site
- **Lookalike-address detection in history** — flag addresses matching a known one only in the first/last four characters
- **Approval expiry and per-session spending caps**
- **Key material handling** — zeroize decrypted keys in memory after use, never write them to logs, never hold them in the UI process longer than needed
- **Strict Content Security Policy, no `eval`, no remote code loading** — the recurring cause of extension-wallet compromises
- **Inpage provider ⇄ content script ⇄ background message hardening** — origin verification on every message, no wildcard `postMessage` targets
- **Extension integrity / anti-tamper check** on startup
- **Reproducible + code-signed builds** with published hashes so users can verify the shipped artifact
- **Dependency supply-chain controls** — lockfiles, pinned versions, `npm audit`/Dependabot in CI, minimal dependency surface
- **RPC privacy** — don't leak the user's full address set to a single public RPC; batch, rotate, or offer a proxy
- **No telemetry by default**, with an explicit opt-in and a published privacy policy
- **Chain ID replay-protection check** before signing
- **Auto-lock on OS sleep/screen lock**, not just browser idle
- **Verified entropy source** for seed generation (`crypto.getRandomValues`, never `Math.random`, with a test asserting it)
- **Third-party audit + public bug bounty** before you touch mainnet funds at any real scale
- **Responsible disclosure policy and security contact** (`security.txt`)

---

## Developer / DApp Compatibility

### Your original list
- More EIP-1193 compatibility methods
- wallet_getCapabilities
- wallet_sendCalls
- wallet_getCallsStatus
- wallet_showCallsStatus
- wallet_scanQRCode
- EIP-6963 polish
- Better MetaMask compatibility toggle
- DApp permission debugging page
- RPC request logs for development
- Demo dApp with connect/sign/send examples

### Missing / Added
- **`wallet_watchAsset` (EIP-747)** — dApp-initiated token add; extremely common and cheap to implement
- **`wallet_requestPermissions` / `wallet_getPermissions` / `wallet_revokePermissions` (EIP-2255)**
- **`wallet_switchEthereumChain` / `wallet_addEthereumChain`** — the provider-side counterpart to the UI above
- **Correct EIP-1193 error codes** — 4001 user rejected, 4100 unauthorized, 4900/4901 disconnected. Wrong codes break dApp error handling in ways that look like your wallet is broken.
- **Full provider event surface** — `connect`, `disconnect`, `accountsChanged`, `chainChanged`, emitted in the right order on switch and lock
- **`eth_subscribe` / WebSocket support** for dApps that expect live logs
- **EIP-7702 authorization signing** on the provider surface
- **SIWE (EIP-4361) message parsing** so the prompt isn't just an opaque blob
- **Local dev network presets** — Anvil/Hardhat on `127.0.0.1:8545`, one click
- **Fork mode** for testing against forked mainnet state
- **Deterministic test mode** with fixed accounts for E2E suites
- **Public docs site + changelog + semantic versioning**

---

## Quality & Infrastructure — new category

None of this was in the original list, and for a wallet it's not optional — a state-migration bug is a fund-loss bug.

- **State schema versioning and migrations** — with a rollback path and migration tests
- **Automated test suite**: unit tests on key derivation/encryption, integration on RPC, E2E on connect/sign/send with a headless dApp
- **CI on every PR** — tests, lint, typecheck, audit, bundle-size budget
- **Crash/error monitoring with strict PII scrubbing** (never addresses, balances, or key material)
- **Feature flags / staged rollout** — so a bad signing change can be turned off without a store review cycle
- **Cross-browser support matrix** — Chrome, Brave, Edge, Firefox, and the Safari extension differences
- **Cold-start and unlock performance budgets** — wallets get judged on how fast the popup opens
- **Manifest V3 service-worker lifecycle handling** — the classic source of "wallet randomly disconnects" bug reports
- **Mobile app or mobile-web strategy** — decide early; it changes your key-storage architecture
- **License, terms, privacy policy, and store-listing compliance**

---

## Revised "best next features"

Your original five were well chosen. Reordered with the additions folded in:

1. **Speed up / cancel pending transaction** — the most common real-world failure state, and cheap. Ships before anything else.
2. **Token approval dashboard + revoke** — your #1, unchanged. High trust value, self-contained.
3. **Transaction simulation / balance-change preview** — your #3. The single biggest anti-drainer feature, but budget for a real simulation backend.
4. **Blind-signing warning + `eth_sign` disabled + EIP-712 origin check** — a small, high-leverage security bundle that closes the drainer paths simulation alone won't.
5. **Token prices and total portfolio value** — your #5. Cheap, and it's what makes the wallet feel finished.
6. **`wallet_watchAsset` + correct EIP-1193 error codes + provider events** — a day or two of work that removes a whole class of "your wallet is broken" reports.
7. **Watch-only accounts** — your #4, moved down slightly; valuable but lower daily-use frequency than the above.
8. **NFT tab** — your #2, moved down. It's the most visible feature on the list but the least load-bearing, and NFT indexing pulls in a third-party dependency you'll then own forever.

### One structural note

Your **Advanced** section commits to ERC-4337 (bundlers, paymasters, smart accounts) without mentioning EIP-7702. Since Pectra, 7702 delegation gets you batching, sponsorship, and session keys on the user's *existing* address, with no migration and no bundler infrastructure. If you're deciding where account-abstraction effort goes, that decision is worth making explicitly before either path gets built.
