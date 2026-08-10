// Stub for the Jupiter swap API and the Solana RPC, so the live execution path
// can be exercised without a wallet, a node, or real funds.
//
// The order endpoint returns a genuinely signable VersionedTransaction, so the
// bot's deserialize -> sign -> serialize path runs for real rather than being
// skipped.

import http from 'node:http';
import {
  Keypair, PublicKey, VersionedTransaction, TransactionMessage,
  SystemProgram,
} from '@solana/web3.js';

const PORT = Number(process.env.SWAP_STUB_PORT || 4000);
const TAKER = process.env.STUB_TAKER;           // wallet pubkey the bot signs with
const BALANCE_LAMPORTS = Number(process.env.STUB_BALANCE_LAMPORTS || 2_000_000_000);
const OUTPUT_AMOUNT = process.env.STUB_OUTPUT_AMOUNT ?? '123456789';
const SELL_LAMPORTS = process.env.STUB_SELL_LAMPORTS ?? '75000000';

export const calls = [];

function unsignedTransactionBase64(payer) {
  // A minimal but real transaction: one self-transfer. Enough for the bot to
  // deserialize, sign with its keypair, and re-serialize.
  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [SystemProgram.transfer({
      fromPubkey: new PublicKey(payer),
      toPubkey: new PublicKey(payer),
      lamports: 1,
    })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const send = (payload, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // ── Jupiter swap ────────────────────────────────────────────────────────
    if (url.pathname.endsWith('/order')) {
      const taker = url.searchParams.get('taker') || TAKER;
      const isSell = url.searchParams.get('inputMint') !== 'So11111111111111111111111111111111111111112';
      calls.push({ kind: 'order', side: isSell ? 'sell' : 'buy', amount: url.searchParams.get('amount') });
      return send({
        requestId: `req-${calls.length}`,
        transaction: unsignedTransactionBase64(taker),
        outAmount: isSell ? SELL_LAMPORTS : OUTPUT_AMOUNT,
      });
    }

    if (url.pathname.endsWith('/execute')) {
      const parsed = JSON.parse(body || '{}');
      const signed = Buffer.from(parsed.signedTransaction || '', 'base64');
      let signatureCount = 0;
      try {
        signatureCount = VersionedTransaction.deserialize(signed).signatures
          .filter(sig => sig.some(byte => byte !== 0)).length;
      } catch { /* reported below as 0 */ }
      const previous = calls.filter(c => c.kind === 'order').at(-1);
      calls.push({ kind: 'execute', signatures: signatureCount, side: previous?.side });
      return send({
        status: 'Success',
        signature: `sig-${calls.length}`,
        outputAmountResult: previous?.side === 'sell' ? SELL_LAMPORTS : OUTPUT_AMOUNT,
      });
    }

    // ── Solana JSON-RPC ─────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/') {
      const rpc = JSON.parse(body || '{}');
      const reply = (result) => send({ jsonrpc: '2.0', id: rpc.id, result });
      calls.push({ kind: 'rpc', method: rpc.method });
      if (rpc.method === 'getBalance') {
        return reply({ context: { slot: 1 }, value: BALANCE_LAMPORTS });
      }
      if (rpc.method === 'getTokenAccountsByOwner') {
        return reply({
          context: { slot: 1 },
          value: [{
            pubkey: Keypair.generate().publicKey.toBase58(),
            account: {
              data: { parsed: { info: { tokenAmount: { amount: OUTPUT_AMOUNT, decimals: 6, uiAmount: 123.456789, uiAmountString: '123.456789' } } }, program: 'spl-token', space: 165 },
              executable: false, lamports: 2039280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0,
            },
          }],
        });
      }
      if (rpc.method === 'getLatestBlockhash') {
        return reply({ context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 } });
      }
      return reply(null);
    }

    send({}, 404);
  });
});

server.listen(PORT, () => console.log(`[swapstub] listening on ${PORT}`));
process.on('SIGTERM', () => {
  console.log('[swapstub] calls:', JSON.stringify(calls));
  process.exit(0);
});
