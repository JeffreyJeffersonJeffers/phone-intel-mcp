// Daily check for USDC transfers to the receiving wallet. Reads Transfer events on Base's public
// RPC and sends Jeff a Gmail email when any transfer landed in the last window. Silent on days
// with no customer activity.
//
// Setup (one-time):
//   1. On the Google account you want to send from, turn on 2-Step Verification.
//   2. Generate a Gmail App Password at https://myaccount.google.com/apppasswords (name it
//      something like "phone-intel-mcp wallet-watcher"). Copy the 16-char password.
//   3. Add two GitHub repo secrets:
//        GMAIL_USER         — the Gmail address that will BE the sender (e.g. jeffrey.shaw4@gmail.com)
//        GMAIL_APP_PASSWORD — the 16-char app password from step 2
//   4. Optional: NOTIFY_EMAIL secret — the address to deliver to. Defaults to GMAIL_USER.
//
// Run locally for a smoke test:
//   GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=xxxx NOTIFY_EMAIL=you@gmail.com \
//     node scripts/wallet-watcher.mjs
// Pass DRY_RUN=1 to print the email body without sending.

import nodemailer from 'nodemailer';

// Public Base RPCs. We rotate on rate-limit errors; order picks the one that has been most
// generous with eth_getLogs windows in practice.
const RPCS = [
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
  'https://1rpc.io/base',
  'https://mainnet.base.org',
];
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WALLET = '0x921f9ad89600518D16e33Ae5e0cEd069e355F4dE';
// Transfer(address,address,uint256) topic 0.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Topic-encoded addresses are 32 bytes, left-padded with zeros.
const WALLET_TOPIC = '0x000000000000000000000000' + WALLET.slice(2).toLowerCase();
// Base block time ~2 s → 1800 blocks/hour. 25 h gives a 1 h overlap with yesterday's run.
const WINDOW_HOURS = 25;
const BLOCKS_PER_HOUR = 1800;
const WINDOW_BLOCKS = BigInt(WINDOW_HOURS * BLOCKS_PER_HOUR);
// Public RPCs cap eth_getLogs ranges and req/sec. 1000 blocks is the safest universal cap.
const CHUNK = 1000n;
// Our own test payer. Flagged in the email body but not filtered — a tx from this address means
// we hit the service ourselves, not a real customer.
const TEST_PAYER = '0xc6d4ffab1bfd5a2976d90fca6ebb32c2b1a16935';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  let lastErr;
  // Try each endpoint up to 3 times, rotating on rate-limit errors.
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const endpoint of RPCS) {
      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        if (!r.ok) { lastErr = new Error(`${endpoint}: HTTP ${r.status}`); continue; }
        const j = await r.json();
        if (j.error) {
          lastErr = new Error(`${endpoint}: ${j.error.message}`);
          if (/limit|rate|too many/i.test(j.error.message)) continue;
          throw lastErr;
        }
        return j.result;
      } catch (e) {
        lastErr = e;
      }
    }
    await sleep(500 * (attempt + 1));
  }
  throw lastErr ?? new Error(`${method} rpc: all endpoints failed`);
}

const hex = (n) => '0x' + n.toString(16);
const unhex = (s) => BigInt(s);
const topicAddr = (topic) => '0x' + topic.slice(26);
const toUsd = (atoms) => (Number(atoms) / 1_000_000).toFixed(6).replace(/\.?0+$/, (m) => (m === '.000000' ? '' : m));

async function main() {
  const head = unhex(await rpc('eth_blockNumber', []));
  const from = head - WINDOW_BLOCKS;
  console.log(`Scanning Transfer→${WALLET} on USDC, blocks ${from}..${head} (${WINDOW_HOURS}h window)`);

  const logs = [];
  for (let start = from; start <= head; start += CHUNK) {
    const end = start + CHUNK - 1n > head ? head : start + CHUNK - 1n;
    const page = await rpc('eth_getLogs', [{
      address: USDC,
      topics: [TRANSFER_TOPIC, null, WALLET_TOPIC],
      fromBlock: hex(start),
      toBlock: hex(end),
    }]);
    logs.push(...page);
  }

  if (logs.length === 0) {
    console.log('No transfers in window. Silent.');
    return;
  }

  let realCount = 0;
  const rows = [];
  for (const l of logs) {
    const from = topicAddr(l.topics[1]).toLowerCase();
    const value = BigInt(l.data);
    const isTest = from === TEST_PAYER;
    if (!isTest) realCount++;
    rows.push({ from, value, tx: l.transactionHash, block: unhex(l.blockNumber), isTest });
  }

  // Stay silent when the only activity is our own smoke tests. Jeff wants to hear about
  // customers, not his own call history. DRY_RUN still prints so a maintainer can see state.
  if (realCount === 0 && !process.env.DRY_RUN) {
    console.log(`${logs.length} test-wallet transfer${logs.length === 1 ? '' : 's'} only. Silent.`);
    return;
  }

  const total = logs.reduce((s, l) => s + BigInt(l.data), 0n);
  const totalUsd = toUsd(total);

  const headline = realCount > 0
    ? `${realCount} new lookup${realCount === 1 ? '' : 's'} from the wild`
    : `${logs.length} test lookup${logs.length === 1 ? '' : 's'} (no customers yet)`;

  const subject = realCount > 0
    ? `Wallet report: ${realCount} new lookup${realCount === 1 ? '' : 's'} ($${totalUsd})`
    : `Wallet report: ${logs.length} test lookup${logs.length === 1 ? '' : 's'} ($${totalUsd})`;

  const textBody = [
    headline,
    '',
    `${logs.length} transfer${logs.length === 1 ? '' : 's'} of USDC to ${WALLET} in the last ${WINDOW_HOURS} hours. Total: $${totalUsd} USDC.`,
    '',
    ...rows.map((r) => {
      const flag = r.isTest ? ' (test wallet)' : '';
      const fromShort = r.from.slice(0, 10) + '…' + r.from.slice(-4);
      return `  $${toUsd(r.value)} from ${fromShort}${flag}  —  https://basescan.org/tx/${r.tx}`;
    }),
    '',
    `BaseScan wallet view: https://basescan.org/address/${WALLET}`,
    '',
    'Automated daily report. Days with no activity are silent.',
  ].join('\n');

  const htmlRows = rows.map((r) => {
    const flag = r.isTest ? ' <span style="color:#888">(test wallet)</span>' : '';
    const txShort = r.tx.slice(0, 10) + '…';
    const fromShort = r.from.slice(0, 10) + '…' + r.from.slice(-4);
    return `<tr>
      <td style="padding:4px 10px"><a href="https://basescan.org/tx/${r.tx}"><code>${txShort}</code></a></td>
      <td style="padding:4px 10px"><code>${fromShort}</code>${flag}</td>
      <td style="padding:4px 10px;text-align:right">$${toUsd(r.value)}</td>
      <td style="padding:4px 10px;text-align:right">${r.block}</td>
    </tr>`;
  }).join('\n');

  const htmlBody = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;color:#222;max-width:680px">
    <h2 style="margin:0 0 8px 0">${headline}</h2>
    <p style="margin:0 0 12px 0"><strong>${logs.length} transfer${logs.length === 1 ? '' : 's'}</strong> of USDC to <code>${WALLET}</code> in the last ${WINDOW_HOURS} hours. <strong>Total: $${totalUsd} USDC.</strong></p>
    <table style="border-collapse:collapse;border:1px solid #ddd;font-size:13px">
      <thead><tr style="background:#f5f5f5;text-align:left">
        <th style="padding:6px 10px">Tx</th>
        <th style="padding:6px 10px">From</th>
        <th style="padding:6px 10px;text-align:right">USDC</th>
        <th style="padding:6px 10px;text-align:right">Block</th>
      </tr></thead>
      <tbody>${htmlRows}</tbody>
    </table>
    <p style="margin-top:12px"><a href="https://basescan.org/address/${WALLET}">BaseScan wallet view</a></p>
    <p style="color:#888;font-size:12px">Automated daily report. Days with no activity are silent.</p>
  </div>`;

  console.log(`Preparing email: "${subject}"`);

  if (process.env.DRY_RUN) {
    console.log('--- DRY RUN ---');
    console.log(textBody);
    return;
  }

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const to = process.env.NOTIFY_EMAIL || user;
  if (!user || !pass) throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD required');

  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  const info = await transport.sendMail({
    from: `"phone-intel-mcp watcher" <${user}>`,
    to,
    subject,
    text: textBody,
    html: htmlBody,
  });

  console.log(`Sent email to ${to}: messageId=${info.messageId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
