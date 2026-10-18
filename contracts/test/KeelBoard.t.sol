// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Base} from "./Base.sol";
import {KeelBoard} from "../src/KeelBoard.sol";
import {RevertingERC20, Rejecter, ContractSolver, StipendSender} from "./mocks/Mocks.sol";

contract KeelBoardTest is Base {
    // ═════════════════════════════ construction ═════════════════════════════

    function test_constructor() public view {
        assertEq(b.owner(), owner);
        assertEq(b.poster(), poster);
        assertEq(b.pauser(), pauser);
        assertEq(b.MIN_BOND(), MIN_BOND);
        assertEq(b.ponsFactory(), address(pons));
        assertEq(b.feeEscrow(), address(esc));
        assertEq(b.memeHook(), address(hook));
        assertEq(b.INFRA_BPS(), 2000);
        assertEq(b.DRIP_BPS(), 100);
        assertEq(b.DRIP_INTERVAL(), 1 hours);
        assertEq(b.MAX_OPEN(), 48);
        assertEq(b.MAX_COMMITS(), 256);
        assertEq(b.BOND_BPS(), 500);
        assertEq(b.REVEAL_WINDOW(), 10 minutes);
        assertEq(b.KEY_TIMELOCK(), 48 hours);
        assertFalse(b.paused());
        assertEq(b.token(), address(0));
        assertEq(b.openIds().length, 0);
        assertEq(b.nextDripAt(), 0);
    }

    function test_constructor_guards() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new KeelBoard(address(0), poster, pauser, MIN_BOND, address(pons), address(esc), address(hook));
        vm.expectRevert(KeelBoard.ZeroAddress.selector);
        new KeelBoard(owner, address(0), pauser, MIN_BOND, address(pons), address(esc), address(hook));
        vm.expectRevert(KeelBoard.ZeroAddress.selector);
        new KeelBoard(owner, poster, address(0), MIN_BOND, address(pons), address(esc), address(hook));
        vm.expectRevert(KeelBoard.ZeroAddress.selector);
        new KeelBoard(owner, poster, pauser, MIN_BOND, address(0), address(esc), address(hook));
        vm.expectRevert(KeelBoard.ZeroAddress.selector);
        new KeelBoard(owner, poster, pauser, MIN_BOND, address(pons), address(0), address(hook));
        vm.expectRevert(KeelBoard.ZeroAddress.selector);
        new KeelBoard(owner, poster, pauser, MIN_BOND, address(pons), address(esc), address(0));
        vm.expectRevert(KeelBoard.BadParams.selector);
        new KeelBoard(owner, poster, pauser, 0, address(pons), address(esc), address(hook));
    }

    // ═════════════════════════════ fees ═════════════════════════════

    function test_receive_splits8020() public {
        vm.expectEmit(address(b));
        emit KeelBoard.Harvested(1 ether, 0.8 ether, 0.2 ether);
        _fund(1 ether);
        assertEq(_pool(), 0.8 ether);
        assertEq(_infra(), 0.2 ether);
        assertEq(b.harvestedWei(), 1 ether);
        _fund(3); // rounding favours the pool
        assertEq(_infra(), 0.2 ether);
        assertEq(_pool(), 0.8 ether + 3);
        _checkIdentity();
    }

    /// a 2300-gas transfer() cannot pay the split (documented: send fees with call)
    function test_receive_stipendReverts() public {
        StipendSender s = new StipendSender();
        vm.expectRevert();
        s.send_{value: 1 ether}(payable(address(b)));
    }

    function test_harvest_noTokenNothingNew() public {
        b.harvest();
        vm.prank(eve);
        b.harvest();
        assertEq(b.harvestedWei(), 0);
        _checkIdentity();
    }

    function test_harvest_curvePhase() public {
        _launch(address(b));
        vm.prank(owner);
        b.bind(address(tok));
        curve.accrue{value: 2 ether}();
        vm.prank(eve);
        b.harvest(); // sweepFees -> escrow.credit -> escrow.claim -> receive (split)
        assertEq(curve.pendingFees(), 0);
        assertEq(esc.balanceOf(address(b)), 0);
        assertEq(_pool(), 1.6 ether);
        assertEq(_infra(), 0.4 ether);
        assertEq(b.harvestedWei(), 2 ether);
        _checkIdentity();
    }

    function test_harvest_operatorOnlyCurve() public {
        _launch(address(b));
        vm.prank(owner);
        b.bind(address(tok));
        curve.setOperatorOnly(true);
        curve.accrue{value: 1 ether}();
        b.harvest(); // the curve refuses the board's sweep: nothing, no revert
        assertEq(b.harvestedWei(), 0);
        curve.operatorSweep(); // the Pons operator credits the escrow
        b.harvest();
        assertEq(b.harvestedWei(), 1 ether);
        _checkIdentity();
    }

    function test_harvest_graduatedHookSweep() public {
        _launch(address(b));
        vm.prank(owner);
        b.bind(address(tok));
        pons.setPhase(address(tok), 2);
        hook.accrue{value: 1 ether}();
        b.harvest();
        assertEq(b.harvestedWei(), 1 ether);
        (address c0, address c1) = address(0) < address(tok) ? (address(0), address(tok)) : (address(tok), address(0));
        assertEq(hook.lastPoolId(), keccak256(abi.encode(c0, c1, uint24(0), int24(200), address(hook))), "V4 PoolId");
        _checkIdentity();
    }

    function test_harvest_neverReverts() public {
        _launch(address(b));
        vm.prank(owner);
        b.bind(address(tok));
        curve.accrue{value: 1 ether}();
        esc.setFailClaim(true);
        b.harvest(); // swept into the escrow, claim fails: no revert
        assertEq(esc.balanceOf(address(b)), 1 ether);
        assertEq(b.harvestedWei(), 0);
        pons.setBroken(true);
        esc.setFailClaim(false);
        b.harvest(); // factory call reverts: skipped, escrow claim still collects
        assertEq(b.harvestedWei(), 1 ether);
        // recipient moved away (Pons owner override): no sweep attempt, no revert
        pons.setBroken(false);
        pons.setRecipient(address(tok), eve);
        b.harvest();
        _checkIdentity();
    }

    function test_harvest_burnsHeldToken() public {
        _launch(address(b));
        vm.prank(owner);
        b.bind(address(tok));
        tok.mint(address(b), 1000);
        vm.expectEmit(address(b));
        emit KeelBoard.Burned(1000);
        b.harvest();
        assertEq(tok.balanceOf(address(b)), 0);
        assertEq(tok.balanceOf(0x000000000000000000000000000000000000dEaD), 1000);
    }

    function test_harvest_revertingTokenStillHarvests() public {
        RevertingERC20 rt = new RevertingERC20();
        // bind a launch of a token that refuses transfers
        _launchToken(address(rt), address(b));
        vm.prank(owner);
        b.bind(address(rt));
        rt.mint(address(b), 5);
        curve.accrue{value: 1 ether}();
        b.harvest();
        assertEq(b.harvestedWei(), 1 ether);
        assertEq(rt.balanceOf(address(b)), 5, "burn skipped");
    }

    function test_rescuePush_isSplit() public {
        _launch(address(b));
        curve.accrue{value: 1 ether}();
        curve.rescue(); // full-gas push straight to the board
        assertEq(_pool(), 0.8 ether);
        _checkIdentity();
    }

    function test_forcedEth_splitByHarvest() public {
        _fund(1 ether);
        vm.deal(address(b), address(b).balance + 0.5 ether); // like selfdestruct: no receive()
        b.harvest();
        assertEq(b.harvestedWei(), 1.5 ether);
        assertEq(_infra(), 0.3 ether);
        _checkIdentity();
    }

    function test_bind_guards() public {
        _launch(address(b));
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        b.bind(address(tok));
        vm.startPrank(owner);
        vm.expectRevert(KeelBoard.TokenNotFound.selector);
        b.bind(address(0));
        vm.expectRevert(KeelBoard.TokenNotFound.selector);
        b.bind(makeAddr("unknown"));
        vm.stopPrank();
        pons.setRecipient(address(tok), eve);
        vm.prank(owner);
        vm.expectRevert(KeelBoard.NotRecipient.selector);
        b.bind(address(tok));
        _launch(address(b));
        vm.prank(owner);
        b.bind(address(tok));
        assertEq(b.token(), address(tok));
        vm.prank(owner);
        vm.expectRevert(KeelBoard.AlreadyBound.selector);
        b.bind(address(tok));
    }

    function test_bind_refusesErc20Pair() public {
        _launch(address(b));
        pons.setPairToken(address(tok), makeAddr("weth"));
        vm.prank(owner);
        vm.expectRevert(KeelBoard.UnsupportedPair.selector);
        b.bind(address(tok));
    }

    // ═════════════════════════════ post ═════════════════════════════

    function test_post() public {
        uint64 closes = uint64(block.timestamp + 1 days);
        bytes32 ah = _answerHash(1, _ans(7), SALT);
        vm.expectEmit(address(b));
        emit KeelBoard.Posted(1, ah, bytes32("text"), 3, closes);
        vm.prank(poster);
        uint256 id = b.post(ah, bytes32("text"), 3, closes);
        assertEq(id, 1);
        KeelBoard.Question memory q = b.questionOf(1);
        assertEq(q.postedAt, block.timestamp);
        assertEq(q.closesAt, closes);
        assertEq(q.tier, 3);
        assertEq(uint8(q.status), 1);
        assertEq(q.answerHash, ah);
        assertEq(q.textHash, bytes32("text"));
        assertEq(q.load, 0);
        assertEq(q.winner, address(0));
        assertEq(q.commits, 0);
        assertEq(_count(), 1);
        assertEq(b.openIds().length, 1);
        assertEq(_post(_ans(1)), 2);
        assertEq(uint8(b.questionOf(99).status), 0, "None");
    }

    function test_post_guards() public {
        uint64 closes = uint64(block.timestamp + 1 days);
        vm.prank(eve);
        vm.expectRevert(KeelBoard.NotPoster.selector);
        b.post(bytes32("a"), 0, 1, closes);
        vm.startPrank(poster);
        vm.expectRevert(KeelBoard.BadParams.selector);
        b.post(0, 0, 1, closes);
        vm.expectRevert(KeelBoard.BadParams.selector);
        b.post(bytes32("a"), 0, 0, closes);
        vm.expectRevert(KeelBoard.BadParams.selector);
        b.post(bytes32("a"), 0, 1, uint64(block.timestamp));
        vm.expectRevert(KeelBoard.BadParams.selector);
        b.post(bytes32("a"), 0, 1, uint64(block.timestamp + 7 days + 1));
        b.post(bytes32("a"), 0, 1, uint64(block.timestamp + 7 days));
        vm.stopPrank();
    }

    function test_post_maxOpen() public {
        for (uint256 k; k < 48; ++k) {
            _post(_ans(k));
        }
        vm.prank(poster);
        vm.expectRevert(KeelBoard.TooManyOpen.selector);
        b.post(bytes32("a"), 0, 1, uint64(block.timestamp + 1 days));
        // settling one frees a slot
        skip(1 days);
        _settle(5, _ans(4));
        _post(_ans(1));
        assertEq(b.openIds().length, 48);
    }

    // ═════════════════════════════ drip ═════════════════════════════

    function test_drip_equalSplit() public {
        _fund(100 ether); // pool 80
        _post(_ans(1));
        _post(_ans(2));
        _post(_ans(3));
        vm.expectEmit(address(b));
        emit KeelBoard.Dripped(0.8 ether - 2, uint256(0.8 ether) / 3, 3);
        b.drip(); // 0.8 ETH / 3
        uint256 per = uint256(0.8 ether) / 3;
        assertEq(b.questionOf(1).load, per);
        assertEq(b.questionOf(3).load, per);
        assertEq(_pool(), 80 ether - per * 3, "leftover stays in the pool");
        assertEq(_totalLoad(), per * 3);
        (,,, uint256 last,) = b.stats();
        assertEq(last, block.timestamp);
        assertEq(b.nextDripAt(), block.timestamp + 1 hours);
        _checkIdentity();
    }

    function test_drip_oncePerHourSlot() public {
        _fund(10 ether);
        _post(_ans(1));
        skip(30 minutes); // 08:30
        b.drip();
        skip(29 minutes); // 08:59
        vm.expectRevert(KeelBoard.TooEarly.selector);
        b.drip();
        skip(1 minutes); // 09:00: a new clock hour (no drift when the keeper runs a few seconds late or early)
        b.drip();
        skip(59 minutes + 59 seconds);
        vm.expectRevert(KeelBoard.TooEarly.selector);
        b.drip();
        skip(1);
        b.drip();
        _checkIdentity();
    }

    function test_drip_nothingOpenAndClosedSkipped() public {
        _fund(10 ether);
        vm.expectRevert(KeelBoard.NothingOpen.selector);
        b.drip();
        _postFor(_ans(1), 1 hours);
        _postFor(_ans(2), 1 days);
        skip(1 hours); // q1 reached closesAt (still Open, not settled)
        b.drip();
        assertEq(b.questionOf(1).load, 0, "closed questions get nothing");
        assertEq(b.questionOf(2).load, 0.08 ether);
        _checkIdentity();
    }

    function test_drip_emptyPool() public {
        _post(_ans(1));
        b.drip();
        assertEq(b.questionOf(1).load, 0);
        assertEq(b.nextDripAt(), block.timestamp + 1 hours);
    }

    function test_drip_growsHourly() public {
        _fund(100 ether);
        _post(_ans(1));
        uint256 expected;
        for (uint256 h; h < 24; ++h) {
            uint256 p = _pool();
            b.drip();
            expected += p / 100;
            skip(1 hours);
        }
        assertEq(b.questionOf(1).load, expected);
        uint256 closed = uint256(80 ether) - (uint256(80 ether) * uint256(99) ** 24) / uint256(100) ** 24;
        assertApproxEqRel(expected, closed, 1e6);
        _checkIdentity();
    }

    // ═════════════════════════════ topUp / bond ═════════════════════════════

    function test_topUp() public {
        uint256 id = _post(_ans(1));
        vm.expectEmit(address(b));
        emit KeelBoard.ToppedUp(id, alice, 1 ether);
        vm.prank(alice);
        b.topUp{value: 1 ether}(id);
        assertEq(b.questionOf(id).load, 1 ether);
        assertEq(_totalLoad(), 1 ether);
        assertEq(_pool(), 0, "not a harvest");
        _checkIdentity();
        vm.expectRevert(KeelBoard.BadParams.selector);
        b.topUp(id);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.NotOpen.selector, 9));
        b.topUp{value: 1}(9);
        skip(1 days);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.Closed.selector, id));
        b.topUp{value: 1}(id);
    }

    function test_bondFor() public {
        uint256 id = _post(_ans(1));
        assertEq(b.bondFor(id), MIN_BOND);
        b.topUp{value: 0.006 ether}(id); // 5% = 0.0003 = MIN_BOND
        assertEq(b.bondFor(id), MIN_BOND);
        b.topUp{value: 0.994 ether}(id);
        assertEq(b.bondFor(id), 0.05 ether);
    }

    // ═════════════════════════════ commit ═════════════════════════════

    function test_commit() public {
        uint256 id = _post(_ans(1));
        b.topUp{value: 1 ether}(id);
        bytes32 h = _commitHash(id, alice, _ans(1), _nonce(alice, id));
        vm.expectEmit(address(b));
        emit KeelBoard.Committed(id, 0, alice, h, 0.05 ether, MODEL);
        vm.prank(alice);
        uint256 i = b.commit{value: 0.05 ether}(id, h, MODEL);
        assertEq(i, 0);
        KeelBoard.Commit memory c = b.commitOf(id, 0);
        assertEq(c.solver, alice);
        assertEq(c.hash, h);
        assertEq(c.at, block.timestamp);
        assertEq(c.bond, 0.05 ether);
        assertEq(c.model, MODEL);
        assertFalse(c.revealed);
        assertEq(c.answer, 0);
        assertEq(b.questionOf(id).commits, 1);
        assertEq(_commit(bob, id, _ans(2)), 1);
        (uint256 bonds,) = b.held();
        assertEq(bonds, 0.1 ether);
        _checkIdentity();
    }

    function test_commit_overpayGoesToOwed() public {
        uint256 id = _post(_ans(1));
        bytes32 h = _commitHash(id, alice, _ans(1), _nonce(alice, id));
        vm.prank(alice);
        b.commit{value: MIN_BOND + 0.001 ether}(id, h, MODEL);
        assertEq(b.commitOf(id, 0).bond, MIN_BOND);
        assertEq(b.owed(alice), 0.001 ether);
        _checkIdentity();
        uint256 before = alice.balance;
        vm.prank(alice);
        b.claim();
        assertEq(alice.balance, before + 0.001 ether);
    }

    function test_commit_guards() public {
        uint256 id = _post(_ans(1));
        bytes32 h = _commitHash(id, alice, _ans(1), _nonce(alice, id));
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.BadBond.selector, MIN_BOND - 1, MIN_BOND));
        b.commit{value: MIN_BOND - 1}(id, h, MODEL);
        vm.expectRevert(KeelBoard.BadParams.selector);
        b.commit{value: MIN_BOND}(id, 0, MODEL);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.NotOpen.selector, 2));
        b.commit{value: MIN_BOND}(2, h, MODEL);
        skip(1 days);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.Closed.selector, id));
        b.commit{value: MIN_BOND}(id, h, MODEL);
        vm.stopPrank();
    }

    function test_commit_maxCommits() public {
        uint256 id = _post(_ans(1));
        for (uint256 k; k < 256; ++k) {
            _commit(alice, id, _ans(k));
        }
        bytes32 h = _commitHash(id, bob, _ans(1), _nonce(bob, id));
        vm.prank(bob);
        vm.expectRevert(KeelBoard.TooManyCommits.selector);
        b.commit{value: MIN_BOND}(id, h, MODEL);
        _checkIdentity();
    }

    // ═════════════════════════════ reveal ═════════════════════════════

    function test_reveal() public {
        uint256 id = _post(_ans(1));
        uint256 i = _commit(alice, id, _ans(42));
        vm.prank(alice);
        vm.expectRevert(KeelBoard.RevealTooEarly.selector); // same block / same second
        b.reveal(id, i, _ans(42), _nonce(alice, id));
        skip(1);
        vm.prank(bob);
        vm.expectRevert(KeelBoard.NotSolver.selector);
        b.reveal(id, i, _ans(42), _nonce(alice, id));
        vm.prank(alice);
        vm.expectRevert(KeelBoard.BadReveal.selector);
        b.reveal(id, i, _ans(43), _nonce(alice, id));
        vm.prank(alice);
        vm.expectRevert(KeelBoard.BadReveal.selector);
        b.reveal(id, i, _ans(42), bytes32("other nonce"));
        vm.prank(alice);
        vm.expectRevert(KeelBoard.OutOfBounds.selector);
        b.reveal(id, 1, _ans(42), _nonce(alice, id));
        vm.expectEmit(address(b));
        emit KeelBoard.Revealed(id, i, alice, _ans(42));
        _reveal(alice, id, i, _ans(42));
        KeelBoard.Commit memory c = b.commitOf(id, i);
        assertTrue(c.revealed);
        assertEq(c.answer, _ans(42));
        vm.prank(alice);
        vm.expectRevert(KeelBoard.AlreadyRevealed.selector);
        b.reveal(id, i, _ans(42), _nonce(alice, id));
    }

    function test_reveal_window() public {
        uint256 id = _post(_ans(1));
        uint256 i0 = _commit(alice, id, _ans(1));
        uint256 i1 = _commit(bob, id, _ans(1));
        skip(10 minutes); // exactly at + REVEAL_WINDOW: still open
        _reveal(alice, id, i0, _ans(1));
        skip(1);
        vm.prank(bob);
        vm.expectRevert(KeelBoard.RevealWindowOver.selector);
        b.reveal(id, i1, _ans(1), _nonce(bob, id));
    }

    function test_reveal_afterCloseWhileOpen() public {
        uint256 id = _post(_ans(1));
        skip(1 days - 1);
        uint256 i = _commit(alice, id, _ans(1)); // last second
        skip(5 minutes); // past closesAt, inside the window
        _reveal(alice, id, i, _ans(1));
        _settle(id, _ans(1));
        assertEq(b.questionOf(id).winner, alice);
    }

    function test_reveal_afterSettleRefused() public {
        uint256 id = _post(_ans(1));
        uint256 i0 = _commit(alice, id, _ans(1));
        skip(1);
        uint256 i1 = _commit(bob, id, _ans(1));
        _reveal(alice, id, i0, _ans(1));
        _settle(id, _ans(1));
        skip(1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.NotOpen.selector, id));
        b.reveal(id, i1, _ans(1), _nonce(bob, id));
    }

    // ═════════════════════════════ settle ═════════════════════════════

    function test_settle_singleWinner() public {
        _fund(10 ether);
        uint256 id = _post(_ans(4663));
        b.drip(); // 0.08
        b.topUp{value: 0.92 ether}(id); // load 1 ETH -> bond 0.05
        uint256 i = _commit(alice, id, _ans(4663));
        skip(3);
        _reveal(alice, id, i, _ans(4663));
        vm.expectEmit(address(b));
        emit KeelBoard.Settled(id, _ans(4663), SALT, alice, 0, 1.05 ether);
        _settle(id, _ans(4663));
        KeelBoard.Question memory q = b.questionOf(id);
        assertEq(uint8(q.status), 2, "Solved");
        assertEq(q.winner, alice);
        assertEq(q.winnerIndex, 0);
        assertEq(q.load, 1 ether, "load frozen for display");
        assertEq(b.owed(alice), 1.05 ether);
        assertEq(_totalLoad(), 0);
        assertEq(b.openIds().length, 0);
        assertEq(b.paidWei(), 1 ether);
        _checkIdentity();
        uint256 before = alice.balance;
        vm.expectEmit(address(b));
        emit KeelBoard.Claimed(alice, 1.05 ether);
        vm.prank(alice);
        b.claim();
        assertEq(alice.balance, before + 1.05 ether);
        _checkIdentity();
    }

    function test_settle_guards() public {
        uint256 id = _post(_ans(1));
        vm.prank(eve);
        vm.expectRevert(KeelBoard.NotPoster.selector);
        b.settle(id, _ans(1), SALT);
        vm.prank(poster);
        vm.expectRevert(KeelBoard.BadAnswer.selector);
        b.settle(id, _ans(2), SALT);
        vm.prank(poster);
        vm.expectRevert(KeelBoard.BadAnswer.selector);
        b.settle(id, _ans(1), bytes32("wrong salt"));
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.NotClosed.selector, id));
        b.settle(id, _ans(1), SALT);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.NotOpen.selector, 7));
        b.settle(7, _ans(1), SALT);
        // the answer hash binds the id: question 1's (answer, salt) cannot settle question 2
        uint256 id2 = _post(_ans(1));
        skip(1 days);
        _settle(id, _ans(1));
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.NotOpen.selector, id));
        b.settle(id, _ans(1), SALT);
        _settle(id2, _ans(1));
    }

    /// two correct commits: the earlier index wins even when it reveals later; the later correct one is refunded
    function test_settle_earliestCommitWins() public {
        uint256 id = _post(_ans(9));
        b.topUp{value: 2 ether}(id); // bond 0.1
        uint256 ia = _commit(alice, id, _ans(9));
        uint256 ib = _commit(bob, id, _ans(9));
        uint256 ic = _commit(carol, id, _ans(8)); // wrong
        skip(1);
        _reveal(bob, id, ib, _ans(9));
        _reveal(carol, id, ic, _ans(8));
        // alice (index 0) has not revealed and is inside her window: the keeper must wait
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.EarlierCommitPending.selector, 0));
        b.settle(id, _ans(9), SALT);
        skip(60);
        _reveal(alice, id, ia, _ans(9));
        uint256 poolBefore = _pool();
        _settle(id, _ans(9));
        KeelBoard.Question memory q = b.questionOf(id);
        assertEq(q.winner, alice);
        assertEq(q.winnerIndex, 0);
        assertEq(b.owed(alice), 2.1 ether, "load + own bond");
        assertEq(b.owed(bob), 0.1 ether, "later correct reveal: bond refunded");
        assertEq(b.owed(carol), 0, "wrong reveal forfeits");
        assertEq(_pool(), poolBefore + 0.1 ether, "wrong bond -> pool");
        _checkIdentity();
    }

    /// an earlier commit that never reveals blocks settle only until its window is over, then forfeits
    function test_settle_earlierPendingThenExpired() public {
        uint256 id = _post(_ans(9));
        _commit(alice, id, _ans(9)); // never reveals
        skip(2 minutes);
        uint256 ib = _commit(bob, id, _ans(9));
        skip(1);
        _reveal(bob, id, ib, _ans(9));
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.EarlierCommitPending.selector, 0));
        b.settle(id, _ans(9), SALT);
        skip(8 minutes - 1); // alice.at + 10 min + 0 -> still inside (<=)
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.EarlierCommitPending.selector, 0));
        b.settle(id, _ans(9), SALT);
        skip(1);
        _settle(id, _ans(9));
        assertEq(b.questionOf(id).winner, bob);
        assertEq(b.questionOf(id).winnerIndex, 1);
        assertEq(b.owed(alice), 0);
        assertEq(b.owed(bob), MIN_BOND);
        assertEq(_pool(), MIN_BOND, "alice's bond forfeited");
        _checkIdentity();
    }

    /// earlier revealed-wrong commits do not block; later unrevealed commits forfeit (BRIEF rule)
    function test_settle_wrongEarlierAndUnrevealedLater() public {
        uint256 id = _post(_ans(5));
        uint256 i0 = _commit(alice, id, _ans(4));
        uint256 i1 = _commit(bob, id, _ans(5));
        skip(1);
        _commit(carol, id, _ans(5)); // later, not revealed at settle time
        _reveal(alice, id, i0, _ans(4));
        _reveal(bob, id, i1, _ans(5));
        _settle(id, _ans(5));
        assertEq(b.questionOf(id).winner, bob);
        assertEq(b.owed(bob), MIN_BOND);
        assertEq(b.owed(carol), 0);
        assertEq(_pool(), 2 * MIN_BOND);
        _checkIdentity();
    }

    function test_settle_unsolvedAtClose() public {
        _fund(10 ether);
        uint256 id = _post(_ans(5));
        b.drip();
        uint256 load = b.questionOf(id).load;
        uint256 bond = b.bondFor(id);
        uint256 i0 = _commit(alice, id, _ans(4));
        _commit(bob, id, _ans(6)); // never revealed
        skip(1);
        _reveal(alice, id, i0, _ans(4));
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.NotClosed.selector, id));
        b.settle(id, _ans(5), SALT);
        skip(1 days);
        uint256 poolBefore = _pool();
        vm.expectEmit(address(b));
        emit KeelBoard.Settled(id, _ans(5), SALT, address(0), 0, 0);
        _settle(id, _ans(5));
        KeelBoard.Question memory q = b.questionOf(id);
        assertEq(uint8(q.status), 3, "Unsolved");
        assertEq(q.winner, address(0));
        assertEq(_pool(), poolBefore + load + 2 * bond, "load + all bonds -> pool");
        assertEq(_totalLoad(), 0);
        _checkIdentity();
    }

    /// a commit made just before closesAt keeps the question open for its reveal window
    function test_settle_unsolvedWaitsForLastReveal() public {
        uint256 id = _post(_ans(5));
        b.topUp{value: 1 ether}(id);
        skip(1 days - 10);
        uint256 i = _commit(alice, id, _ans(5));
        skip(10); // closesAt
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.EarlierCommitPending.selector, 0));
        b.settle(id, _ans(5), SALT);
        skip(1 minutes);
        _reveal(alice, id, i, _ans(5));
        _settle(id, _ans(5));
        assertEq(b.questionOf(id).winner, alice, "solved after close by a pre-close commit");
        assertEq(b.owed(alice), 1.05 ether);
    }

    function test_settle_noCommitsUnsolved() public {
        _fund(1 ether);
        uint256 id = _post(_ans(5));
        b.drip();
        skip(1 days);
        _settle(id, _ans(5));
        assertEq(_pool(), 0.8 ether);
        _checkIdentity();
    }

    // ═════════════════════════════ claim ═════════════════════════════

    function test_claim_guards() public {
        vm.prank(alice);
        vm.expectRevert(KeelBoard.NothingToClaim.selector);
        b.claim();
    }

    function test_claim_rejecterKeepsOwed() public {
        Rejecter r = new Rejecter();
        ContractSolver s = new ContractSolver();
        uint256 id = _post(_ans(1));
        bytes32 h = _commitHash(id, address(s), _ans(1), bytes32("n"));
        s.call_{value: MIN_BOND}(address(b), MIN_BOND, abi.encodeCall(KeelBoard.commit, (id, h, MODEL)));
        skip(1);
        s.call_(address(b), 0, abi.encodeCall(KeelBoard.reveal, (id, 0, _ans(1), bytes32("n"))));
        _settle(id, _ans(1));
        assertEq(b.owed(address(s)), MIN_BOND);
        // a contract can claim
        s.call_(address(b), 0, abi.encodeCall(KeelBoard.claim, ()));
        assertEq(address(s).balance, MIN_BOND);
        // a receiver that rejects ETH keeps its owed amount
        vm.deal(address(r), 1 ether);
        uint256 id2 = _post(_ans(2));
        vm.prank(address(r));
        (bool ok,) = address(b).call{value: MIN_BOND + 1}(abi.encodeCall(KeelBoard.commit, (id2, bytes32("h"), MODEL)));
        assertTrue(ok);
        assertEq(b.owed(address(r)), 1);
        vm.prank(address(r));
        vm.expectRevert(KeelBoard.TransferFailed.selector);
        b.claim();
        assertEq(b.owed(address(r)), 1);
        _checkIdentity();
    }

    function test_claim_reentrancyBlocked() public {
        ContractSolver s = new ContractSolver();
        uint256 id = _post(_ans(1));
        bytes32 h = _commitHash(id, address(s), _ans(1), bytes32("n"));
        s.call_{value: MIN_BOND + 1 ether}(
            address(b), MIN_BOND + 1 ether, abi.encodeCall(KeelBoard.commit, (id, h, MODEL))
        );
        assertEq(b.owed(address(s)), 1 ether);
        s.arm(address(b), abi.encodeCall(KeelBoard.claim, ()));
        s.call_(address(b), 0, abi.encodeCall(KeelBoard.claim, ()));
        assertFalse(s.reenterOk(), "re-entry refused");
        assertEq(
            bytes4(s.reenterRet()), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector, "guard selector"
        );
        assertEq(address(s).balance, 1 ether, "paid once");
        assertEq(b.owed(address(s)), 0);
        _checkIdentity();
    }

    // ═════════════════════════════ pause ═════════════════════════════

    function test_pause() public {
        _fund(10 ether);
        uint256 id = _post(_ans(1));
        uint256 i = _commit(alice, id, _ans(1));
        vm.prank(eve);
        vm.expectRevert(KeelBoard.NotPauser.selector);
        b.pause();
        vm.expectEmit(address(b));
        emit KeelBoard.Paused(true);
        vm.prank(pauser);
        b.pause();
        assertTrue(b.paused());

        vm.prank(poster);
        vm.expectRevert(KeelBoard.IsPaused.selector);
        b.post(bytes32("a"), 0, 1, uint64(block.timestamp + 1 days));
        vm.expectRevert(KeelBoard.IsPaused.selector);
        b.drip();
        vm.expectRevert(KeelBoard.IsPaused.selector);
        b.topUp{value: 1}(id);
        bytes32 h = _commitHash(id, bob, _ans(1), _nonce(bob, id));
        vm.prank(bob);
        vm.expectRevert(KeelBoard.IsPaused.selector);
        b.commit{value: MIN_BOND}(id, h, MODEL);

        // reveal, harvest, receive keep working
        skip(1);
        _reveal(alice, id, i, _ans(1));
        b.harvest();
        _fund(1 ether);
        vm.prank(poster);
        vm.expectRevert(KeelBoard.IsPaused.selector);
        b.settle(id, _ans(1), SALT);

        vm.prank(pauser);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, pauser));
        b.unpause();
        vm.prank(owner);
        b.unpause();
        assertFalse(b.paused());
        _settle(id, _ans(1));
        // owner may pause too; claim works while paused
        vm.prank(owner);
        b.pause();
        vm.prank(alice);
        b.claim();
        _checkIdentity();
    }

    // ═════════════════════════════ keys ═════════════════════════════

    function test_keys_rotation() public {
        address np = makeAddr("newPoster");
        address nz = makeAddr("newPauser");
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        b.proposeKeys(np, nz);
        vm.expectRevert(KeelBoard.NothingProposed.selector);
        b.acceptKeys();
        vm.startPrank(owner);
        vm.expectRevert(KeelBoard.ZeroAddress.selector);
        b.proposeKeys(address(0), nz);
        vm.expectRevert(KeelBoard.ZeroAddress.selector);
        b.proposeKeys(np, address(0));
        vm.expectEmit(address(b));
        emit KeelBoard.KeysProposed(np, nz, uint64(block.timestamp + 48 hours));
        b.proposeKeys(np, nz);
        vm.stopPrank();
        assertEq(b.pendingPoster(), np);
        assertEq(b.keysExecutableAt(), block.timestamp + 48 hours);
        skip(48 hours - 1);
        vm.expectRevert(KeelBoard.TooEarly.selector);
        b.acceptKeys();
        _post(_ans(1)); // the old poster still works during the timelock
        skip(1);
        vm.expectEmit(address(b));
        emit KeelBoard.KeysAccepted(np, nz);
        vm.prank(eve); // anyone executes after the timelock
        b.acceptKeys();
        assertEq(b.poster(), np);
        assertEq(b.pauser(), nz);
        assertEq(b.keysExecutableAt(), 0);
        vm.prank(poster);
        vm.expectRevert(KeelBoard.NotPoster.selector);
        b.post(bytes32("a"), 0, 1, uint64(block.timestamp + 1 days));
        vm.prank(pauser);
        vm.expectRevert(KeelBoard.NotPauser.selector);
        b.pause();
        vm.prank(np);
        b.post(bytes32("a"), 0, 1, uint64(block.timestamp + 1 days));
        vm.prank(nz);
        b.pause();
        vm.expectRevert(KeelBoard.NothingProposed.selector);
        b.acceptKeys();
    }

    function test_keys_reproposeRestartsTimelock() public {
        vm.prank(owner);
        b.proposeKeys(eve, eve);
        skip(47 hours);
        vm.prank(owner);
        b.proposeKeys(poster, pauser); // cancel = re-propose the current keys
        skip(2 hours);
        vm.expectRevert(KeelBoard.TooEarly.selector);
        b.acceptKeys();
        skip(46 hours);
        b.acceptKeys();
        assertEq(b.poster(), poster);
    }

    function test_owner_twoStepAndNoRenounce() public {
        vm.prank(owner);
        vm.expectRevert(KeelBoard.RenounceDisabled.selector);
        b.renounceOwnership();
        vm.prank(owner);
        b.transferOwnership(eve);
        assertEq(b.owner(), owner);
        vm.prank(eve);
        b.acceptOwnership();
        assertEq(b.owner(), eve);
    }

    function test_withdrawInfra() public {
        vm.prank(owner);
        vm.expectRevert(KeelBoard.NothingToWithdraw.selector);
        b.withdrawInfra(owner);
        _fund(10 ether);
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        b.withdrawInfra(eve);
        vm.startPrank(owner);
        vm.expectRevert(KeelBoard.ZeroAddress.selector);
        b.withdrawInfra(address(0));
        Rejecter r = new Rejecter();
        vm.expectRevert(KeelBoard.TransferFailed.selector);
        b.withdrawInfra(address(r));
        address to = makeAddr("infraTo");
        vm.expectEmit(address(b));
        emit KeelBoard.InfraWithdrawn(to, 2 ether);
        b.withdrawInfra(to);
        vm.stopPrank();
        assertEq(to.balance, 2 ether);
        assertEq(_infra(), 0);
        assertEq(_pool(), 8 ether, "the pool is untouched");
        _checkIdentity();
    }

    // ═════════════════════════════ abandon ═════════════════════════════

    function test_abandon() public {
        _fund(10 ether);
        uint256 id = _post(_ans(1));
        b.drip();
        uint256 load = b.questionOf(id).load;
        uint256 i0 = _commit(alice, id, _ans(1));
        _commit(bob, id, _ans(2));
        skip(1);
        _reveal(alice, id, i0, _ans(1));
        skip(1 days + 7 days - 2);
        vm.expectRevert(KeelBoard.TooEarly.selector);
        b.abandon(id);
        skip(1);
        vm.prank(pauser);
        b.pause(); // works while paused
        uint256 poolBefore = _pool();
        uint256 bond = load * 500 / 10_000;
        assertGt(bond, MIN_BOND);
        vm.expectEmit(address(b));
        emit KeelBoard.Abandoned(id, load, 2 * bond);
        vm.prank(eve);
        b.abandon(id);
        assertEq(uint8(b.questionOf(id).status), 3);
        assertEq(b.owed(alice), bond, "every bond refunded");
        assertEq(b.owed(bob), bond);
        assertEq(_pool(), poolBefore + load);
        assertEq(b.openIds().length, 0);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.NotOpen.selector, id));
        b.abandon(id);
        _checkIdentity();
    }

    // ═════════════════════════════ views ═════════════════════════════

    function test_openIds_swapAndPop() public {
        for (uint256 k = 1; k <= 4; ++k) {
            _post(_ans(k));
        }
        skip(1 days);
        _settle(2, _ans(2));
        uint256[] memory ids = b.openIds();
        assertEq(ids.length, 3);
        assertEq(ids[0], 1);
        assertEq(ids[1], 4);
        assertEq(ids[2], 3);
        _settle(1, _ans(1));
        _settle(3, _ans(3));
        ids = b.openIds();
        assertEq(ids.length, 1);
        assertEq(ids[0], 4);
        _settle(4, _ans(4));
        assertEq(b.openIds().length, 0);
    }

    function test_views_hashHelpers() public {
        uint256 id = _post(_ans(1));
        assertEq(b.answerHashOf(id, _ans(1), SALT), b.questionOf(id).answerHash);
        assertEq(b.commitHashOf(id, alice, _ans(3), bytes32("n")), _commitHash(id, alice, _ans(3), bytes32("n")));
        vm.expectRevert(KeelBoard.OutOfBounds.selector);
        b.commitOf(id, 0);
    }

    /// BRIEF answer encodings: uint -> bytes32(uint256(x)), address -> bytes32(uint256(uint160(a))), bytes32 as is
    function test_answerEncodings() public {
        address tokenAns = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
        bytes32 a = bytes32(uint256(uint160(tokenAns)));
        uint256 id = _post(a);
        uint256 i = _commit(alice, id, a);
        skip(1);
        _reveal(alice, id, i, a);
        _settle(id, a);
        assertEq(b.questionOf(id).winner, alice);
        assertEq(
            a, hex"0000000000000000000000007ed598bcef8bd9edd8c97a195c6d13f40801ec7e", "left-padded address, lowercase"
        );
    }

    /// worst case for settle: 256 commits from distinct solvers, all revealed correct (255 refunds to fresh slots)
    function test_settle_gasWorstCase() public {
        uint256 id = _post(_ans(1));
        for (uint256 k; k < 256; ++k) {
            address s = address(uint160(0x10000 + k));
            vm.deal(s, 1 ether);
            _commit(s, id, _ans(1));
        }
        skip(1);
        for (uint256 k; k < 256; ++k) {
            _reveal(address(uint160(0x10000 + k)), id, k, _ans(1));
        }
        vm.prank(poster);
        uint256 g = gasleft();
        b.settle(id, _ans(1), SALT);
        g -= gasleft();
        emit log_named_uint("settle gas, 256 correct reveals", g);
        assertLt(g, 15_000_000, "well under the 32M per-tx limit");
        assertEq(b.questionOf(id).winner, address(0x10000));
        _checkIdentity();
    }

    /// APP's vectors (web/shared/test/vectors.json, made with cast) == the contract's formulas, selectors and topics
    function test_appVectors() public view {
        address solver = 0xBDf9D692De4287972376F019f2a86a9CaC4aA3a1;
        bytes32 salt = 0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff;
        bytes32 nonce = 0xfeedfacecafebeef000000000000000000000000000000000000000000000001;
        bytes32 a449 = bytes32(uint256(449));
        bytes32 aPool = bytes32(uint256(uint160(0x62AB521f71431f78ac374CdbadC6cda3c8916b6C)));
        bytes32 aTx = 0x9c3f1e2b4a5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7;
        assertEq(b.answerHashOf(42, a449, salt), 0x86e0b88a0716a0b435b698deaeb57afbacb23c70117fb474712c6cbc56833e14);
        assertEq(b.answerHashOf(7, aPool, salt), 0x7e582d5f46cefda6993971388dcd8f126bade658d25dd9b67f9fc7bc1feb389b);
        assertEq(
            b.commitHashOf(42, solver, a449, nonce), 0x725ccf73a8756d17894acc2cf8cfbc783056d994f7c32c92d98905638a6bb53c
        );
        assertEq(
            b.commitHashOf(7, solver, aPool, nonce), 0x816737ade82cd15b360930368d1ef300ba4788a10a2d81f784217bdfeeaddad5
        );
        assertEq(
            b.commitHashOf(123456, solver, aTx, nonce),
            0x03f5c5c3665c2bfa482f29b7a435e0a3a8818b4e2a08d9919fe5aeba2541ec2c
        );
        assertEq(KeelBoard.commit.selector, bytes4(0x1cd98bce));
        assertEq(KeelBoard.reveal.selector, bytes4(0xd864909a));
        assertEq(KeelBoard.topUp.selector, bytes4(0x50017f3e));
        assertEq(KeelBoard.Committed.selector, 0xf5a0f30f1e0b85bcaf31d919924866d9a5a6eeafbc3709c8fbcfc79a18d3c76e);
        assertEq(bytes32("claude-opus-4"), 0x636c617564652d6f7075732d3400000000000000000000000000000000000000);
    }
}
