// ABI fragments, human-readable (viem parseAbi). BOARD_HR follows BRIEF "Contract KeelBoard" + contracts/src/KeelBoard.sol;
// config.mjs prefers the generated ABI (contracts/abi/KeelBoard.json, contracts/out/KeelBoard.sol/KeelBoard.json or
// web/contracts.json abi.board) when it exists. Pons V2 / Uniswap V3 fragments are fixed (verified sources, 161 PONS-FEES).
import { parseAbi } from 'viem'

export const BOARD_HR = [
  'struct Question { uint64 postedAt; uint64 closesAt; uint8 tier; uint8 status; bytes32 answerHash; bytes32 textHash; uint256 load; address winner; uint32 winnerIndex; uint32 commits; }',
  'struct Commit { address solver; bytes32 hash; uint64 at; uint256 bond; bytes32 model; bool revealed; bytes32 answer; }',
  'function harvest()',
  'function drip()',
  'function post(bytes32 answerHash, bytes32 textHash, uint8 tier, uint64 closesAt) returns (uint256 id)',
  'function topUp(uint256 id) payable',
  'function bondFor(uint256 id) view returns (uint256)',
  'function commit(uint256 id, bytes32 commitHash, bytes32 model) payable returns (uint256 i)',
  'function reveal(uint256 id, uint256 i, bytes32 answer, bytes32 nonce)',
  'function settle(uint256 id, bytes32 answer, bytes32 salt)',
  'function claim()',
  'function questionOf(uint256 id) view returns (Question)',
  'function commitOf(uint256 id, uint256 i) view returns (Commit)',
  'function openIds() view returns (uint256[])',
  'function stats() view returns (uint256 pool, uint256 infra, uint256 totalLoad, uint256 lastDrip, uint256 count)',
  'function owed(address) view returns (uint256)',
  'function nextDripAt() view returns (uint256)',
  'function MIN_BOND() view returns (uint256)',
  'function poster() view returns (address)',
  'function paused() view returns (bool)',
  'function token() view returns (address)',
  'error EarlierCommitPending(uint256 i)',
  'error NotClosed(uint256 id)',
  'error NotOpen(uint256 id)',
  'error TooEarly()',
  'error NothingOpen()',
  'error BadAnswer()',
  'error TooManyOpen()',
  'error IsPaused()',
  'error NotPoster()',
  'error BadParams()',
  'event Harvested(uint256 amount, uint256 toPool, uint256 toInfra)',
  'event Dripped(uint256 total, uint256 perQuestion, uint256 count)',
  'event Posted(uint256 indexed id, bytes32 answerHash, bytes32 textHash, uint8 tier, uint64 closesAt)',
  'event ToppedUp(uint256 indexed id, address indexed from, uint256 amount)',
  'event Committed(uint256 indexed id, uint256 i, address indexed solver, bytes32 hash, uint256 bond, bytes32 model)',
  'event Revealed(uint256 indexed id, uint256 i, address indexed solver, bytes32 answer)',
  'event Settled(uint256 indexed id, bytes32 answer, bytes32 salt, address indexed winner, uint256 winnerIndex, uint256 amount)',
  'event Abandoned(uint256 indexed id, uint256 loadToPool, uint256 bondsRefunded)',
  'event Claimed(address indexed to, uint256 amount)',
  'event Paused(bool paused)',
]
export const PONS_FACTORY_HR = [
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
]
export const CURVE_HR = [
  'function creatorTaxBalance() view returns (uint256)',
  'function quoteFeeBalance() view returns (uint256)',
  'function buybackQuoteBalance() view returns (uint256)',
  'function protocolFeeShareBps() view returns (uint16)',
]
export const HOOK_HR = [
  'function pendingFees(bytes32 poolId, address currency) view returns (uint256)',
  'function pendingCreatorTax(bytes32 poolId, address currency) view returns (uint256)',
  'function pendingBuyback(bytes32 poolId, address currency) view returns (uint256)',
  'function protocolFeeShareBps() view returns (uint256)',
]
export const ESCROW_HR = [
  'function balanceOf(address recipient) view returns (uint256)',
  'event Claimed(address indexed recipient, uint256 amount)',
  'event Credited(address indexed recipient, address indexed depositor, uint256 amount)',
]

export const BOARD_ABI = parseAbi(BOARD_HR)
export const PONS_FACTORY_ABI = parseAbi(PONS_FACTORY_HR)
export const CURVE_ABI = parseAbi(CURVE_HR)
export const HOOK_ABI = parseAbi(HOOK_HR)
export const ESCROW_ABI = parseAbi(ESCROW_HR)
