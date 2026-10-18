// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {KeelBoard} from "../src/KeelBoard.sol";
import {PonsLaunchedToken} from "../src/interfaces/IPons.sol";
import {MockERC20, MockEscrow, MockPonsFactory, MockCurve, MockHook} from "./mocks/Mocks.sol";

/// Drives the board through random sequences of every state-changing call (fees in three ways, post, drip, topUp,
/// commit, reveal, settle with the true answer, abandon, claim, withdrawInfra, pause / unpause, time).
contract Handler is Test {
    KeelBoard public b;
    MockCurve public curve;
    address public owner;
    address public poster;
    address public pauser;
    address[4] public actors;
    bytes32 constant SALT = keccak256("salt");

    struct C {
        uint256 id;
        uint256 i;
        address solver;
        bytes32 answer;
        bytes32 nonce;
    }

    C[] public commits;
    mapping(uint256 id => bytes32) public truth;
    mapping(bytes4 => uint256) public calls; // successful calls per selector
    uint256 public ethIn; // ETH sent into the board
    uint256 public ethOut; // ETH paid out by the board

    constructor(KeelBoard b_, MockCurve c_, address owner_, address poster_, address pauser_) {
        b = b_;
        curve = c_;
        owner = owner_;
        poster = poster_;
        pauser = pauser_;
        actors = [makeAddr("a0"), makeAddr("a1"), makeAddr("a2"), makeAddr("a3")];
    }

    function actorCount() external pure returns (uint256) {
        return 4;
    }

    function commitCount() external view returns (uint256) {
        return commits.length;
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % 4];
    }

    function _openId(uint256 s) internal view returns (uint256 id, bool ok) {
        uint256[] memory ids = b.openIds();
        if (ids.length == 0) return (0, false);
        return (ids[s % ids.length], true);
    }

    // ── fees ──

    function fund(uint96 amount) external {
        amount = uint96(bound(amount, 1, 100 ether));
        vm.deal(address(this), amount);
        (bool ok,) = address(b).call{value: amount}("");
        require(ok);
        ethIn += amount;
        calls[this.fund.selector]++;
    }

    function curveFees(uint96 amount) external {
        amount = uint96(bound(amount, 1, 10 ether));
        vm.deal(address(this), amount);
        curve.accrue{value: amount}();
        b.harvest();
        ethIn += amount;
        calls[this.curveFees.selector]++;
    }

    function forced(uint96 amount) external {
        amount = uint96(bound(amount, 1, 1 ether));
        vm.deal(address(b), address(b).balance + amount); // no receive(): split by the harvest below
        b.harvest();
        ethIn += amount;
        calls[this.forced.selector]++;
    }

    // ── questions ──

    function post(uint256 seed, uint32 dur) external {
        if (b.openIds().length >= 48) return;
        (,,,, uint256 count) = b.stats();
        uint256 id = count + 1;
        bytes32 answer = bytes32(seed % 3);
        uint64 closesAt = uint64(block.timestamp + bound(dur, 60, 2 days));
        vm.prank(poster);
        try b.post(keccak256(abi.encode(id, answer, SALT)), bytes32(seed), uint8(1 + seed % 3), closesAt) returns (
            uint256 got
        ) {
            assertEq(got, id);
            truth[id] = answer;
            calls[this.post.selector]++;
        } catch {}
    }

    function drip() external {
        try b.drip() {
            calls[this.drip.selector]++;
        } catch {}
    }

    function topUp(uint256 s, uint96 amount) external {
        (uint256 id, bool ok) = _openId(s);
        if (!ok) return;
        amount = uint96(bound(amount, 1, 5 ether));
        address a = _actor(s);
        vm.deal(a, a.balance + amount);
        vm.prank(a);
        try b.topUp{value: amount}(id) {
            ethIn += amount;
            calls[this.topUp.selector]++;
        } catch {}
    }

    function commit(uint256 s, uint256 answerSeed, uint64 extra) external {
        (uint256 id, bool ok) = _openId(s);
        if (!ok) return;
        address a = _actor(s >> 8);
        bytes32 answer = answerSeed % 2 == 0 ? truth[id] : bytes32(answerSeed % 3); // ~2/3 correct
        bytes32 nonce = keccak256(abi.encode(s, answerSeed, commits.length));
        uint256 value = b.bondFor(id) + (extra % 4 == 0 ? bound(extra, 0, 0.01 ether) : 0);
        vm.deal(a, a.balance + value);
        vm.prank(a);
        try b.commit{value: value}(id, keccak256(abi.encode(id, a, answer, nonce)), bytes32("model")) returns (
            uint256 i
        ) {
            commits.push(C(id, i, a, answer, nonce));
            ethIn += value;
            calls[this.commit.selector]++;
        } catch {}
    }

    /// advances 1..30 s, then reveals the first not-yet-revealed commit from a random start (newest first)
    function reveal(uint256 s) external {
        uint256 n = commits.length;
        if (n == 0) return;
        skip(1 + s % 30);
        C memory c;
        bool found;
        for (uint256 k; k < n && k < 32; ++k) {
            C memory x = commits[n - 1 - ((s >> 8) + k) % n];
            KeelBoard.Commit memory onchain = b.commitOf(x.id, x.i);
            if (!onchain.revealed && b.questionOf(x.id).status == KeelBoard.Status.Open) {
                c = x;
                found = true;
                break;
            }
        }
        if (!found) return;
        vm.prank(c.solver);
        try b.reveal(c.id, c.i, c.answer, c.nonce) {
            calls[this.reveal.selector]++;
        } catch {}
    }

    function settle(uint256 s) external {
        (uint256 id, bool ok) = _openId(s);
        if (!ok) return;
        vm.prank(poster);
        try b.settle(id, truth[id], SALT) {
            calls[this.settle.selector]++;
        } catch {}
    }

    function abandon(uint256 s) external {
        (uint256 id, bool ok) = _openId(s);
        if (!ok) return;
        try b.abandon(id) {
            calls[this.abandon.selector]++;
        } catch {}
    }

    // ── payouts ──

    function claim(uint256 s) external {
        address a = _actor(s);
        uint256 before = a.balance;
        vm.prank(a);
        try b.claim() {
            ethOut += a.balance - before;
            calls[this.claim.selector]++;
        } catch {}
    }

    function withdrawInfra() external {
        address to = makeAddr("infraTo");
        uint256 before = to.balance;
        vm.prank(owner);
        try b.withdrawInfra(to) {
            ethOut += to.balance - before;
            calls[this.withdrawInfra.selector]++;
        } catch {}
    }

    // ── admin / time ──

    function togglePause(uint256 s) external {
        if (b.paused()) {
            vm.prank(owner);
            b.unpause();
        } else {
            if (s % 4 != 0) return; // pause rarely, unpause on the next toggle
            vm.prank(pauser);
            b.pause();
        }
        calls[this.togglePause.selector]++;
    }

    function warp(uint32 secs) external {
        uint256 m = secs % 16;
        uint256 d = m == 0
            ? bound(secs, 1 days, 9 days)
            : m < 5 ? bound(secs, 10 minutes, 3 hours) : bound(secs, 1, 10 minutes);
        skip(d);
        calls[this.warp.selector]++;
    }
}

/// forge-config: default.invariant.depth = 200
/// forge-config: default.invariant.runs = 64
contract KeelBoardInvariantTest is Test {
    KeelBoard b;
    Handler h;
    MockERC20 tok;
    MockEscrow esc;
    MockPonsFactory pons;
    MockCurve curve;
    MockHook hook;
    address owner = makeAddr("owner");
    address poster = makeAddr("poster");
    address pauser = makeAddr("pauser");

    function setUp() public {
        vm.warp(1_800_000_000);
        tok = new MockERC20("Launched", "TEST");
        esc = new MockEscrow();
        pons = new MockPonsFactory();
        curve = new MockCurve(esc);
        hook = new MockHook(esc);
        b = new KeelBoard(owner, poster, pauser, 0.0003 ether, address(pons), address(esc), address(hook));
        PonsLaunchedToken memory lt;
        lt.token = address(tok);
        lt.curve = address(curve);
        lt.creatorFeeRecipient = address(b);
        lt.tickSpacing = 200;
        lt.creatorTaxBps = 200;
        lt.exists = true;
        pons.set(lt);
        curve.setRecipient(address(b));
        hook.setRecipient(address(b));
        vm.prank(owner);
        b.bind(address(tok));
        h = new Handler(b, curve, owner, poster, pauser);
        targetContract(address(h));
    }

    /// BRIEF: balance == pool + infra + Σ load(Open) + Σ unsettled bonds + Σ owed
    function invariant_accountingIdentity() public view {
        (uint256 pool, uint256 infra,,,) = b.stats();
        uint256[] memory ids = b.openIds();
        uint256 sumLoad;
        uint256 sumBonds;
        for (uint256 k; k < ids.length; ++k) {
            KeelBoard.Question memory q = b.questionOf(ids[k]);
            sumLoad += q.load;
            for (uint256 i; i < q.commits; ++i) {
                sumBonds += b.commitOf(ids[k], i).bond;
            }
        }
        uint256 sumOwed;
        for (uint256 a; a < 4; ++a) {
            sumOwed += b.owed(h.actors(a));
        }
        assertEq(address(b).balance, pool + infra + sumLoad + sumBonds + sumOwed, "balance identity");
    }

    /// the stored running totals equal the sums they stand for
    function invariant_totalsMatchSums() public view {
        (,, uint256 totalLoad,,) = b.stats();
        (uint256 totalBonds, uint256 totalOwed) = b.held();
        uint256[] memory ids = b.openIds();
        uint256 sumLoad;
        uint256 sumBonds;
        for (uint256 k; k < ids.length; ++k) {
            KeelBoard.Question memory q = b.questionOf(ids[k]);
            sumLoad += q.load;
            for (uint256 i; i < q.commits; ++i) {
                sumBonds += b.commitOf(ids[k], i).bond;
            }
        }
        uint256 sumOwed;
        for (uint256 a; a < 4; ++a) {
            sumOwed += b.owed(h.actors(a));
        }
        assertEq(totalLoad, sumLoad, "totalLoad");
        assertEq(totalBonds, sumBonds, "totalBonds");
        assertEq(totalOwed, sumOwed, "totalOwed");
    }

    /// ETH conservation from the outside: everything sent in is either still held or was paid out
    function invariant_conservation() public view {
        assertEq(h.ethIn(), address(b).balance + h.ethOut(), "in == held + out");
    }

    /// openIds lists exactly the Open questions, at most MAX_OPEN; every Solved question's winner is the lowest
    /// commit index revealed with the true answer
    function invariant_statusAndWinners() public view {
        uint256[] memory ids = b.openIds();
        assertLe(ids.length, 48);
        (,,,, uint256 count) = b.stats();
        uint256 open;
        for (uint256 id = 1; id <= count; ++id) {
            KeelBoard.Question memory q = b.questionOf(id);
            if (q.status == KeelBoard.Status.Open) {
                ++open;
            } else if (q.status == KeelBoard.Status.Solved) {
                KeelBoard.Commit memory w = b.commitOf(id, q.winnerIndex);
                assertEq(w.solver, q.winner);
                assertTrue(w.revealed);
                assertEq(w.answer, h.truth(id));
                for (uint256 i; i < q.winnerIndex; ++i) {
                    KeelBoard.Commit memory c = b.commitOf(id, i);
                    assertFalse(c.revealed && c.answer == h.truth(id), "an earlier correct reveal");
                }
            } else {
                assertEq(uint8(q.status), 3);
                assertEq(q.winner, address(0));
            }
        }
        assertEq(open, ids.length, "openIds == Open questions");
    }

    function afterInvariant() external view {
        bytes4[13] memory s = [
            Handler.fund.selector,
            Handler.curveFees.selector,
            Handler.forced.selector,
            Handler.post.selector,
            Handler.drip.selector,
            Handler.topUp.selector,
            Handler.commit.selector,
            Handler.reveal.selector,
            Handler.settle.selector,
            Handler.abandon.selector,
            Handler.claim.selector,
            Handler.withdrawInfra.selector,
            Handler.togglePause.selector
        ];
        uint256 total;
        for (uint256 k; k < s.length; ++k) {
            total += h.calls(s[k]);
        }
        assertGt(total, 0);
        if (vm.envOr("INV_LOG", false)) {
            (,,,, uint256 count) = b.stats();
            uint256 solved;
            uint256 unsolved;
            for (uint256 id = 1; id <= count; ++id) {
                KeelBoard.Status st = b.questionOf(id).status;
                if (st == KeelBoard.Status.Solved) ++solved;
                else if (st == KeelBoard.Status.Unsolved) ++unsolved;
            }
            console.log("posted / solved / unsolved", count, solved, unsolved);
            console.log(
                "commits / reveals / claims",
                h.calls(Handler.commit.selector),
                h.calls(Handler.reveal.selector),
                h.calls(Handler.claim.selector)
            );
            console.log(
                "drips / abandons / settles",
                h.calls(Handler.drip.selector),
                h.calls(Handler.abandon.selector),
                h.calls(Handler.settle.selector)
            );
        }
    }
}
