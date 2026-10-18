// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KeelBoard} from "../src/KeelBoard.sol";
import {PonsLaunchedToken} from "../src/interfaces/IPons.sol";
import {MockERC20, MockEscrow, MockPonsFactory, MockCurve, MockHook} from "./mocks/Mocks.sol";

/// Shared setup: Pons factory / curve / hook / fee escrow mocks (as in 176), a board with owner / poster / pauser and
/// a few solvers; helpers for the question lifecycle and the accounting identity.
abstract contract Base is Test {
    uint256 constant MIN_BOND = 0.0003 ether;

    MockERC20 tok; // the launched token
    MockEscrow esc;
    MockPonsFactory pons;
    MockCurve curve;
    MockHook hook;
    KeelBoard b;

    address owner = makeAddr("owner");
    address poster = makeAddr("poster");
    address pauser = makeAddr("pauser");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address eve = makeAddr("eve");

    bytes32 constant SALT = keccak256("salt");
    bytes32 constant MODEL = bytes32("claude-opus-5.5");

    function setUp() public virtual {
        vm.warp(1_800_000_000); // 2027-01-15 08:00 UTC (a whole hour)
        vm.roll(1_000_000);
        tok = new MockERC20("Launched", "TEST");
        esc = new MockEscrow();
        pons = new MockPonsFactory();
        curve = new MockCurve(esc);
        hook = new MockHook(esc);
        b = new KeelBoard(owner, poster, pauser, MIN_BOND, address(pons), address(esc), address(hook));
        vm.deal(address(this), 1_000_000 ether);
        address[5] memory who = [alice, bob, carol, dave, eve];
        for (uint256 k; k < who.length; ++k) {
            vm.deal(who[k], 1000 ether);
        }
    }

    // ── fees ──

    function _fund(uint256 amount) internal {
        (bool ok,) = payable(address(b)).call{value: amount}("");
        require(ok, "fund");
    }

    function _pool() internal view returns (uint256 p) {
        (p,,,,) = b.stats();
    }

    function _infra() internal view returns (uint256 i) {
        (, i,,,) = b.stats();
    }

    function _totalLoad() internal view returns (uint256 l) {
        (,, l,,) = b.stats();
    }

    function _count() internal view returns (uint256 c) {
        (,,,, c) = b.stats();
    }

    function _launch(address recipient) internal {
        _launchToken(address(tok), recipient);
    }

    function _launchToken(address t, address recipient) internal {
        PonsLaunchedToken memory lt;
        lt.token = t;
        lt.curve = address(curve);
        lt.creatorFeeRecipient = recipient;
        lt.tickSpacing = 200;
        lt.poolFee = 0;
        lt.creatorTaxBps = 200;
        lt.exists = true;
        pons.set(lt);
        curve.setRecipient(recipient);
        hook.setRecipient(recipient);
    }

    // ── questions ──

    function _ans(uint256 x) internal pure returns (bytes32) {
        return bytes32(x);
    }

    function _answerHash(uint256 id, bytes32 answer, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(id, answer, salt));
    }

    function _commitHash(uint256 id, address solver, bytes32 answer, bytes32 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(id, solver, answer, nonce));
    }

    function _nonce(address who, uint256 id) internal pure returns (bytes32) {
        return keccak256(abi.encode("nonce", who, id));
    }

    /// posts a question whose answer is `answer` (salt SALT), closing in 24 h
    function _post(bytes32 answer) internal returns (uint256 id) {
        return _postFor(answer, 1 days);
    }

    function _postFor(bytes32 answer, uint256 duration) internal returns (uint256 id) {
        uint256 next = _count() + 1;
        vm.prank(poster);
        id = b.post(
            _answerHash(next, answer, SALT), keccak256(abi.encode("text", next)), 2, uint64(block.timestamp + duration)
        );
        assertEq(id, next, "id = count + 1");
    }

    function _commit(address who, uint256 id, bytes32 answer) internal returns (uint256 i) {
        uint256 bond = b.bondFor(id);
        vm.prank(who);
        i = b.commit{value: bond}(id, _commitHash(id, who, answer, _nonce(who, id)), MODEL);
    }

    function _reveal(address who, uint256 id, uint256 i, bytes32 answer) internal {
        vm.prank(who);
        b.reveal(id, i, answer, _nonce(who, id));
    }

    function _settle(uint256 id, bytes32 answer) internal {
        vm.prank(poster);
        b.settle(id, answer, SALT);
    }

    // ── accounting ──

    /// balance == pool + infra + Σ load(Open) + Σ unsettled bonds + Σ owed, and Σ load(Open) == totalLoad
    function _checkIdentity() internal view {
        (uint256 p, uint256 inf, uint256 tl,,) = b.stats();
        (uint256 bonds, uint256 owedSum) = b.held();
        assertEq(address(b).balance, p + inf + tl + bonds + owedSum, "balance identity");
        uint256[] memory ids = b.openIds();
        uint256 sumLoad;
        uint256 sumBonds;
        for (uint256 k; k < ids.length; ++k) {
            KeelBoard.Question memory q = b.questionOf(ids[k]);
            assertEq(uint8(q.status), uint8(KeelBoard.Status.Open), "openIds are Open");
            sumLoad += q.load;
            for (uint256 i; i < q.commits; ++i) {
                sumBonds += b.commitOf(ids[k], i).bond;
            }
        }
        assertEq(sumLoad, tl, "sum load(Open) == totalLoad");
        assertEq(sumBonds, bonds, "sum bonds(Open) == totalBonds");
    }

    receive() external payable {}
}
