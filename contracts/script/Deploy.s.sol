// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {KeelBoard} from "../src/KeelBoard.sol";

/// Deploys KeelBoard on Robinhood Chain mainnet (4663) — single contract, no proxy.
///
///   Dry run (simulation only, nothing is sent; writes deployments/<chainid>.dryrun.json):
///     forge script script/Deploy.s.sol --rpc-url robinhood_fork --sender 0xbEDda6e56d5d98A14B90De2Ba7f563079107a875
///   Real deploy — the LEAD does this with the user; the signer is chosen on the CLI, this file never reads a key
///   (writes deployments/<chainid>.json):
///     forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --account keelcrack-deployer
///
/// Env (all optional): OWNER (team wallet: infra, key rotation, unpause), PAUSER (pause only) — default on 4663: the
/// lead's deployer 0xbEDd…a875; POSTER (server key: post, settle) — default on 4663: the lead's keeper 0xBDf9…A3a1
/// (BRIEF change log 16-10-2026); elsewhere all three default to the sender. MIN_BOND (wei, default
/// 300000000000000 = 0.0003 ETH). PONS_FACTORY, FEE_ESCROW, MEME_HOOK (default: the RC mainnet addresses of the BRIEF),
/// ALLOW_ANY_CHAIN=1 (anvil / other chains).
contract Deploy is Script {
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant FEE_ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant MEME_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    uint256 constant DEFAULT_MIN_BOND = 0.0003 ether;
    // the lead's wallets (BRIEF change log 16-10-2026): keystores keelcrack-deployer / keelcrack-keeper
    address constant LEAD_DEPLOYER = 0xbEDda6e56d5d98A14B90De2Ba7f563079107a875; // owner + pauser
    address constant LEAD_KEEPER = 0xBDf9D692De4287972376F019f2a86a9CaC4aA3a1; // poster

    struct Params {
        address owner;
        address poster;
        address pauser;
        uint256 minBond;
        address ponsFactory;
        address feeEscrow;
        address memeHook;
    }

    function run() external returns (KeelBoard b) {
        bool rc = block.chainid == 4663;
        if (!vm.envOr("ALLOW_ANY_CHAIN", false)) {
            require(rc, "Robinhood Chain mainnet only (set ALLOW_ANY_CHAIN=1 to override)");
        }
        bool broadcasting = _broadcasting();

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        Params memory p = _params(sender, rc);
        if (rc) {
            require(p.ponsFactory.code.length != 0, "Pons factory code not found");
            require(p.feeEscrow.code.length != 0, "fee escrow code not found");
            require(p.memeHook.code.length != 0, "meme hook code not found");
        }
        b = new KeelBoard(p.owner, p.poster, p.pauser, p.minBond, p.ponsFactory, p.feeEscrow, p.memeHook);
        vm.stopBroadcast();

        console.log("KeelBoard", address(b));
        console.log("chain", block.chainid, "block.number (L1 number on RC)", block.number);
        console.log("owner ", b.owner());
        console.log("poster", b.poster());
        console.log("pauser", b.pauser());
        console.log("MIN_BOND (wei)", b.MIN_BOND());
        console.log("runtime size (bytes)", address(b).code.length);
        if (p.poster == p.owner) console.log("NOTE: poster == owner (set POSTER to the server key)");
        console.log("Next: launch the token on Pons V2 with creatorFeeRecipient = KeelBoard, native ETH pair,");
        console.log("creatorTaxBps 200, buybackEnabled = false; then bind(token) from the owner (or manual mode).");

        _write(b, broadcasting);
    }

    function _params(address sender, bool rc) internal view returns (Params memory p) {
        p.owner = vm.envOr("OWNER", rc ? LEAD_DEPLOYER : sender);
        p.poster = vm.envOr("POSTER", rc ? LEAD_KEEPER : sender);
        p.pauser = vm.envOr("PAUSER", rc ? LEAD_DEPLOYER : sender);
        p.minBond = vm.envOr("MIN_BOND", DEFAULT_MIN_BOND);
        p.ponsFactory = vm.envOr("PONS_FACTORY", PONS_FACTORY);
        p.feeEscrow = vm.envOr("FEE_ESCROW", FEE_ESCROW);
        p.memeHook = vm.envOr("MEME_HOOK", MEME_HOOK);
    }

    function _broadcasting() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }

    function _write(KeelBoard b, bool broadcasting) internal {
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "board", address(b));
        vm.serializeAddress(obj, "owner", b.owner());
        vm.serializeAddress(obj, "poster", b.poster());
        vm.serializeAddress(obj, "pauser", b.pauser());
        vm.serializeString(obj, "minBondWei", vm.toString(b.MIN_BOND()));
        vm.serializeAddress(obj, "ponsFactory", b.ponsFactory());
        vm.serializeAddress(obj, "feeEscrow", b.feeEscrow());
        vm.serializeAddress(obj, "memeHook", b.memeHook());
        vm.serializeUint(obj, "infraBps", b.INFRA_BPS());
        vm.serializeUint(obj, "dripBps", b.DRIP_BPS());
        vm.serializeUint(obj, "dripInterval", b.DRIP_INTERVAL());
        vm.serializeUint(obj, "bondBps", b.BOND_BPS());
        vm.serializeUint(obj, "revealWindow", b.REVEAL_WINDOW());
        vm.serializeUint(obj, "keyTimelock", b.KEY_TIMELOCK());
        vm.serializeUint(obj, "maxOpen", b.MAX_OPEN());
        vm.serializeUint(obj, "maxCommits", b.MAX_COMMITS());
        vm.serializeUint(obj, "deployBlock", block.number);
        vm.serializeBool(obj, "dryRun", !broadcasting);
        string memory json = vm.serializeString(
            obj,
            "note",
            "token not bound yet; bind(token) after the Pons launch if creatorFeeRecipient = board, else manual fee mode. "
            "deployBlock is the contract's block.number (L1 number on RC); take the L2 block from the deploy tx receipt."
        );
        string memory path =
            string.concat("deployments/", vm.toString(block.chainid), broadcasting ? ".json" : ".dryrun.json");
        vm.writeJson(json, path);
        console.log("wrote", path);
    }
}
