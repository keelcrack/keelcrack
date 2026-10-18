// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";
import {KeelBoard} from "../src/KeelBoard.sol";

/// Property tests: fee split, bond rule, drip distribution, commit / reveal binding, and the settle rule checked against
/// an independent reference model over random commit / reveal / timing sets.
contract KeelBoardFuzzTest is Base {
    function setUp() public override {
        super.setUp();
        vm.deal(address(this), type(uint200).max); // enough for any uint128 top-up / fund
    }

    function testFuzz_receiveSplit(uint96 a, uint96 c) public {
        vm.assume(a > 0);
        _fund(a);
        uint256 inf = (uint256(a) * 2000) / 10_000;
        assertEq(_infra(), inf);
        assertEq(_pool(), a - inf);
        if (c > 0) {
            _fund(c);
            assertEq(_infra() + _pool(), uint256(a) + c);
        }
        assertEq(b.harvestedWei(), uint256(a) + c);
        _checkIdentity();
    }

    function testFuzz_bondFor(uint128 load) public {
        uint256 id = _post(_ans(1));
        if (load > 0) b.topUp{value: load}(id);
        uint256 expect = (uint256(load) * 500) / 10_000;
        if (expect < MIN_BOND) expect = MIN_BOND;
        assertEq(b.bondFor(id), expect);
        // commit pays exactly bondFor; anything above is claimable
        bytes32 h = _commitHash(id, alice, _ans(1), bytes32("n"));
        vm.deal(alice, expect + 1 ether); // load up to 2^128 -> bond up to ~1.7e37 wei
        vm.prank(alice);
        b.commit{value: expect + 7}(id, h, MODEL);
        assertEq(b.commitOf(id, 0).bond, expect);
        assertEq(b.owed(alice), 7);
        _checkIdentity();
    }

    function testFuzz_drip(uint96 fund, uint8 nRaw, uint8 closedRaw) public {
        uint256 n = bound(nRaw, 1, 48);
        uint256 closed = bound(closedRaw, 0, n - 1); // at least one live question
        _fund(fund);
        for (uint256 k; k < n; ++k) {
            _postFor(_ans(k), k < closed ? 10 : 1 days);
        }
        skip(10); // the first `closed` questions reached closesAt
        uint256 p = _pool();
        uint256 live = n - closed;
        b.drip();
        uint256 per = (p / 100) / live;
        for (uint256 id = 1; id <= n; ++id) {
            assertEq(b.questionOf(id).load, id <= closed ? 0 : per);
        }
        assertEq(_pool(), p - per * live);
        assertLe(p - _pool(), p / 100, "at most 1% per drip");
        _checkIdentity();
    }

    function testFuzz_commitRevealBinding(bytes32 answer, bytes32 nonce, bytes32 other, address solver) public {
        vm.assume(solver != address(0) && solver.code.length == 0 && uint160(solver) > 0x100);
        vm.assume(other != nonce && other != answer);
        uint256 id = _post(answer);
        vm.deal(solver, 1 ether);
        vm.prank(solver);
        uint256 i = b.commit{value: MIN_BOND}(id, _commitHash(id, solver, answer, nonce), MODEL);
        skip(1);
        vm.prank(solver);
        vm.expectRevert(KeelBoard.BadReveal.selector);
        b.reveal(id, i, other, nonce); // another answer
        vm.prank(solver);
        vm.expectRevert(KeelBoard.BadReveal.selector);
        b.reveal(id, i, answer, other); // another nonce
        vm.prank(solver);
        b.reveal(id, i, answer, nonce);
        _settle(id, answer);
        assertEq(b.questionOf(id).winner, solver);
    }

    // ── settle rule vs a reference model ──

    struct Plan {
        address solver;
        bytes32 answer;
        bool reveal;
        uint256 at;
    }

    Plan[] plan;
    address[5] who;
    bytes32 constant TRUTH = bytes32(uint256(4663));

    function testFuzz_settleMatchesReference(uint256 seed, uint8 nRaw, uint32 startRaw, uint16 afterRaw, uint64 top)
        public
    {
        who = [alice, bob, carol, dave, eve];
        uint256 n = bound(nRaw, 0, 16);
        uint256 id = _postFor(TRUTH, 1 hours);
        if (top > 0) b.topUp{value: top}(id);
        uint256 bond = b.bondFor(id);
        skip(bound(startRaw, 0, 3600 - 16 * 30 - 1));
        _commitAll(id, seed, n, bond);
        _revealAll(id, seed);
        skip(bound(afterRaw, 0, 1300));
        _checkSettle(id, bond);
    }

    function _commitAll(uint256 id, uint256 seed, uint256 n, uint256 bond) internal {
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            if (i > 0) skip(r % 31); // 0..30 s apart (several commits can share a second)
            Plan memory pl;
            pl.solver = who[(r >> 8) % 5];
            pl.answer = (r >> 16) % 3 == 0 ? TRUTH : _ans((r >> 24) % 4); // ~1/3 correct (+ 1/4 of the rest)
            pl.reveal = (r >> 32) % 4 != 0;
            pl.at = block.timestamp;
            plan.push(pl);
            vm.prank(pl.solver);
            b.commit{value: bond}(id, _commitHash(id, pl.solver, pl.answer, bytes32(r)), MODEL);
        }
    }

    function _revealAll(uint256 id, uint256 seed) internal {
        if (plan.length > 0) skip(1); // every commit is >= 1 s and <= 481 s old: all inside their window
        for (uint256 i; i < plan.length; ++i) {
            if (!plan[i].reveal) continue;
            vm.prank(plan[i].solver);
            b.reveal(id, i, plan[i].answer, bytes32(uint256(keccak256(abi.encode(seed, i)))));
        }
    }

    function _reference() internal view returns (uint256 w, uint256 pending) {
        uint256 none = type(uint256).max;
        w = none;
        pending = none;
        for (uint256 i; i < plan.length; ++i) {
            if (plan[i].reveal && plan[i].answer == TRUTH) {
                w = i;
                break;
            }
            if (pending == none && !plan[i].reveal && block.timestamp <= plan[i].at + 600) pending = i;
        }
    }

    function _checkSettle(uint256 id, uint256 bond) internal {
        uint256 none = type(uint256).max;
        (uint256 w, uint256 pending) = _reference();
        bool closed = block.timestamp >= b.questionOf(id).closesAt;
        bytes memory err;
        if (w != none && pending != none) {
            err = abi.encodeWithSelector(KeelBoard.EarlierCommitPending.selector, pending);
        } else if (w == none && !closed) {
            err = abi.encodeWithSelector(KeelBoard.NotClosed.selector, id);
        } else if (w == none && pending != none) {
            err = abi.encodeWithSelector(KeelBoard.EarlierCommitPending.selector, pending);
        }
        if (err.length != 0) {
            vm.prank(poster);
            vm.expectRevert(err);
            b.settle(id, TRUTH, SALT);
            return;
        }

        uint256 load = b.questionOf(id).load;
        uint256 poolBefore = _pool();
        uint256[5] memory expectOwed;
        for (uint256 k; k < 5; ++k) {
            expectOwed[k] = b.owed(who[k]);
        }
        uint256 toPool;
        if (w == none) {
            toPool = load + plan.length * bond;
        } else {
            for (uint256 i; i < plan.length; ++i) {
                uint256 k = _idx(plan[i].solver);
                if (i == w) expectOwed[k] += load + bond;
                else if (i > w && plan[i].reveal && plan[i].answer == TRUTH) expectOwed[k] += bond;
                else toPool += bond;
            }
        }

        _settle(id, TRUTH);
        KeelBoard.Question memory q = b.questionOf(id);
        if (w == none) {
            assertEq(uint8(q.status), 3, "Unsolved");
            assertEq(q.winner, address(0));
        } else {
            assertEq(uint8(q.status), 2, "Solved");
            assertEq(q.winner, plan[w].solver);
            assertEq(q.winnerIndex, w);
        }
        assertEq(_pool(), poolBefore + toPool, "pool");
        for (uint256 k; k < 5; ++k) {
            assertEq(b.owed(who[k]), expectOwed[k], "owed");
        }
        _checkIdentity();
    }

    function _idx(address a) internal view returns (uint256) {
        for (uint256 k; k < 5; ++k) {
            if (who[k] == a) return k;
        }
        revert("unknown");
    }
}
