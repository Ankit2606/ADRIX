import { getAddress, isHexString, toUtf8String } from 'ethers';
import { getChainId, getNetwork, setChain, addNetwork, allNetworks, rpcPassthrough, testRpc } from './networks.js';
import { getWallet, hasVault, isUnlocked, listAccounts } from './keyring.js';
import * as permissions from './permissions.js';
import { askUser } from './approvals.js';
import { sendTransaction, estimateGas, describeTransaction, inspectApproval } from './transactions.js';
import { addToken } from './tokens.js';
import * as signatures from './signatures.js';
import { broadcastEvent, notifyUi } from './events.js';
import { isDomainFlagged, isAddressFlagged } from './security.js';

const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

async function openWallet() {
  await chrome.windows.create({
    url: chrome.runtime.getURL('index.html'),
    type: 'popup',
    width: 400,
    height: 640,
    focused: true,
  });
}

/** Everything that touches keys goes through here first. */
async function requireUnlockedAccount(origin, address) {
  if (!(await hasVault())) {
    openWallet();
    fail(4100, 'No wallet set up yet. Create one in ADRIX, then try again.');
  }
  await permissions.ensureNetworkPermitted(origin);
  const accounts = await permissions.accountsFor(origin, { requireNetwork: true });
  if (!accounts.length) fail(4100, 'Connect to ADRIX first.');

  const target = address ? getAddress(address) : accounts[0];
  if (!accounts.some((a) => a.toLowerCase() === target.toLowerCase())) {
    fail(4100, 'That account is not authorised for this site.');
  }

  // Reject an account that can never sign *before* estimating gas and putting a
  // prompt in front of the user. Without this the request runs the whole way to
  // getWallet() and fails there, after the user has already clicked Confirm.
  const account = (await listAccounts()).find((a) => a.address.toLowerCase() === target.toLowerCase());
  if (account && account.type !== 'hd' && account.type !== 'imported') {
    const reason = {
      watch: 'That is a watch-only account. ADRIX holds no key for it and cannot sign.',
      hardware: 'Hardware wallet signing is not implemented in ADRIX yet.',
      smart: 'Smart accounts need an ERC-4337 bundler, which ADRIX does not have yet.',
      multisig: 'Multisig accounts need co-owner signatures, which ADRIX cannot gather yet.',
    }[account.type];
    fail(4100, reason ?? 'That account cannot sign transactions.');
  }

  // A locked wallet is not an error here: the approval window unlocks inline,
  // and getWallet() throws if the user backs out of that.
  return target;
}

function decodeMessage(value) {
  if (!isHexString(value)) return String(value);
  try {
    return toUtf8String(value);
  } catch {
    return value;
  }
}

function hexToBytes(hex) {
  const clean = hex.slice(2);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}

export async function handleRpc(method, params = [], origin) {
  const chainId = await getChainId();

  switch (method) {
    // --- read-only, no permission needed -----------------------------------
    case 'eth_chainId':
      return chainId;

    case 'net_version':
      return String(parseInt(chainId, 16));

    case 'web3_clientVersion':
      return 'ADRIX/v0.2.0';

    case 'adrix_isUnlocked':
      return isUnlocked();

    case 'eth_accounts':
      return permissions.accountsFor(origin, { requireNetwork: true });

    case 'eth_coinbase':
      return (await permissions.accountsFor(origin, { requireNetwork: true }))[0] ?? null;

    // --- connecting ---------------------------------------------------------
    case 'eth_requestAccounts':
    case 'wallet_requestPermissions': {
      const existing = await permissions.accountsFor(origin);
      const currentNetworkAllowed = await permissions.isNetworkPermitted(origin, chainId);
      if (existing.length && currentNetworkAllowed && method === 'eth_requestAccounts') {
        await permissions.touch(origin, 'used', { method });
        return permissions.accountsFor(origin, { requireNetwork: true });
      }

      if (!(await hasVault())) {
        openWallet();
        fail(4100, 'No wallet set up yet. Create one in ADRIX, then click Connect again.');
      }

      const networks = await allNetworks();
      const decision = await askUser({
        kind: 'connect',
        origin,
        networks,
        chainId,
        grantedAccounts: existing,
        grantedNetworks: await permissions.networksFor(origin),
      });
      const chosen = Array.isArray(decision) ? decision : decision.accounts;
      const chosenNetworks = Array.isArray(decision) ? [chainId] : decision.networks;
      await permissions.grant(origin, chosen, chosenNetworks);
      broadcastEvent('accountsChanged', await permissions.accountsFor(origin, { requireNetwork: true }), origin);
      notifyUi();

      if (method === 'wallet_requestPermissions') {
        return [
          {
            parentCapability: 'eth_accounts',
            caveats: [{ type: 'restrictReturnedAccounts', value: chosen }],
          },
          {
            parentCapability: 'wallet_switchEthereumChain',
            caveats: [{ type: 'restrictAllowedChains', value: chosenNetworks }],
          },
        ];
      }
      return permissions.accountsFor(origin, { requireNetwork: true });
    }

    case 'wallet_getPermissions': {
      const accounts = await permissions.accountsFor(origin);
      const siteNetworks = await permissions.networksFor(origin);
      return accounts.length
        ? [
            { parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: accounts }] },
            {
              parentCapability: 'wallet_switchEthereumChain',
              caveats: [{ type: 'restrictAllowedChains', value: siteNetworks }],
            },
          ]
        : [];
    }

    case 'wallet_revokePermissions':
      await permissions.revoke(origin);
      broadcastEvent('accountsChanged', [], origin);
      notifyUi();
      return null;

    // --- signing ------------------------------------------------------------
    case 'personal_sign': {
      // Wallets accept both orders in the wild, so sniff which arg is the address.
      const [a, b] = params;
      const isAddressFirst = typeof a === 'string' && a.length === 42 && a.startsWith('0x');
      const rawMessage = isAddressFirst ? b : a;
      const account = await requireUnlockedAccount(origin, isAddressFirst ? a : b);

      await askUser({
        kind: 'personalSign',
        origin,
        account,
        message: decodeMessage(rawMessage),
        raw: rawMessage,
      });
      await permissions.touch(origin, 'personalSign', { account });

      const wallet = await getWallet(account);
      const signature = await wallet.signMessage(isHexString(rawMessage) ? hexToBytes(rawMessage) : rawMessage);

      // Logged after signing, so the record only ever describes something that
      // actually happened.
      await signatures
        .recordSignature({
          type: 'personal',
          origin,
          account,
          chainId,
          networkName: (await getNetwork()).name,
          message: decodeMessage(rawMessage),
          raw: typeof rawMessage === 'string' ? rawMessage : '',
          signature,
        })
        .catch(() => {});
      notifyUi();

      return signature;
    }

    case 'eth_sign':
      fail(4200, 'eth_sign is disabled because it can be used to sign transactions blind. Use personal_sign.');
      return;

    case 'eth_signTypedData':
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4': {
      const [maybeAddress, payload] = params;
      const account = await requireUnlockedAccount(origin, maybeAddress);
      const typed = typeof payload === 'string' ? JSON.parse(payload) : payload;

      await askUser({
        kind: 'typedSign',
        origin,
        account,
        primaryType: typed.primaryType,
        domain: typed.domain,
        message: typed.message,
      });
      await permissions.touch(origin, 'typedSign', { account, primaryType: typed.primaryType });

      const types = { ...typed.types };
      delete types.EIP712Domain;
      const wallet = await getWallet(account);
      const signature = await wallet.signTypedData(typed.domain, types, typed.message);

      // A Permit signed here grants spending rights that never appear in the
      // on-chain approvals list, so this log is the only place it is recorded.
      await signatures
        .recordSignature({
          type: 'typed',
          origin,
          account,
          chainId,
          networkName: (await getNetwork()).name,
          primaryType: typed.primaryType,
          domain: typed.domain,
          message: typed.message,
          signature,
        })
        .catch(() => {});
      notifyUi();

      return signature;
    }

    // --- transactions -------------------------------------------------------
    case 'eth_sendTransaction': {
      const [tx = {}] = params;
      const account = await requireUnlockedAccount(origin, tx.from);
      const network = await getNetwork();

      const gasInfo = await estimateGas({
        from: account,
        to: tx.to,
        value: tx.value ?? '0x0',
        data: tx.data ?? '0x',
      });

      const summary = describeTransaction({ to: tx.to, value: tx.value ?? '0x0', data: tx.data ?? '0x' });

      // An approve call is priced against what the allowance already is, which
      // the calldata alone cannot say.
      const approvalContext = summary.spender
        ? await inspectApproval({
            owner: account,
            contract: tx.to,
            data: tx.data ?? '0x',
            chainId,
          }).catch(() => null)
        : null;

      const decision = await askUser({
        kind: 'transaction',
        origin,
        account,
        to: tx.to ?? null,
        value: tx.value ?? '0x0',
        data: tx.data ?? '0x',
        network: network.name,
        symbol: network.symbol,
        explorer: network.explorer,
        gasInfo,
        summary,
        approvalContext,
        suggestedGas: tx.gas ?? tx.gasLimit ?? null,
      });
      await permissions.touch(origin, 'transaction', {
        account,
        chainId,
        to: tx.to ?? null,
        value: tx.value ?? '0x0',
      });
      notifyUi();

      return sendTransaction({
        from: account,
        to: tx.to,
        value: tx.value ?? '0x0',
        data: tx.data ?? '0x',
        gas: tx.gas ?? tx.gasLimit ?? decision?.gasLimit ?? gasInfo.gasLimit,
        fees: decision?.fees ?? gasInfo.options.market,
        meta: { origin },
      });
    }

    // --- chain management ---------------------------------------------------
    case 'wallet_switchEthereumChain': {
      const target = params?.[0]?.chainId?.toLowerCase();
      const networks = await allNetworks();
      if (!networks[target]) {
        fail(4902, 'ADRIX does not have that network. Add it first with wallet_addEthereumChain.');
      }
      if (target === chainId) return null;

      await askUser({
        kind: 'switchChain',
        origin,
        network: networks[target],
        // Switching is a change of context, and the thing that makes it
        // meaningful is what it is changing *from*.
        current: networks[chainId] ?? null,
      });
      await permissions.grantNetworks(origin, [target]);
      await setChain(target);
      broadcastEvent('chainChanged', target);
      await permissions.touch(origin, 'chainSwitched', { chainId: target });
      notifyUi();
      return null;
    }

    case 'wallet_addEthereumChain': {
      const request = params?.[0] ?? {};
      const target = request.chainId?.toLowerCase();
      const networks = await allNetworks();
      if (networks[target]) {
        await askUser({
          kind: 'switchChain',
          origin,
          network: networks[target],
          current: networks[chainId] ?? null,
          // The dApp asked to *add* a network the wallet already has, so this
          // is really a switch. Saying so avoids a prompt that looks like it is
          // about to overwrite an existing network's settings.
          alreadyKnown: true,
        });
        await permissions.grantNetworks(origin, [target]);
        await setChain(target);
        broadcastEvent('chainChanged', target);
        await permissions.touch(origin, 'chainSwitched', { chainId: target });
        notifyUi();
        return null;
      }

      // A dApp usually offers several endpoints. Keeping all of them is the
      // whole point of the failover list, so they are carried across rather
      // than discarded down to the first one.
      const offered = Array.isArray(request.rpcUrls) ? request.rpcUrls : [request.rpcUrls];
      const candidate = {
        chainId: target,
        name: request.chainName,
        rpcUrls: offered.filter(Boolean),
        rpc: offered.filter(Boolean)[0],
        symbol: request.nativeCurrency?.symbol ?? 'ETH',
        explorer: Array.isArray(request.blockExplorerUrls) ? request.blockExplorerUrls[0] : '',
      };

      // Probed before the prompt, not after approval. The one thing that makes
      // an added network dangerous is an endpoint that serves a different chain
      // than it claims — the user cannot check that, and the wallet can.
      const verification = await testRpc(candidate).then(
        (result) => ({ ok: true, ...result }),
        (err) => ({ ok: false, error: err.message })
      );

      await askUser({
        kind: 'addChain',
        origin,
        network: candidate,
        current: networks[chainId] ?? null,
        verification,
      });
      await addNetwork(candidate);
      await permissions.grantNetworks(origin, [target]);
      await setChain(target);
      broadcastEvent('chainChanged', target);
      await permissions.touch(origin, 'networkAdded', { chainId: target, name: candidate.name });
      notifyUi();
      return null;
    }

    case 'wallet_watchAsset': {
      const options = params?.options ?? params?.[0]?.options ?? {};
      const type = params?.type ?? params?.[0]?.type;
      if (type !== 'ERC20') fail(4200, 'Only ERC20 assets can be watched.');

      await askUser({
        kind: 'watchAsset',
        origin,
        token: { address: options.address, symbol: options.symbol, decimals: options.decimals },
      });
      await addToken({ address: options.address, symbol: options.symbol, decimals: Number(options.decimals) });
      await permissions.touch(origin, 'watchAsset', { symbol: options.symbol, address: options.address });
      notifyUi();
      return true;
    }

    // --- everything else goes to the node -----------------------------------
    default: {
      await permissions.ensureNetworkPermitted(origin);
      // Routed through the failover rotation, so a dApp's raw RPC calls survive
      // an endpoint outage the same way the wallet's own reads do.
      return rpcPassthrough(chainId, method, params);
    }
  }
}
