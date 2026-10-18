// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    PonsLaunchedToken,
    IPonsV2LaunchFactory,
    IPonsV2BondingCurve,
    IPonsV2MemeHook,
    IPonsV2FeeEscrow
} from "./interfaces/IPons.sol";

/// @title KeelBoard — an hourly question about Robinhood Chain data; the earliest correct commit-reveal takes the bounty.
/// @notice The board is the Pons V2 `creatorFeeRecipient` of the token (or receives the creator fees by plain transfer:
/// manual mode). Every incoming wei is split POOL / INFRA (8000 / 2000). Once per clock hour `drip()` moves 1% of the pool
/// in equal parts onto the live Open questions (their `load` = bounty). The poster key posts a question as
/// `answerHash = keccak256(abi.encode(id, answer, salt))` before anyone can reply. Solvers `commit` a hashed answer
/// (`keccak256(abi.encode(id, solver, answer, nonce))`) with a bond, then `reveal` it from the next second on and within
/// 10 minutes. `settle(id, answer, salt)` (poster) opens the answer; the CONTRACT picks the winner: the lowest commit
/// index whose revealed answer equals it, once every earlier commit is revealed or past its reveal window.
///
/// Money rules: ETH leaves only through `claim()` (owed[msg.sender]: bounties and refunded bonds) and `withdrawInfra`
/// (owner, infra share only). The pool moves only by drip (pool → load) and settle (load / forfeited bonds → pool,
/// load + bond → owed). Accounting identity (tested as an invariant):
///   address(this).balance == pool + infra + Σ load(Open) + Σ unsettled bonds + Σ owed
/// (ETH forced in without a call — selfdestruct — is split by the next `harvest()` / incoming transfer.)
///
/// Keys: owner (Ownable2Step; renounce disabled): withdraw infra, bind once, rotate poster/pauser after a 48 h public
/// timelock, unpause. Poster: post, settle (cannot change an answer after posting, cannot pick a winner). Pauser (and
/// owner): pause. Pause stops post / drip / topUp / commit / settle; reveal, claim, harvest, abandon keep working.
///
/// UNAUDITED.
contract KeelBoard is Ownable2Step, ReentrancyGuardTransient {
    // ─────────────────────────────── constants ───────────────────────────────

    uint256 internal constant BPS = 10_000;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice share of incoming fees for infra (the rest goes to the pool)
    uint256 public constant INFRA_BPS = 2000;
    /// @notice share of the pool dripped onto Open questions per drip
    uint256 public constant DRIP_BPS = 100;
    /// @notice one drip per clock slot of this length (floor(timestamp / DRIP_INTERVAL) must advance)
    uint256 public constant DRIP_INTERVAL = 1 hours;
    /// @notice at most this many questions Open (not yet settled) at once
    uint256 public constant MAX_OPEN = 48;
    /// @notice at most this many commits per question
    uint256 public constant MAX_COMMITS = 256;
    /// @notice bond = max(MIN_BOND, load × BOND_BPS / 10000) at commit time
    uint256 public constant BOND_BPS = 500;
    /// @notice a commit must be revealed within this time (and from the next second on)
    uint256 public constant REVEAL_WINDOW = 10 minutes;
    /// @notice poster / pauser rotation delay
    uint256 public constant KEY_TIMELOCK = 48 hours;
    /// @notice a question posted with closesAt further than this in the future is refused
    uint256 public constant MAX_DURATION = 7 days;
    /// @notice an Open question still not settled this long after closesAt can be abandoned by anyone
    uint256 public constant ABANDON_AFTER = 7 days;

    /// @notice minimum bond per commit (immutable)
    uint256 public immutable MIN_BOND;

    // ─────────────────────────────── wiring ───────────────────────────────

    address public immutable ponsFactory;
    address public immutable feeEscrow;
    address public immutable memeHook;

    // ─────────────────────────────── types ───────────────────────────────

    enum Status {
        None,
        Open,
        Solved,
        Unsolved
    }

    /// @dev Storage = view layout (BRIEF field order; packs into 5 slots). `load` stays frozen at its final value after
    /// settle (display); only Open questions count in totalLoad.
    struct Question {
        uint64 postedAt;
        uint64 closesAt;
        uint8 tier;
        Status status;
        bytes32 answerHash;
        bytes32 textHash;
        uint256 load;
        address winner; // 0 while Open and when Unsolved
        uint32 winnerIndex; // 0 while Open and when Unsolved (check winner / status)
        uint32 commits;
    }

    /// @dev View layout (BRIEF field order).
    struct Commit {
        address solver;
        bytes32 hash;
        uint64 at; // block.timestamp of the commit
        uint256 bond;
        bytes32 model; // self-declared model tag (ASCII, right-padded)
        bool revealed;
        bytes32 answer; // 0 until revealed
    }

    /// @dev Packed storage layout of a commit (settle reads slot 0 + bond, and the answer when revealed).
    struct CommitSlot {
        address solver;
        uint64 at;
        bool revealed;
        uint256 bond;
        bytes32 hash;
        bytes32 model;
        bytes32 answer;
    }

    // ─────────────────────────────── state ───────────────────────────────

    address public poster;
    address public pauser;
    bool public paused;
    address public token; // the Pons launch bound by bind() (0 = manual fee mode)

    address public pendingPoster;
    address public pendingPauser;
    uint64 public keysExecutableAt; // 0 = nothing proposed

    uint256 internal _pool;
    uint256 internal _infra;
    uint256 internal _totalLoad; // Σ load of Open questions
    uint256 internal _totalBonds; // Σ bonds of commits on Open questions
    uint256 internal _totalOwed; // Σ owed
    uint256 internal _lastDrip; // timestamp of the last drip
    uint256 internal _count; // questions posted; ids are 1.._count

    // lifetime totals (for the ledger / docs)
    uint256 public harvestedWei;
    uint256 public paidWei; // Σ bounties credited to winners (load only)

    mapping(uint256 id => Question) internal _q;
    mapping(uint256 id => mapping(uint256 i => CommitSlot)) internal _c;
    mapping(address who => uint256) public owed;

    uint256[] internal _open; // ids of Open questions (unordered)
    mapping(uint256 id => uint256) internal _openPos; // index in _open + 1

    // ─────────────────────────────── events ───────────────────────────────

    event Harvested(uint256 amount, uint256 toPool, uint256 toInfra);
    event Dripped(uint256 total, uint256 perQuestion, uint256 count);
    event Posted(uint256 indexed id, bytes32 answerHash, bytes32 textHash, uint8 tier, uint64 closesAt);
    event ToppedUp(uint256 indexed id, address indexed from, uint256 amount);
    event Committed(uint256 indexed id, uint256 i, address indexed solver, bytes32 hash, uint256 bond, bytes32 model);
    event Revealed(uint256 indexed id, uint256 i, address indexed solver, bytes32 answer);
    event Settled(
        uint256 indexed id, bytes32 answer, bytes32 salt, address indexed winner, uint256 winnerIndex, uint256 amount
    );
    event Abandoned(uint256 indexed id, uint256 loadToPool, uint256 bondsRefunded);
    event Claimed(address indexed to, uint256 amount);
    event Paused(bool paused);
    event KeysProposed(address poster, address pauser, uint64 executableAt);
    event KeysAccepted(address poster, address pauser);
    event Bound(address token);
    event Burned(uint256 amount);
    event InfraWithdrawn(address to, uint256 amount);

    // ─────────────────────────────── errors ───────────────────────────────

    error ZeroAddress();
    error NotPoster();
    error NotPauser();
    error IsPaused();
    error BadParams();
    error AlreadyBound();
    error TokenNotFound();
    error NotRecipient();
    error UnsupportedPair();
    error TooEarly();
    error NothingOpen();
    error TooManyOpen();
    error NotOpen(uint256 id);
    error Closed(uint256 id);
    error NotClosed(uint256 id);
    error BadBond(uint256 sent, uint256 required);
    error TooManyCommits();
    error OutOfBounds();
    error NotSolver();
    error AlreadyRevealed();
    error RevealTooEarly();
    error RevealWindowOver();
    error BadReveal();
    error BadAnswer();
    error EarlierCommitPending(uint256 i);
    error NothingToClaim();
    error NothingToWithdraw();
    error TransferFailed();
    error NothingProposed();
    error RenounceDisabled();

    modifier onlyPoster() {
        if (msg.sender != poster) revert NotPoster();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    /// @param owner_ team multisig / wallet (Ownable2Step) · @param poster_ server key (post, settle)
    /// @param pauser_ pause-only key · @param minBond_ minimum bond per commit (wei, > 0)
    /// @param ponsFactory_ PonsV2LaunchFactory · @param feeEscrow_ PonsV2FeeEscrow · @param memeHook_ PonsV2MemeHook
    constructor(
        address owner_,
        address poster_,
        address pauser_,
        uint256 minBond_,
        address ponsFactory_,
        address feeEscrow_,
        address memeHook_
    ) Ownable(owner_) {
        if (
            poster_ == address(0) || pauser_ == address(0) || ponsFactory_ == address(0) || feeEscrow_ == address(0)
                || memeHook_ == address(0)
        ) revert ZeroAddress();
        if (minBond_ == 0) revert BadParams();
        poster = poster_;
        pauser = pauser_;
        MIN_BOND = minBond_;
        ponsFactory = ponsFactory_;
        feeEscrow = feeEscrow_;
        memeHook = memeHook_;
        emit KeysAccepted(poster_, pauser_);
    }

    /// @notice Manual fee mode (and the Pons escrow claim / rescue pushes land here): split 80 / 20 like a harvest.
    /// @dev Needs more than the 2300-gas stipend (send with `call`, as every wallet and the Pons escrow do).
    receive() external payable {
        _sync();
    }

    // ═════════════════════════════ fees ═════════════════════════════

    /// @notice Owner, once (optional, Pons mode only): bind the launch whose creatorFeeRecipient is this board.
    function bind(address ponsToken) external onlyOwner nonReentrant {
        if (token != address(0)) revert AlreadyBound();
        if (ponsToken == address(0)) revert TokenNotFound();
        PonsLaunchedToken memory lt = IPonsV2LaunchFactory(ponsFactory).getLaunchedToken(ponsToken);
        if (!lt.exists || lt.token != ponsToken) revert TokenNotFound();
        if (lt.creatorFeeRecipient != address(this)) revert NotRecipient();
        if (lt.pairToken != address(0)) revert UnsupportedPair();
        token = ponsToken;
        emit Bound(ponsToken);
    }

    /// @notice Pull everything Pons owes the board (curve sweep or hook sweep, then escrow claim), burn any launched
    /// token held, split new ETH 80 / 20. Permissionless; every Pons step is best-effort. Never reverts.
    function harvest() external nonReentrant {
        address t = token;
        if (t != address(0)) {
            try IPonsV2LaunchFactory(ponsFactory).getLaunchedToken(t) returns (PonsLaunchedToken memory lt) {
                if (lt.creatorFeeRecipient == address(this)) {
                    if (lt.phase == 0) {
                        // curve phase: the board is the creator recipient and buyback is off -> it may sweep itself
                        try IPonsV2BondingCurve(lt.curve).sweepFees(0) {} catch {}
                    } else if (lt.phase == 2) {
                        // graduated: works only while no token-denominated fee is pending; otherwise the Pons
                        // operator's own sweep credits the escrow and the claim below collects it
                        try IPonsV2MemeHook(memeHook).sweepPoolFees(_poolIdFor(lt), 0, 0) {} catch {}
                    }
                }
            } catch {}
        }

        IPonsV2FeeEscrow esc = IPonsV2FeeEscrow(feeEscrow);
        try esc.balanceOf(address(this)) returns (uint256 b) {
            if (b != 0) {
                try esc.claim() {} catch {}
            }
        } catch {}

        if (t != address(0)) {
            try esc.balanceOfToken(address(this), t) returns (uint256 b) {
                if (b != 0) {
                    try esc.claimToken(t) {} catch {}
                }
            } catch {}
            _burnHeld(t);
        }

        _sync();
    }

    // ═════════════════════════════ bounty growth ═════════════════════════════

    /// @notice Anyone, once per clock hour, not paused: move pool × DRIP_BPS / 10000 in equal parts onto the Open
    /// questions that have not reached closesAt (the rounding leftover stays in the pool).
    function drip() external nonReentrant whenNotPaused {
        uint256 last = _lastDrip;
        if (last != 0 && block.timestamp / DRIP_INTERVAL <= last / DRIP_INTERVAL) revert TooEarly();
        uint256 n = _open.length;
        uint256 live;
        for (uint256 k; k < n; ++k) {
            if (block.timestamp < _q[_open[k]].closesAt) ++live;
        }
        if (live == 0) revert NothingOpen();
        uint256 per = (_pool * DRIP_BPS) / BPS / live;
        uint256 total = per * live;
        if (total != 0) {
            for (uint256 k; k < n; ++k) {
                Question storage q = _q[_open[k]];
                if (block.timestamp < q.closesAt) q.load += per;
            }
            _pool -= total;
            _totalLoad += total;
        }
        _lastDrip = block.timestamp;
        emit Dripped(total, per, live);
    }

    /// @notice Anyone adds ETH to an Open question's bounty (before closesAt, not paused).
    function topUp(uint256 id) external payable nonReentrant whenNotPaused {
        Question storage q = _openQ(id);
        if (block.timestamp >= q.closesAt) revert Closed(id);
        if (msg.value == 0) revert BadParams();
        q.load += msg.value;
        _totalLoad += msg.value;
        emit ToppedUp(id, msg.sender, msg.value);
    }

    // ═════════════════════════════ questions ═════════════════════════════

    /// @notice Poster: lock a new question. `answerHash = keccak256(abi.encode(id, answer, salt))` where
    /// `id = stats().count + 1`; `textHash = keccak256(canonical question JSON)`.
    function post(bytes32 answerHash, bytes32 textHash, uint8 tier, uint64 closesAt)
        external
        onlyPoster
        nonReentrant
        whenNotPaused
        returns (uint256 id)
    {
        if (answerHash == bytes32(0) || tier == 0) revert BadParams();
        if (closesAt <= block.timestamp || closesAt > block.timestamp + MAX_DURATION) revert BadParams();
        if (_open.length >= MAX_OPEN) revert TooManyOpen();
        id = ++_count;
        Question storage q = _q[id];
        q.postedAt = uint64(block.timestamp);
        q.closesAt = closesAt;
        q.tier = tier;
        q.status = Status.Open;
        q.answerHash = answerHash;
        q.textHash = textHash;
        _open.push(id);
        _openPos[id] = _open.length;
        emit Posted(id, answerHash, textHash, tier, closesAt);
    }

    /// @notice Bond for a commit right now: max(MIN_BOND, load × 5%).
    function bondFor(uint256 id) public view returns (uint256) {
        uint256 b = (_q[id].load * BOND_BPS) / BPS;
        return b > MIN_BOND ? b : MIN_BOND;
    }

    /// @notice Commit `commitHash = keccak256(abi.encode(id, msg.sender, answer, nonce))` with the bond.
    /// @dev `msg.value` must be at least `bondFor(id)`; the bond is exactly `bondFor(id)` and any excess is credited to
    /// `owed[msg.sender]` (claimable), so a drip / top-up landing just before the commit does not make it revert.
    function commit(uint256 id, bytes32 commitHash, bytes32 model)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 i)
    {
        Question storage q = _openQ(id);
        if (block.timestamp >= q.closesAt) revert Closed(id);
        if (commitHash == bytes32(0)) revert BadParams();
        i = q.commits;
        if (i >= MAX_COMMITS) revert TooManyCommits();
        uint256 bond = bondFor(id);
        if (msg.value < bond) revert BadBond(msg.value, bond);
        q.commits = uint32(i + 1);
        CommitSlot storage c = _c[id][i];
        c.solver = msg.sender;
        c.at = uint64(block.timestamp);
        c.bond = bond;
        c.hash = commitHash;
        c.model = model;
        _totalBonds += bond;
        uint256 extra = msg.value - bond;
        if (extra != 0) {
            owed[msg.sender] += extra;
            _totalOwed += extra;
        }
        emit Committed(id, i, msg.sender, commitHash, bond, model);
    }

    /// @notice The committer opens commit `i`: from the second after the commit (a later block) until
    /// REVEAL_WINDOW after it, while the question is Open. Works while paused.
    function reveal(uint256 id, uint256 i, bytes32 answer, bytes32 nonce) external nonReentrant {
        Question storage q = _openQ(id);
        if (i >= q.commits) revert OutOfBounds();
        CommitSlot storage c = _c[id][i];
        if (msg.sender != c.solver) revert NotSolver();
        if (c.revealed) revert AlreadyRevealed();
        if (block.timestamp <= c.at) revert RevealTooEarly();
        if (block.timestamp > c.at + REVEAL_WINDOW) revert RevealWindowOver();
        if (keccak256(abi.encode(id, msg.sender, answer, nonce)) != c.hash) revert BadReveal();
        c.revealed = true;
        c.answer = answer;
        emit Revealed(id, i, msg.sender, answer);
    }

    /// @notice Poster opens the answer; the contract settles. Winner = the lowest commit index whose revealed answer
    /// equals `answer`, once every earlier commit is revealed or past its reveal window (else
    /// `EarlierCommitPending(j)`: retry later). Winner: load + own bond → owed. Later correct reveals: bond → owed.
    /// Wrong and unrevealed bonds → pool. Without a correct reveal: only from closesAt on and once no commit is still
    /// inside its reveal window → Unsolved, load → pool.
    function settle(uint256 id, bytes32 answer, bytes32 salt) external onlyPoster nonReentrant whenNotPaused {
        Question storage q = _openQ(id);
        if (keccak256(abi.encode(id, answer, salt)) != q.answerHash) revert BadAnswer();
        uint256 n = q.commits;
        bool found;
        uint256 w;
        uint256 pending = type(uint256).max; // first commit before the winner still inside its reveal window
        uint256 toPool;
        uint256 bonds;
        for (uint256 i; i < n; ++i) {
            CommitSlot storage c = _c[id][i];
            uint256 bond = c.bond;
            bonds += bond;
            bool correct = c.revealed && c.answer == answer;
            if (!found) {
                if (correct) {
                    if (pending != type(uint256).max) revert EarlierCommitPending(pending);
                    found = true;
                    w = i;
                } else {
                    if (pending == type(uint256).max && !c.revealed && block.timestamp <= c.at + REVEAL_WINDOW) {
                        pending = i;
                    }
                    toPool += bond;
                }
            } else if (correct) {
                _credit(c.solver, bond);
            } else {
                toPool += bond;
            }
        }

        uint256 load = q.load;
        _totalLoad -= load;
        _totalBonds -= bonds;
        _removeOpen(id);
        address winner;
        uint256 amount;
        if (found) {
            winner = _c[id][w].solver;
            amount = load + _c[id][w].bond;
            _credit(winner, amount);
            q.status = Status.Solved;
            q.winner = winner;
            q.winnerIndex = uint32(w);
            paidWei += load;
        } else {
            if (block.timestamp < q.closesAt) revert NotClosed(id);
            if (pending != type(uint256).max) revert EarlierCommitPending(pending);
            q.status = Status.Unsolved;
            toPool += load;
            w = 0;
        }
        _pool += toPool;
        emit Settled(id, answer, salt, winner, w, amount);
    }

    /// @notice Safety valve (anyone): an Open question still not settled ABANDON_AFTER past closesAt (e.g. its salt is
    /// lost) becomes Unsolved: load → pool, every bond refunded to its solver. Works while paused.
    function abandon(uint256 id) external nonReentrant {
        Question storage q = _openQ(id);
        if (block.timestamp < uint256(q.closesAt) + ABANDON_AFTER) revert TooEarly();
        uint256 n = q.commits;
        uint256 bonds;
        for (uint256 i; i < n; ++i) {
            CommitSlot storage c = _c[id][i];
            bonds += c.bond;
            _credit(c.solver, c.bond);
        }
        uint256 load = q.load;
        _totalLoad -= load;
        _totalBonds -= bonds;
        _pool += load;
        _removeOpen(id);
        q.status = Status.Unsolved;
        emit Abandoned(id, load, bonds);
    }

    /// @notice Pull payment of owed[msg.sender] (bounties, refunded bonds, commit overpayments). Works while paused.
    function claim() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        owed[msg.sender] = 0;
        _totalOwed -= amount;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }

    // ═════════════════════════════ keys ═════════════════════════════

    /// @notice Pauser (or owner): stop post / drip / topUp / commit / settle.
    function pause() external {
        if (msg.sender != pauser && msg.sender != owner()) revert NotPauser();
        paused = true;
        emit Paused(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Paused(false);
    }

    /// @notice Owner: the infra share, to any address.
    function withdrawInfra(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = _infra;
        if (amount == 0) revert NothingToWithdraw();
        _infra = 0;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit InfraWithdrawn(to, amount);
    }

    /// @notice Owner: propose new poster / pauser keys; executable by anyone after KEY_TIMELOCK. A new proposal
    /// replaces the previous one and restarts the timelock.
    function proposeKeys(address poster_, address pauser_) external onlyOwner {
        if (poster_ == address(0) || pauser_ == address(0)) revert ZeroAddress();
        uint64 at = uint64(block.timestamp + KEY_TIMELOCK);
        pendingPoster = poster_;
        pendingPauser = pauser_;
        keysExecutableAt = at;
        emit KeysProposed(poster_, pauser_, at);
    }

    /// @notice Anyone, once the timelock has passed: apply the proposed keys.
    function acceptKeys() external {
        uint64 at = keysExecutableAt;
        if (at == 0) revert NothingProposed();
        if (block.timestamp < at) revert TooEarly();
        address p = pendingPoster;
        address z = pendingPauser;
        poster = p;
        pauser = z;
        delete pendingPoster;
        delete pendingPauser;
        delete keysExecutableAt;
        emit KeysAccepted(p, z);
    }

    /// @notice Disabled: without an owner the infra share could never leave and keys could never rotate.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ═════════════════════════════ views ═════════════════════════════

    function questionOf(uint256 id) external view returns (Question memory) {
        return _q[id];
    }

    function commitOf(uint256 id, uint256 i) external view returns (Commit memory) {
        if (i >= _q[id].commits) revert OutOfBounds();
        CommitSlot storage c = _c[id][i];
        return Commit({
            solver: c.solver,
            hash: c.hash,
            at: c.at,
            bond: c.bond,
            model: c.model,
            revealed: c.revealed,
            answer: c.answer
        });
    }

    function openIds() external view returns (uint256[] memory) {
        return _open;
    }

    function stats()
        external
        view
        returns (uint256 pool, uint256 infra, uint256 totalLoad, uint256 lastDrip, uint256 count)
    {
        return (_pool, _infra, _totalLoad, _lastDrip, _count);
    }

    /// @notice Σ bonds held for commits on Open questions, Σ owed (the two remaining terms of the identity).
    function held() external view returns (uint256 totalBonds, uint256 totalOwed) {
        return (_totalBonds, _totalOwed);
    }

    /// @notice First timestamp at which drip() is accepted again (0 = now).
    function nextDripAt() external view returns (uint256) {
        uint256 last = _lastDrip;
        return last == 0 ? 0 : (last / DRIP_INTERVAL + 1) * DRIP_INTERVAL;
    }

    /// @notice Helpers for clients (same formulas as the BRIEF; pure).
    function answerHashOf(uint256 id, bytes32 answer, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encode(id, answer, salt));
    }

    function commitHashOf(uint256 id, address solver, bytes32 answer, bytes32 nonce) external pure returns (bytes32) {
        return keccak256(abi.encode(id, solver, answer, nonce));
    }

    // ═════════════════════════════ internal ═════════════════════════════

    function _openQ(uint256 id) internal view returns (Question storage q) {
        q = _q[id];
        if (q.status != Status.Open) revert NotOpen(id);
    }

    function _credit(address to, uint256 amount) internal {
        if (amount == 0) return;
        owed[to] += amount;
        _totalOwed += amount;
    }

    function _removeOpen(uint256 id) internal {
        uint256 pos = _openPos[id];
        uint256 last = _open.length;
        if (pos != last) {
            uint256 moved = _open[last - 1];
            _open[pos - 1] = moved;
            _openPos[moved] = pos;
        }
        _open.pop();
        delete _openPos[id];
    }

    /// @notice V4 PoolId of a graduated Pons launch: keccak256(abi.encode(PoolKey)).
    function _poolIdFor(PonsLaunchedToken memory lt) internal view returns (bytes32) {
        (address c0, address c1) = lt.pairToken < lt.token ? (lt.pairToken, lt.token) : (lt.token, lt.pairToken);
        return keccak256(abi.encode(c0, c1, lt.poolFee, lt.tickSpacing, memeHook));
    }

    function _burnHeld(address t) internal {
        uint256 bal;
        try IERC20(t).balanceOf(address(this)) returns (uint256 b) {
            bal = b;
        } catch {
            return;
        }
        if (bal != 0) {
            // best effort: a token that refuses the transfer must not block harvest()
            try IERC20(t).transfer(DEAD, bal) returns (bool ok) {
                if (ok) emit Burned(bal);
            } catch {}
        }
    }

    /// @dev Split ETH that is not yet accounted for (fees, manual transfers, forced ETH) 80 / 20 pool / infra.
    function _sync() internal {
        uint256 accounted = _pool + _infra + _totalLoad + _totalBonds + _totalOwed;
        uint256 bal = address(this).balance;
        if (bal <= accounted) return;
        uint256 inc = bal - accounted;
        uint256 toInfra = (inc * INFRA_BPS) / BPS;
        uint256 toPool = inc - toInfra;
        _pool += toPool;
        _infra += toInfra;
        harvestedWei += inc;
        emit Harvested(inc, toPool, toInfra);
    }
}
