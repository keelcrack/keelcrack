// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal slices of the verified Pons V2 contracts on Robinhood Chain (Sourcify, chain 4663).
// Source of truth: ../161. Wildcap/contracts/PONS-FEES.md + the verified sources of PonsV2LaunchFactory /
// PonsV2BondingCurve / PonsV2MemeHook / PonsV2FeeEscrow (compiler 0.8.35). Copied from 171 Markup Machine; only what
// KeelBoard calls is declared here (copied from 176 Dipsiege / 174 Swardbow).

struct PonsLaunchedToken {
    address token;
    address curve;
    address deployer;
    address creatorFeeRecipient;
    address pairToken; // address(0) = native ETH
    uint256 graduationThreshold;
    uint24 poolFee;
    int24 tickSpacing;
    uint16 creatorTaxBps;
    bool buybackEnabled;
    uint8 phase; // GraduationPhase: 0 NotGraduated, 1 Swept, 2 PoolCreated, 3 Rescued
    uint256 sweptQuote;
    uint256 sweptTokens;
    uint256 sweptAt;
    bool exists;
}

interface IPonsV2LaunchFactory {
    function getLaunchedToken(address token) external view returns (PonsLaunchedToken memory);
    /// @dev msg.sender must be the current creatorFeeRecipient
    function transferCreatorFeeRecipient(address token, address newRecipient) external;
}

interface IPonsV2BondingCurve {
    /// operator or the creator fee recipient; the recipient only while no buyback swap is pending
    function sweepFees(uint256 minBuybackTokensOut) external;
    function creatorTaxBalance() external view returns (uint256);
    function quoteFeeBalance() external view returns (uint256);
    function graduated() external view returns (bool);
}

interface IPonsV2MemeHook {
    /// operator or the pool's creator; the creator only while no memecoin-denominated fee / buyback is pending
    function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut) external;
}

interface IPonsV2FeeEscrow {
    function claim() external returns (uint256 amount); // pays msg.sender in native ETH (full-gas call)
    function claimToken(address token) external returns (uint256 amount);
    function balanceOf(address recipient) external view returns (uint256);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
}
