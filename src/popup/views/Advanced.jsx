import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { call, shorten, timeAgo, useAsyncAction } from '../../lib/ui.js';
import { BackBar, PasswordPrompt, QrScanner, Skeleton } from '../components/common.jsx';
import { enrollPasskey } from '../../background/webauthn.js';

const SECTIONS = [
  { key: 'delegation', label: 'Delegation', hint: 'EIP-7702' },
  { key: 'airgap', label: 'Air-gapped', hint: 'QR signing' },
  { key: 'shares', label: 'Shares', hint: 'Split a phrase' },
  { key: 'passkeys', label: 'Passkeys', hint: 'WebAuthn' },
];

export default function Advanced({ state, go }) {
  const [section, setSection] = useState('delegation');

  return (
    <div className="screen">
      <BackBar title="Advanced" onBack={() => go('settings')} />
      <div className="scroll pad stack">
        <div className="tabs wrap-tabs" role="tablist" aria-label="Advanced features">
          {SECTIONS.map((entry) => (
            <button
              key={entry.key}
              role="tab"
              aria-selected={section === entry.key}
              onClick={() => setSection(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {section === 'delegation' && <Delegation state={state} />}
        {section === 'airgap' && <AirGapped state={state} />}
        {section === 'shares' && <Shares state={state} />}
        {section === 'passkeys' && <Passkeys state={state} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
/**
 * EIP-7702 delegation.
 *
 * The most dangerous screen in the wallet. Delegating points the account the
 * user already holds funds in at someone else's code, and that code can move
 * everything. The flow is therefore two-step with the target inspected in
 * between, and an unrecognised target is treated as hostile by default.
 */
function Delegation({ state }) {
  const [status, setStatus] = useState(null);
  const [support, setSupport] = useState(null);
  const [target, setTarget] = useState('');
  const [probe, setProbe] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [result, setResult] = useState(null);
  const { busy, error, setError, run } = useAsyncAction();

  const load = async () => {
    setStatus(await call('GET_DELEGATION', {}).catch(() => null));
    setSupport(await call('DELEGATION_SUPPORT', {}).catch(() => null));
  };

  useEffect(() => {
    load();
    setProbe(null);
    setResult(null);
  }, [state.selected, state.chainId]);

  const inspect = () =>
    run(async () => {
      setProbe(null);
      setAcknowledged(false);
      const { address } = await call('RESOLVE_RECIPIENT', { input: target });
      setProbe(await call('INSPECT_DELEGATE', { target: address }));
    });

  const apply = () =>
    run(async () => {
      const res = await call('SET_DELEGATION', { target: probe.address });
      setResult(res);
      setProbe(null);
      setTarget('');
      await load();
    });

  const revoke = () =>
    run(async () => {
      setResult(await call('REVOKE_DELEGATION', {}));
      await load();
    });

  return (
    <>
      <div className="card">
        <div className="between">
          <span className="eyebrow">This account on {state.network?.name}</span>
          {status?.delegated ? (
            <span className="badge pending">delegated</span>
          ) : (
            <span className="badge confirmed">plain account</span>
          )}
        </div>

        {!status ? (
          <Skeleton height={40} radius={10} />
        ) : status.delegated ? (
          <>
            <p className="small">
              Every call to this address runs the code at the target below, with this account's balance and
              permissions.
            </p>
            <div className="data-block">{status.target}</div>
            <button className="danger" onClick={revoke} disabled={busy}>
              {busy ? 'Revoking…' : 'Revoke delegation'}
            </button>
          </>
        ) : (
          <p className="small">
            {status.note ??
              'No delegation set. This account behaves as an ordinary externally owned account.'}
          </p>
        )}
      </div>

      {support && !support.supported && (
        <div className="notice">
          {state.network?.name} does not appear to have activated EIP-7702. A delegation transaction sent here will be
          rejected by the node.
        </div>
      )}

      {result && (
        <div className="ok">
          {result.revoking ? 'Revocation' : 'Delegation'} submitted. It takes effect once the transaction confirms.
          <div className="data-block">{result.hash}</div>
        </div>
      )}

      {!status?.delegated && (
        <div className="card">
          <h2>Delegate this account</h2>
          <div className="notice danger">
            <b>This hands control of the account to a contract.</b>
            <p className="small">
              Unlike a smart account, which is a separate address you choose to fund, a 7702 delegation applies to the
              address already holding your funds. The target's code can move all of it, on this chain, until you
              revoke. Only delegate to code you have a specific reason to trust.
            </p>
          </div>

          <label className="field">
            <span>Delegate contract</span>
            <input
              className="mono"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setProbe(null);
                setError('');
              }}
              placeholder="0x…"
              spellCheck="false"
            />
          </label>

          {probe && (
            <div className="card">
              <span className="eyebrow">What is at that address</span>
              <div className="kv">
                <span className="kv-key">Contract</span>
                <span className="kv-value">{probe.isContract ? `${probe.codeSize} bytes` : 'nothing deployed'}</span>
              </div>
              {probe.codeHash && (
                <div className="kv">
                  <span className="kv-key">Code hash</span>
                  <span className="kv-value mono small">{shorten(probe.codeHash, 10, 8)}</span>
                </div>
              )}
              <div className="kv">
                <span className="kv-key">Batch support</span>
                <span className="kv-value">{probe.supportsBatch ? 'yes' : 'not detected'}</span>
              </div>
              {probe.trusted && (
                <div className="kv">
                  <span className="kv-key">Trusted</span>
                  <span className="kv-value">{probe.trusted.label}</span>
                </div>
              )}
              {probe.warnings.map((warning) => (
                <div className="notice danger" key={warning}>
                  {warning}
                </div>
              ))}

              <label className="check-line">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                I understand this contract will be able to move everything in this account.
              </label>
            </div>
          )}

          {error && <div className="error" role="alert">{error}</div>}

          {!probe ? (
            <button className="ghost" onClick={inspect} disabled={busy || !target.trim()}>
              {busy ? 'Reading…' : 'Inspect contract'}
            </button>
          ) : (
            <button className="danger" onClick={apply} disabled={busy || !acknowledged}>
              {busy ? 'Delegating…' : 'Delegate this account'}
            </button>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
/**
 * Air-gapped signing.
 *
 * The wallet shows a QR the offline device scans, then reads the signature back
 * through the camera. Nothing secret crosses either way — the request is public
 * data and the response is a signature.
 */
function AirGapped({ state }) {
  const [mode, setMode] = useState(null);
  const [dataHex, setDataHex] = useState('');
  const [request, setRequest] = useState(null);
  const [qr, setQr] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(null);
  const { busy, error, setError, run } = useAsyncAction();

  useEffect(() => {
    if (!request) return;
    QRCode.toDataURL(request.ur.toUpperCase(), { width: 260, margin: 1, errorCorrectionLevel: 'L' })
      .then(setQr)
      .catch(() => setQr(''));
  }, [request]);

  const build = () =>
    run(async () => {
      setRequest(
        await call('UR_BUILD_REQUEST', {
          dataHex,
          dataType: 1,
          chainId: state.chainId,
          address: state.selected,
          derivationPath: "m/44'/60'/0'/0/0",
          origin: 'ADRIX',
        })
      );
    });

  return (
    <>
      <div className="card">
        <h2>Air-gapped signing</h2>
        <p className="small">
          Exchanges Keystone-format UR codes with an offline signer. The wallet shows a QR the device scans, and reads
          the returned signature through the camera.
        </p>
        <div className="notice">
          Single-frame codes only. Keystone splits large payloads across an animated sequence using a rateless code
          that ADRIX does not implement — those are detected and refused rather than misread.
        </div>
      </div>

      <div className="row2">
        <button className="ghost" aria-pressed={mode === 'sign'} onClick={() => setMode('sign')}>
          Build request
        </button>
        <button className="ghost" aria-pressed={mode === 'read'} onClick={() => setMode('read')}>
          Read a QR
        </button>
      </div>

      {mode === 'sign' && (
        <div className="card">
          <label className="field">
            <span>Payload to sign (hex)</span>
            <textarea
              className="mono"
              rows={3}
              value={dataHex}
              onChange={(e) => {
                setDataHex(e.target.value.replace(/[^0-9a-fA-Fx]/g, ''));
                setRequest(null);
                setError('');
              }}
              placeholder="0x02f8…"
              spellCheck="false"
            />
            <span className="small faint">
              The serialised transaction or message the device should sign. ADRIX does not build this for you yet —
              this screen is the transport, not the composer.
            </span>
          </label>
          {error && <div className="error" role="alert">{error}</div>}
          <button className="ghost" onClick={build} disabled={busy || !dataHex.trim()}>
            {busy ? 'Encoding…' : 'Make QR'}
          </button>

          {request && (
            <div className="stack-sm center">
              {qr && <img className="qr" src={qr} alt="Signing request QR code" width="260" height="260" />}
              <span className="small faint">
                {request.bytes} bytes · request {shorten(request.requestId, 6, 4)}
              </span>
              <div className="data-block">{request.ur}</div>
            </div>
          )}
        </div>
      )}

      {mode === 'read' && (
        <div className="card">
          {scanning ? (
            <QrScanner
              onClose={() => setScanning(false)}
              onResult={(value) =>
                run(async () => {
                  setScanning(false);
                  const text = String(value);
                  // Either a signature coming back, or an account being
                  // exported from the device.
                  const parsed = text.toLowerCase().includes('hdkey')
                    ? { kind: 'account', ...(await call('UR_PARSE_HDKEY', { text })) }
                    : { kind: 'signature', ...(await call('UR_PARSE_SIGNATURE', { text })) };
                  setScanned(parsed);
                })
              }
            />
          ) : (
            <>
              <p className="small">
                Scan an <code>eth-signature</code> returned by the device, or a <code>crypto-hdkey</code> to import an
                account from it.
              </p>
              {error && <div className="error" role="alert">{error}</div>}
              <button className="ghost" onClick={() => setScanning(true)}>
                Open camera
              </button>
            </>
          )}

          {scanned?.kind === 'signature' && (
            <div className="stack-sm">
              <div className="ok">Signature read and checksum verified.</div>
              <div className="kv">
                <span className="kv-key">v</span>
                <span className="kv-value mono">{scanned.v}</span>
              </div>
              <span className="eyebrow">Signature</span>
              <div className="data-block">{scanned.signature}</div>
            </div>
          )}
          {scanned?.kind === 'account' && (
            <div className="stack-sm">
              <div className="ok">Account key read from the device.</div>
              <div className="kv">
                <span className="kv-key">Path</span>
                <span className="kv-value mono small">{scanned.path ?? 'not stated'}</span>
              </div>
              <div className="data-block">{scanned.publicKey}</div>
              {!scanned.usable && (
                <div className="notice">
                  That key is not a compressed SEC1 public key, so an address cannot be derived from it.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
/**
 * Splitting a recovery phrase into shares.
 *
 * Presented as what it is — secret sharing, not threshold signing — because the
 * two have different threat models and the difference decides whether this is
 * the right tool.
 */
function Shares({ state }) {
  const [mode, setMode] = useState(null);
  const [threshold, setThreshold] = useState(3);
  const [total, setTotal] = useState(5);
  const [result, setResult] = useState(null);
  const [inputs, setInputs] = useState(['', '', '']);
  const [recovered, setRecovered] = useState(null);
  const { busy, error, setError, run } = useAsyncAction();

  return (
    <>
      <div className="card">
        <h2>Split your recovery phrase</h2>
        <p className="small">
          Turns the phrase into several shares, any {threshold} of which rebuild it. No single share reveals anything —
          with fewer than {threshold}, every possible phrase remains equally likely.
        </p>
        <div className="notice">
          <b>This is secret sharing, not MPC.</b>
          <p className="small">
            Threshold signatures never assemble the key: the parties sign jointly and the whole key exists nowhere.
            That needs live counterparties, which a browser extension does not have. Shares do get combined — on one
            device, in memory, at recovery time — so this removes the single point of <em>failure</em> in storing a
            phrase, not the single point of <em>compromise</em> in using one.
          </p>
        </div>
      </div>

      <div className="row2">
        <button className="ghost" aria-pressed={mode === 'split'} onClick={() => setMode('split')}>
          Create shares
        </button>
        <button className="ghost" aria-pressed={mode === 'combine'} onClick={() => setMode('combine')}>
          Recover from shares
        </button>
      </div>

      {mode === 'split' && !result && (
        <div className="card">
          <div className="row2">
            <label className="field">
              <span>Shares needed</span>
              <select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
                {[2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Shares created</span>
              <select value={total} onChange={(e) => setTotal(Number(e.target.value))}>
                {[2, 3, 4, 5, 6, 7, 8].filter((n) => n >= threshold).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="small faint">
            Any {threshold} of {total} recover the wallet. Losing {total - threshold + 1} of them loses it for good.
          </p>
          <PasswordPrompt
            cta="Create shares"
            label="Confirm your password"
            onSubmit={(password) =>
              run(async () => {
                setResult(await call('SPLIT_PHRASE', { password, threshold, total }));
              })
            }
          />
          {error && <div className="error" role="alert">{error}</div>}
        </div>
      )}

      {result && (
        <div className="card">
          <div className="between">
            <span className="eyebrow">
              {result.threshold} of {result.total} · set {result.setId}
            </span>
            <button className="link" onClick={() => setResult(null)}>
              done
            </button>
          </div>
          <div className="notice danger">
            Write each share on separate paper and store them apart. Anyone holding {result.threshold} of them owns the
            wallet. They are shown once and are not saved.
          </div>
          {result.shares.map((share) => (
            <div key={share.index} className="stack-sm">
              <span className="eyebrow">
                Share {share.index} of {result.total} · set {result.setId}
              </span>
              <div className="data-block">{share.text}</div>
            </div>
          ))}
        </div>
      )}

      {mode === 'combine' && (
        <div className="card">
          <p className="small">Enter any {inputs.length} shares from the same set.</p>
          {inputs.map((value, index) => (
            <label className="field" key={index}>
              <span>Share {index + 1}</span>
              <textarea
                className="mono"
                rows={2}
                value={value}
                onChange={(e) => {
                  const next = [...inputs];
                  next[index] = e.target.value;
                  setInputs(next);
                  setError('');
                }}
                spellCheck="false"
              />
            </label>
          ))}
          <div className="row2">
            <button className="ghost" onClick={() => setInputs([...inputs, ''])}>
              + Another share
            </button>
            <button
              className="primary"
              disabled={busy || inputs.filter((v) => v.trim()).length < 2}
              onClick={() =>
                run(async () => {
                  setRecovered(await call('COMBINE_SHARES', { shares: inputs.filter((v) => v.trim()) }));
                })
              }
            >
              {busy ? 'Combining…' : 'Recover phrase'}
            </button>
          </div>
          {error && <div className="error" role="alert">{error}</div>}
          {recovered && (
            <div className="stack-sm">
              <div className="ok">
                Recovered a {recovered.wordCount}-word phrase from {recovered.sharesUsed} shares.
              </div>
              <div className="data-block">{recovered.phrase}</div>
              <div className="notice danger">
                This is the full recovery phrase. Import it into a wallet now, or clear this screen — it is not stored
                here.
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
/**
 * Passkeys.
 *
 * Enrolment and signing have to happen in this page — a service worker has no
 * navigator.credentials — so the WebAuthn calls are made directly here rather
 * than through the background.
 */
function Passkeys({ state }) {
  const [readiness, setReadiness] = useState(null);
  const [passkeys, setPasskeys] = useState([]);
  const [label, setLabel] = useState('');
  const { busy, error, setError, run } = useAsyncAction();

  const load = async () => {
    setReadiness(await call('PASSKEY_READINESS', {}).catch(() => null));
    setPasskeys((await call('PASSKEY_LIST', {}).catch(() => ({ passkeys: [] }))).passkeys ?? []);
  };

  useEffect(() => {
    load();
  }, [state.chainId]);

  return (
    <>
      <div className="card">
        <h2>Passkeys</h2>
        <p className="small">
          A passkey signs with P-256, which Ethereum cannot verify natively. Two things have to be true before one can
          authorise anything on chain, and ADRIX can only supply the first.
        </p>

        <div className="kv">
          <span className="kv-key">P-256 precompile on {state.network?.name}</span>
          <span className="kv-value">
            {readiness?.precompile?.supported ? (
              <span className="badge confirmed">available</span>
            ) : (
              <span className="badge failed">absent</span>
            )}
          </span>
        </div>

        {readiness?.blockers?.map((blocker) => (
          <div className="notice" key={blocker}>
            {blocker}
          </div>
        ))}
      </div>

      <div className="card">
        <div className="between">
          <span className="eyebrow">Enrolled ({passkeys.length})</span>
        </div>
        {!passkeys.length ? (
          <p className="small faint">None yet.</p>
        ) : (
          passkeys.map((passkey) => (
            <div className="item static compact" key={passkey.id}>
              <div className="item-main">
                <span className="item-title">{passkey.label}</span>
                <span className="item-sub mono">{shorten(passkey.keyHash, 10, 8)}</span>
                <span className="item-sub faint">enrolled {timeAgo(passkey.createdAt)}</span>
              </div>
              <button
                className="link"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await call('PASSKEY_REMOVE', { id: passkey.id });
                    await load();
                  })
                }
              >
                remove
              </button>
            </div>
          ))
        )}

        <label className="field">
          <span>Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Laptop passkey" maxLength={40} />
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        <button
          className="ghost"
          disabled={busy}
          onClick={() =>
            run(async () => {
              // Called in-page: WebAuthn is unavailable to the service worker.
              await enrollPasskey({ label });
              setLabel('');
              await load();
            })
          }
        >
          {busy ? 'Waiting for the authenticator…' : 'Enrol a passkey'}
        </button>
        <p className="small faint">
          The credential is bound to this extension, so no website can use it and it cannot use a website's.
        </p>
      </div>
    </>
  );
}
