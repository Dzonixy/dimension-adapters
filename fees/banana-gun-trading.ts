import ADDRESSES from '../helpers/coreAssets.json'
import { Dependencies, FetchOptions, SimpleAdapter } from "../adapters/types";
import { CHAIN } from "../helpers/chains";
import { queryDuneSql } from "../helpers/dune";
import { METRIC } from "../helpers/metrics";

const contract_address: any = {
  [CHAIN.BLAST]: '0x461efe0100be0682545972ebfc8b4a13253bd602',
  [CHAIN.BASE]: '0x1fba6b0bbae2b74586fba407fb45bd4788b7b130',
  [CHAIN.ETHEREUM]: '0x3328f7f4a1d1c57c35df56bbf0c9dcafca309c49',
  [CHAIN.SONIC]: '0xdc13700db7f7cda382e10dba643574abded4fd5b',
  [CHAIN.BSC]: '0x461efe0100be0682545972ebfc8b4a13253bd602',
  [CHAIN.UNICHAIN]: '0x461efe0100be0682545972ebfc8b4a13253bd602'
}

// Current production swap-fee recipients
// (solana-backend: internal/indexer/swap/types.go:103-108, and cmd/create_fee_atas/main.go)
const SOL_FEE_WALLETS = [
  '47hEzz83VFR23rLTEeVm9A7eFzjJwjvdupPPmX3cePqF',
  '3spK1TmrAnFUDRN2bErDAVw225tLE7uFpQeP9WNXP2nY',
  'JBok73TJsWdgeJy2x59TaTFKtngtxeYPvizafTnhvMGV',
  '6nPV8EChoA3HUZRbFmM6cXDv41NApX9ALKwDw4vYfjWp',
  '35q8cao77A8ceJVxQaoN5w9kyTjTJUsmQcy2RRNrJBMc',
  '36ZCrKd6N9iGmArccia15saDyepL5wShHJyGTvea3Akf',
];

// Legacy wallets from the original adapter, kept so the historical series stays continuous.
const LEGACY_SOL_FEE_WALLETS = [
  '4BBNEVRgrxVKv9f7pMNE788XM1tt379X9vNjpDH2KCL7',
  '8r2hZoDfk5hDWJ1sDujAi2Qr45ZyZw5EQxAXiMZWLKh2',
];

const ALL_FEE_WALLETS = [...SOL_FEE_WALLETS, ...LEGACY_SOL_FEE_WALLETS];

// Supported SPL fee mints (bg-blockchain-api/pkg/bg_supported_tokens/solana.go).
const FEE_MINTS = [
  'So11111111111111111111111111111111111111112', // WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',  // USD1
  'soKqZS9pASwBNS46G388nhK7XVtPaTyReffXEd3zora', // ZORA
];

const quoted = (xs: string[]) => xs.map(s => `'${s}'`).join(', ');

const fethcFeesSolana = async (_: any, _1: any, options: FetchOptions) => {
  const dailyFees = options.createBalances();

  const walletsIn = quoted(ALL_FEE_WALLETS);
  const mintsIn = quoted(FEE_MINTS);
  const timeLo = `from_unixtime(${options.startTimestamp})`;
  const timeHi = `from_unixtime(${options.endTimestamp})`;

  // Signer filter (t.signer NOT IN wallets) replaces the old dex_solana.trades gate:
  // Dune does not decode Banana's MultiSwap instruction, so the trade join dropped ~38%
  // of real fee receipts. Signer filter keeps user-initiated swaps and excludes any admin
  // rebalancing between wallets.
  const query = `
    WITH
    solFeePayments AS (
      SELECT
        aa.tx_id,
        aa.balance_change AS raw_amount,
        '${ADDRESSES.solana.SOL}' AS mint
      FROM solana.account_activity aa
      INNER JOIN solana.transactions t ON aa.tx_id = t.id
      WHERE aa.block_time >= ${timeLo}
        AND aa.block_time <= ${timeHi}
        AND t.block_time >= ${timeLo}
        AND t.block_time <= ${timeHi}
        AND aa.tx_success
        AND aa.address IN (${walletsIn})
        AND aa.balance_change > 0
        AND t.signer NOT IN (${walletsIn})
    ),
    tokenFeePayments AS (
      SELECT
        tr.tx_id,
        tr.amount AS raw_amount,
        tr.token_mint_address AS mint
      FROM tokens_solana.transfers tr
      INNER JOIN solana.transactions t ON tr.tx_id = t.id
      WHERE tr.block_time >= ${timeLo}
        AND tr.block_time <= ${timeHi}
        AND t.block_time >= ${timeLo}
        AND t.block_time <= ${timeHi}
        AND tr.to_owner IN (${walletsIn})
        AND tr.token_mint_address IN (${mintsIn})
        AND t.signer NOT IN (${walletsIn})
    ),
    allFeePayments AS (
      SELECT tx_id, raw_amount, mint FROM solFeePayments
      UNION ALL
      SELECT tx_id, raw_amount, mint FROM tokenFeePayments
    ),
    perTxMint AS (
      SELECT tx_id, mint, MAX(raw_amount) AS raw_amount
      FROM allFeePayments
      GROUP BY tx_id, mint
    )
    SELECT mint, SUM(raw_amount) AS amount
    FROM perTxMint
    GROUP BY mint
  `;

  const rows = await queryDuneSql(options, query);
  for (const row of rows) {
    if (row.amount != null) {
      dailyFees.add(row.mint, Number(row.amount), METRIC.TRADING_FEES);
    }
  }

  return { dailyFees, dailyRevenue: dailyFees, dailyProtocolRevenue: dailyFees }
}

const fetch = async (_: any, _1: any, options: FetchOptions) => {
  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances();
  const logs = await options.getLogs({
    topic: '0x72015ace03712f361249380657b3d40777dd8f8a686664cab48afd9dbbe4499f',
    target: contract_address[options.chain],
  });
  logs.map((log: any) => {
    const data = log.data.replace('0x', '');
    const gasToken = data.slice(0, 64);
    dailyFees.addGasToken(Number('0x' + gasToken), METRIC.TRADING_FEES);
    dailyRevenue.addGasToken(Number('0x' + gasToken), METRIC.TRADING_FEES);
  });
  return {
    dailyFees,
    dailyRevenue,
    dailyProtocolRevenue: dailyRevenue,
  }
}

const methodology = {
  Fees: 'All trading fees paid by users for using Banana Bot.',
  Revenue: 'Fees collected by Banana Bot protocol.',
  ProtocolRevenue: 'Fees collected by Banana Bot protocol.',
}

const breakdownMethodology = {
  Fees: {
    [METRIC.TRADING_FEES]: 'Trading fees charged on each trade executed through Banana Gun bot.',
  },
  Revenue: {
    [METRIC.TRADING_FEES]: 'Trading fees collected by Banana Gun protocol.',
  },
}

const adapter: SimpleAdapter = {
  version: 1,
  fetch,
  adapter: {
    [CHAIN.ETHEREUM]: { start: '2023-06-01', },
    [CHAIN.SOLANA]: {
      fetch: fethcFeesSolana,
      start: '2023-06-01',
    },
    [CHAIN.BLAST]: { start: '2023-06-01', },
    [CHAIN.BASE]: { start: '2023-06-01', },
    [CHAIN.SONIC]: { start: '2024-12-16', },
    [CHAIN.BSC]: { start: '2024-03-15', },
    [CHAIN.UNICHAIN]: { start: '2025-02-10', },
  },
  dependencies: [Dependencies.DUNE],
  methodology,
  breakdownMethodology,
  isExpensiveAdapter: true,
};

export default adapter;
