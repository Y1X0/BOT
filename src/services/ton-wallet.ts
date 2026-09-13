/**
 * TON wallet signer — the ONLY place the mnemonic is used. It builds the
 * TON-Connect account/device descriptors Fragment needs, and broadcasts exactly
 * the messages Fragment returns (never amounts we compute ourselves). Loaded
 * lazily so the mnemonic is only touched when auto-buy actually runs.
 */
import { TonClient, WalletContractV4, internal, SendMode } from '@ton/ton';
import { Address, Cell, beginCell, storeStateInit } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { env } from '../config/env';
import { logger } from '../core/logger';

const log = logger.child({ mod: 'ton-wallet' });

async function keyPair() {
  const words = (env.TON_MNEMONIC ?? '').trim().split(/\s+/);
  return mnemonicToPrivateKey(words);
}

async function wallet() {
  const kp = await keyPair();
  const w = WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey });
  return { w, kp };
}

function client(): TonClient {
  const base = env.TON_API_BASE.replace(/\/+$/, '');
  return new TonClient({ endpoint: `${base}/jsonRPC`, apiKey: env.TON_API_KEY });
}

/** TON-Connect `account` + `device` params Fragment's getBuyStarsLink expects. */
export async function tonConnectDescriptors(): Promise<{ walletAccountParam: string; deviceParam: string }> {
  const { w, kp } = await wallet();
  const stateInit = beginCell().store(storeStateInit(w.init)).endCell();
  const account = {
    address: w.address.toRawString(),
    chain: '-239', // TON mainnet
    walletStateInit: stateInit.toBoc().toString('base64'),
    publicKey: kp.publicKey.toString('hex'),
  };
  const device = {
    platform: 'web',
    appName: 'telegram-wallet',
    appVersion: '1.0.0',
    maxProtocolVersion: 2,
    features: ['SendTransaction', { name: 'SendTransaction', maxMessages: 4 }],
  };
  return { walletAccountParam: JSON.stringify(account), deviceParam: JSON.stringify(device) };
}

/** Broadcast the exact internal messages Fragment returned. */
export async function sendMessages(
  messages: { address: string; amount: string; payload?: string }[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { w, kp } = await wallet();
    const contract = client().open(w);
    const seqno = await contract.getSeqno();
    const internals = messages.map((m) =>
      internal({
        to: Address.parse(m.address),
        value: BigInt(m.amount),
        body: m.payload ? Cell.fromBase64(m.payload) : undefined,
        bounce: true,
      }),
    );
    await contract.sendTransfer({
      seqno,
      secretKey: kp.secretKey,
      messages: internals,
      sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    });
    log.info({ count: internals.length, seqno }, 'ton transfer broadcast');
    return { ok: true };
  } catch (err) {
    log.error({ err }, 'sendMessages failed');
    return { ok: false, error: String(err).slice(0, 160) };
  }
}

/** The bot's receiving address (for display), derived from the mnemonic when the
 *  explicit TON_WALLET_ADDRESS isn't set. */
export async function walletAddress(): Promise<string | null> {
  if (env.TON_WALLET_ADDRESS) return env.TON_WALLET_ADDRESS;
  if (!env.TON_MNEMONIC) return null;
  try {
    const { w } = await wallet();
    return w.address.toString({ bounceable: false });
  } catch {
    return null;
  }
}
