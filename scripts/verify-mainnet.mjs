#!/usr/bin/env node
// Post-deploy mainnet smoke: pay 0.03 USDC on Base to the live server and confirm settlement.
// Usage: X402_TEST_PAYER_PRIVATE_KEY=$(cat .test-payer-key) node scripts/verify-mainnet.mjs

import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const URL = 'https://phone-intel-mcp.fly.dev/lookup/%2B15165551234';
const EXPECTED_NETWORK = 'eip155:8453';
const EXPECTED_AMOUNT = '30000'; // 0.03 USDC, 6 decimals

const fail = (reason) => {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
};

const key = process.env.X402_TEST_PAYER_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  fail('X402_TEST_PAYER_PRIVATE_KEY env var is missing or not a 0x-prefixed 32-byte hex string');
}

// 1. GET the 402 challenge so we sign against the server's advertised requirements, not a guess.
const challengeRes = await fetch(URL);
if (challengeRes.status !== 402) {
  fail(`expected 402 on unpaid GET, got ${challengeRes.status}`);
}
const paymentRequiredHeader = challengeRes.headers.get('payment-required');
if (!paymentRequiredHeader) fail('402 response has no payment-required header');
let required;
try {
  required = decodePaymentRequiredHeader(paymentRequiredHeader);
} catch (err) {
  fail(`could not decode payment-required header: ${err.message}`);
}
if (required.x402Version !== 2) fail(`expected x402Version: 2, got ${required.x402Version}`);
const requirements = required.accepts?.[0];
if (!requirements) fail('challenge accepts[] is empty');
if (requirements.network !== EXPECTED_NETWORK) {
  fail(`expected mainnet network ${EXPECTED_NETWORK}, got ${requirements.network}`);
}
if (requirements.amount !== EXPECTED_AMOUNT) {
  fail(`expected amount ${EXPECTED_AMOUNT} (0.03 USDC), got ${requirements.amount}`);
}

// 2. Sign the EIP-3009 authorization against those exact requirements.
const account = privateKeyToAccount(key);
const scheme = new ExactEvmScheme(account);
const result = await scheme.createPaymentPayload(2, requirements);
const paymentHeader = encodePaymentSignatureHeader({ ...result, accepted: requirements });

// 3. Replay the request with the payment attached.
const paidRes = await fetch(URL, { headers: { 'PAYMENT-SIGNATURE': paymentHeader } });
if (paidRes.status !== 200) {
  const body = await paidRes.text();
  const snippet = body.length > 300 ? body.slice(0, 300) + '…' : body;
  fail(`expected 200 after payment, got ${paidRes.status}. body: ${snippet}`);
}

// 4. Decode the settlement from the payment-response header (v2 name; x-payment-response is the
// v1 compat alias and carries the same value).
const settlementHeader = paidRes.headers.get('payment-response') ?? paidRes.headers.get('x-payment-response');
if (!settlementHeader) fail('200 response has no payment-response header');
let settlement;
try {
  settlement = decodePaymentResponseHeader(settlementHeader);
} catch (err) {
  fail(`could not decode payment-response header: ${err.message}`);
}
if (!settlement.success) {
  fail(`settlement.success is false: ${settlement.errorReason ?? 'unknown'}`);
}
if (!/^0x[0-9a-f]{64}$/i.test(settlement.transaction)) {
  fail(`settlement.transaction is not a 32-byte hex tx hash: ${settlement.transaction}`);
}

const output = {
  txHash: settlement.transaction,
  basescanUrl: `https://basescan.org/tx/${settlement.transaction}`,
  status: paidRes.status,
  network: settlement.network,
  payer: settlement.payer,
  from: account.address,
};
console.log(JSON.stringify(output, null, 2));
