// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {KeelBoard} from "../../src/KeelBoard.sol";
import {PonsLaunchedToken, IPonsV2LaunchFactory, IPonsV2FeeEscrow} from "../../src/interfaces/IPons.sol";

// Pons V2 factory / curve slices for the fork.
struct Socials {
    string twitter;
    string telegram;
    string discord;
    string website;
    string farcaster;
}

struct TokenParams {
    string name;
    string symbol;
    string logo;
    string description;
    Socials socials;
    address creatorFeeRecipient;
    uint16 creatorTaxBps;
    bool buybackEnabled;
    bytes32 expectedEconomics;
    bytes32 salt;
}

interface IPonsFactoryFull {
    function launchFee() external view returns (uint256);
    function launchToken(TokenParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, address curve);
}

interface ICurveFull {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
    function creatorTaxBalance() external view returns (uint256);
    function deployer() external view returns (address);
}

/// End-to-end on a Robinhood Chain mainnet fork with the REAL Pons V2 factory / curve / fee escrow / meme hook:
///   forge test --match-path 'test/fork/*' -vv                       (default RPC https://robinhood.drpc.org)
///   FORK_RPC=<url> forge test --match-path 'test/fork/*' -vv
///   SKIP_FORK=1 forge test                                           (offline)
/// Skips cleanly when the RPC is unreachable. Nothing is broadcast: a local fork only.
contract BoardForkTest is Test {
    address constant PONS = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    uint256 constant MIN_BOND = 0.0003 ether;
    bytes32 constant SALT = keccak256("fork-salt");

    KeelBoard b;
    address token;
    address curve;
    address owner = makeAddr("owner");
    address poster = makeAddr("poster");
    address pauser = makeAddr("pauser");
    address creator = makeAddr("creator");
    address trader = makeAddr("trader");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function _fork() internal returns (bool) {
        if (vm.envOr("SKIP_FORK", false)) {
            vm.skip(true);
            return false;
        }
        string memory rpc = vm.envOr("FORK_RPC", string("https://robinhood.drpc.org"));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return false;
        }
        try vm.createSelectFork(rpc) returns (uint256) {}
        catch {
            console.log("fork RPC unreachable, skipping:", rpc);
            vm.skip(true);
            return false;
        }
        assertEq(block.chainid, 4663, "Robinhood Chain mainnet");
        vm.deal(trader, 1000 ether);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
        b = new KeelBoard(owner, poster, pauser, MIN_BOND, PONS, ESCROW, HOOK);
        return true;
    }

    function _launchPons() internal {
        TokenParams memory p;
        p.name = "Fork Test Token";
        p.symbol = "TEST"; // Pons requires a symbol; generic placeholder on a local fork only
        p.creatorFeeRecipient = address(b);
        p.creatorTaxBps = 200; // the BRIEF's 2% creator tax
        p.buybackEnabled = false;
        p.salt = keccak256(abi.encode(block.timestamp, address(b)));
        uint256 fee = IPonsFactoryFull(PONS).launchFee();
        vm.deal(creator, fee);
        vm.prank(creator);
        (token, curve) = IPonsFactoryFull(PONS).launchToken{value: fee}(p, 0, address(0));
        assertEq(ICurveFull(curve).deployer(), address(b), "curve pays the board");
        PonsLaunchedToken memory lt = IPonsV2LaunchFactory(PONS).getLaunchedToken(token);
        assertEq(lt.creatorFeeRecipient, address(b));
        assertEq(lt.pairToken, address(0), "native ETH pair");
        assertEq(lt.creatorTaxBps, 200);
        assertFalse(lt.buybackEnabled);
        assertEq(lt.phase, 0, "curve phase");
        vm.prank(owner);
        b.bind(token);
        assertEq(b.token(), token);
        skip(60); // past the snipe-tax window
    }

    function _trade(uint256 ethIn) internal {
        vm.startPrank(trader);
        uint256 out = ICurveFull(curve).buy{value: ethIn}(ethIn, 0, trader);
        IERC20(token).approve(curve, out / 2);
        ICurveFull(curve).sell(out / 2, 0, trader);
        vm.stopPrank();
    }

    function _checkIdentity() internal view {
        (uint256 pool, uint256 infra, uint256 totalLoad,,) = b.stats();
        (uint256 bonds, uint256 owedSum) = b.held();
        assertEq(address(b).balance, pool + infra + totalLoad + bonds + owedSum, "balance identity");
    }

    function _pool() internal view returns (uint256 p) {
        (p,,,,) = b.stats();
    }

    function _commit(address who, uint256 id, bytes32 answer, bytes32 nonce, bytes32 model) internal returns (uint256) {
        uint256 bond = b.bondFor(id);
        vm.prank(who);
        return b.commit{value: bond}(id, keccak256(abi.encode(id, who, answer, nonce)), model);
    }

    // ═════════════════════════════ tests ═════════════════════════════

    /// Pons / escrow / hook / WETH / Multicall3 code at the BRIEF addresses; runtime size; L1 block.number
    function test_fork_addresses() public {
        if (!_fork()) return;
        assertGt(PONS.code.length, 0, "Pons factory");
        assertGt(ESCROW.code.length, 0, "fee escrow");
        assertGt(HOOK.code.length, 0, "meme hook");
        assertGt(WETH.code.length, 0, "WETH");
        assertGt(MULTICALL3.code.length, 0, "Multicall3");
        console.log("KeelBoard runtime size (bytes):", address(b).code.length);
        assertLt(address(b).code.length, 24_576, "EIP-170");
        console.log("block.timestamp", block.timestamp, "block.number (L1 on RC)", block.number);
    }

    /// Real Pons launch with creatorFeeRecipient = board → trades → harvest of real creator fees (80/20) → one full
    /// question lifecycle (post, drip, topUp, commit ×3, reveal, settle by the contract's rule, claims) → an unsolved
    /// question at close → infra withdraw. The identity holds after every step.
    function test_fork_fullLifecycle() public {
        if (!_fork()) return;

        // ── harvest never reverts: nothing bound, nothing new ──
        b.harvest();
        vm.prank(trader);
        b.harvest();
        assertEq(b.harvestedWei(), 0);

        // ── manual mode: plain transfer (call) splits 80/20 at once ──
        vm.prank(trader);
        (bool ok,) = payable(address(b)).call{value: 0.1 ether}("");
        assertTrue(ok);
        assertEq(_pool(), 0.08 ether);
        _checkIdentity();

        // ── Pons mode: real launch, real trades, curve sweep + escrow claim inside harvest ──
        _launchPons();
        b.harvest(); // bound, nothing yet: must not revert
        _trade(1.5 ether); // below the 4.2 ETH graduation threshold
        uint256 tax = ICurveFull(curve).creatorTaxBalance();
        assertGt(tax, 0, "creator tax accrued on the curve");
        emit log_named_decimal_uint("creator tax on the curve (2%)", tax, 18);
        b.harvest();
        assertEq(IPonsV2FeeEscrow(ESCROW).balanceOf(address(b)), 0, "escrow drained");
        assertEq(ICurveFull(curve).creatorTaxBalance(), 0, "curve swept");
        uint256 harvested = b.harvestedWei();
        emit log_named_decimal_uint("ETH harvested (transfer + Pons)", harvested, 18);
        assertGt(harvested - 0.1 ether, tax, "tax + creator share of the base fee");
        (uint256 pool, uint256 infra,,,) = b.stats();
        assertApproxEqAbs(infra, (harvested * 2000) / 10_000, 1, "20% infra");
        assertEq(pool + infra, harvested, "80/20 of everything");
        assertEq(IERC20(token).balanceOf(address(b)), 0, "no launched token held");
        _checkIdentity();

        // ── question 1: "which Pons token was launched in this window?" (answer = the real launch address) ──
        bytes32 truth = bytes32(uint256(uint160(token)));
        (,,,, uint256 count) = b.stats();
        uint256 id = count + 1;
        vm.prank(poster);
        assertEq(
            b.post(keccak256(abi.encode(id, truth, SALT)), keccak256("q1 json"), 2, uint64(block.timestamp + 1 days)),
            id
        );
        // second question (stays unsolved)
        bytes32 truth2 = bytes32(uint256(42));
        vm.prank(poster);
        uint256 id2 = b.post(
            keccak256(abi.encode(id + 1, truth2, SALT)), keccak256("q2 json"), 1, uint64(block.timestamp + 1 days)
        );

        b.drip(); // 1% of the pool over the 2 live questions
        uint256 per = b.questionOf(id).load;
        assertEq(per, (pool / 100) / 2);
        vm.prank(trader);
        b.topUp{value: 0.01 ether}(id);
        uint256 load = per + 0.01 ether;
        _checkIdentity();

        uint256 bond = b.bondFor(id);
        assertEq(bond, load * 500 / 10_000 > MIN_BOND ? load * 500 / 10_000 : MIN_BOND);
        uint256 ia = _commit(alice, id, truth, "na", bytes32("model-a"));
        skip(1);
        uint256 ib = _commit(bob, id, bytes32(uint256(uint160(WETH))), "nb", bytes32("model-b")); // wrong
        uint256 ic = _commit(carol, id, truth, "nc", bytes32("model-c")); // correct, later
        uint256 bond2 = b.bondFor(id2);
        _commit(bob, id2, truth2, "nb2", bytes32("model-b")); // never revealed
        skip(2);
        vm.prank(carol);
        b.reveal(id, ic, truth, "nc");
        vm.prank(bob);
        b.reveal(id, ib, bytes32(uint256(uint160(WETH))), "nb");
        // alice (index 0) is still inside her window: the keeper must wait
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.EarlierCommitPending.selector, 0));
        b.settle(id, truth, SALT);
        skip(1 minutes);
        vm.prank(alice);
        b.reveal(id, ia, truth, "na");
        uint256 poolBefore = _pool();
        vm.prank(poster);
        b.settle(id, truth, SALT);
        KeelBoard.Question memory q = b.questionOf(id);
        assertEq(uint8(q.status), 2, "Solved");
        assertEq(q.winner, alice, "earliest correct commit wins");
        assertEq(b.owed(alice), load + bond);
        assertEq(b.owed(carol), bond, "later correct: bond back");
        assertEq(b.owed(bob), 0);
        assertEq(_pool(), poolBefore + bond, "wrong bond -> pool");
        _checkIdentity();

        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        b.claim();
        assertEq(alice.balance, aliceBefore + load + bond);
        vm.prank(carol);
        b.claim();
        emit log_named_decimal_uint("bounty paid (load)", load, 18);

        // ── question 2 unsolved at close ──
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(KeelBoard.NotClosed.selector, id2));
        b.settle(id2, truth2, SALT);
        skip(1 days);
        uint256 load2 = b.questionOf(id2).load;
        poolBefore = _pool();
        vm.prank(poster);
        b.settle(id2, truth2, SALT);
        assertEq(uint8(b.questionOf(id2).status), 3, "Unsolved");
        assertEq(_pool(), poolBefore + load2 + bond2, "load + unrevealed bond -> pool");
        assertEq(b.openIds().length, 0);
        _checkIdentity();

        // ── more trades, harvest again, then the owner takes infra ──
        _trade(1 ether);
        b.harvest();
        assertGt(b.harvestedWei(), harvested);
        (, infra,,,) = b.stats();
        address to = makeAddr("infraTo");
        vm.prank(owner);
        b.withdrawInfra(to);
        assertEq(to.balance, infra);
        _checkIdentity();
        (pool,,,,) = b.stats();
        assertEq(address(b).balance, pool, "only the pool is left");
    }

    /// a buy that crosses the graduation threshold: the creator share is credited to the escrow at graduation; harvest
    /// (graduated phase, hook sweep in try/catch) never reverts and collects it
    function test_fork_graduationHarvest() public {
        if (!_fork()) return;
        _launchPons();
        vm.prank(trader);
        ICurveFull(curve).buy{value: 5 ether}(5 ether, 0, trader);
        PonsLaunchedToken memory lt = IPonsV2LaunchFactory(PONS).getLaunchedToken(token);
        console.log("phase after graduation", lt.phase);
        assertGt(lt.phase, 0, "graduated");
        uint256 credited = IPonsV2FeeEscrow(ESCROW).balanceOf(address(b));
        assertGt(credited, 0, "creator share credited at graduation");
        b.harvest();
        b.harvest();
        assertEq(b.harvestedWei(), credited);
        emit log_named_decimal_uint("harvested at graduation", credited, 18);
        _checkIdentity();
    }

    /// bind guard rails on the real factory
    function test_fork_bindGuards() public {
        if (!_fork()) return;
        vm.prank(owner);
        vm.expectRevert(KeelBoard.TokenNotFound.selector);
        b.bind(WETH);
        TokenParams memory p;
        p.name = "Other";
        p.symbol = "TEST";
        p.creatorFeeRecipient = creator;
        p.creatorTaxBps = 200;
        p.salt = keccak256("other");
        uint256 fee = IPonsFactoryFull(PONS).launchFee();
        vm.deal(creator, fee);
        vm.prank(creator);
        (address other,) = IPonsFactoryFull(PONS).launchToken{value: fee}(p, 0, address(0));
        vm.prank(owner);
        vm.expectRevert(KeelBoard.NotRecipient.selector);
        b.bind(other);
        b.harvest();
    }
}
