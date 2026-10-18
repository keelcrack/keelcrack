// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PonsLaunchedToken} from "../../src/interfaces/IPons.sol";

// Pons V2 mocks: same behaviour as the verified sources for the slices
// KeelBoard calls (curve sweep → escrow credit → escrow claim with a full-gas call to msg.sender).

contract MockERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A token whose transfer always reverts (harvest's burn must stay best-effort).
contract RevertingERC20 is ERC20 {
    constructor() ERC20("Stuck", "TEST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address, uint256) public pure override returns (bool) {
        revert("stuck");
    }
}

/// PonsV2FeeEscrow slice: credit{value} per recipient, claim() pays msg.sender with a full-gas call.
contract MockEscrow {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public balanceOfToken;
    bool public failClaim;

    function setFailClaim(bool v) external {
        failClaim = v;
    }

    function credit(address recipient) external payable {
        balanceOf[recipient] += msg.value;
    }

    function creditToken(address recipient, address token, uint256 amount) external {
        ERC20(token).transferFrom(msg.sender, address(this), amount);
        balanceOfToken[recipient][token] += amount;
    }

    function claim() external returns (uint256 amount) {
        require(!failClaim, "ClaimDisabled");
        amount = balanceOf[msg.sender];
        balanceOf[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "TransferFailed");
    }

    function claimToken(address token) external returns (uint256 amount) {
        amount = balanceOfToken[msg.sender][token];
        balanceOfToken[msg.sender][token] = 0;
        ERC20(token).transfer(msg.sender, amount);
    }
}

contract MockPonsFactory {
    mapping(address => PonsLaunchedToken) internal _lt;
    bool public broken;

    function set(PonsLaunchedToken memory lt) external {
        _lt[lt.token] = lt;
    }

    function setRecipient(address token, address r) external {
        _lt[token].creatorFeeRecipient = r;
    }

    function setPhase(address token, uint8 phase) external {
        _lt[token].phase = phase;
    }

    function setPairToken(address token, address pair) external {
        _lt[token].pairToken = pair;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function getLaunchedToken(address token) external view returns (PonsLaunchedToken memory) {
        require(!broken, "broken");
        return _lt[token];
    }
}

/// Bonding-curve slice: fees accrue here, sweepFees (recipient only) credits the escrow.
contract MockCurve {
    MockEscrow public immutable escrow;
    uint256 public pendingFees;
    address public recipient;
    bool public operatorOnly; // simulates InternalSwapRequiresOperator()

    constructor(MockEscrow e) {
        escrow = e;
    }

    function setRecipient(address r) external {
        recipient = r;
    }

    function setOperatorOnly(bool v) external {
        operatorOnly = v;
    }

    function accrue() external payable {
        pendingFees += msg.value;
    }

    function sweepFees(uint256) external {
        require(msg.sender == recipient, "NotFeeSweepOperator");
        require(!operatorOnly, "InternalSwapRequiresOperator");
        uint256 a = pendingFees;
        pendingFees = 0;
        escrow.credit{value: a}(recipient);
    }

    /// the Pons operator's sweep (credits without the recipient check)
    function operatorSweep() external {
        uint256 a = pendingFees;
        pendingFees = 0;
        escrow.credit{value: a}(recipient);
    }

    /// owner rescue path: pushes ETH straight to the recipient with a full-gas call
    function rescue() external {
        uint256 a = pendingFees;
        pendingFees = 0;
        (bool ok,) = recipient.call{value: a}("");
        require(ok, "rescue failed");
    }

    receive() external payable {}
}

contract MockHook {
    MockEscrow public immutable escrow;
    address public recipient;
    uint256 public pendingFees;
    bytes32 public lastPoolId;

    constructor(MockEscrow e) {
        escrow = e;
    }

    function setRecipient(address r) external {
        recipient = r;
    }

    function accrue() external payable {
        pendingFees += msg.value;
    }

    function sweepPoolFees(bytes32 poolId, uint256, uint256) external {
        require(msg.sender == recipient, "NotFeeSweepOperator");
        lastPoolId = poolId;
        uint256 a = pendingFees;
        pendingFees = 0;
        escrow.credit{value: a}(recipient);
    }
}

/// A receiver that rejects ETH (claim / withdrawInfra must revert TransferFailed and keep the amount).
contract Rejecter {
    receive() external payable {
        revert("no");
    }
}

/// A contract solver: commits / reveals / claims through call_, and can re-enter the board from receive().
contract ContractSolver {
    address public target;
    bytes public reenterData;
    bool public reenterOk;
    bytes public reenterRet;

    function call_(address t, uint256 value, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = t.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    function arm(address t, bytes calldata data) external {
        target = t;
        reenterData = data;
    }

    receive() external payable {
        if (target != address(0)) {
            address t = target;
            target = address(0);
            (reenterOk, reenterRet) = t.call(reenterData);
        }
    }
}

/// Sends ETH with transfer() (2300-gas stipend).
contract StipendSender {
    function send_(address payable to) external payable {
        to.transfer(msg.value);
    }
}
