// One-off: create the Coinbase CDP server wallet that receives the USDC, and print its address.
// Run it once by hand, then put the printed address in WALLET_ADDRESS (.env.local and the
// production secrets). The server deliberately never creates wallets itself, so the receiving
// address stays stable and under Jeff's control.
//
//   npx tsx --env-file=.env.local scripts/create-wallet.ts
//
// Needs CDP_API_KEY and CDP_API_SECRET (a Secret API key from the CDP portal), plus
// CDP_WALLET_SECRET: the CDP SDK requires it to create accounts. It is only used by this script,
// the server never reads it. Safe to re-run: the account is fetched by name, not created twice.
import { CdpClient } from '@coinbase/cdp-sdk';

const ACCOUNT_NAME = 'phone-intel-mcp-receiver';

const { CDP_API_KEY, CDP_API_SECRET, CDP_WALLET_SECRET } = process.env;
const missing = Object.entries({ CDP_API_KEY, CDP_API_SECRET, CDP_WALLET_SECRET })
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missing.length > 0) {
  console.error(`Missing ${missing.join(', ')}. Set them in .env.local (see .env.example).`);
  process.exit(1);
}

const cdp = new CdpClient({
  apiKeyId: CDP_API_KEY,
  apiKeySecret: CDP_API_SECRET,
  walletSecret: CDP_WALLET_SECRET,
});
const account = await cdp.evm.getOrCreateAccount({ name: ACCOUNT_NAME });

console.log(`CDP server wallet "${ACCOUNT_NAME}" (same address on Base and Base-Sepolia):`);
console.log(account.address);
console.log('Set it as WALLET_ADDRESS in .env.local and in the production secrets.');
