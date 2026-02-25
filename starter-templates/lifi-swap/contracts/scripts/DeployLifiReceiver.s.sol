// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Script, console} from "forge-std/Script.sol";
import {LifiReceiver} from "../src/LifiReceiver.sol";

contract DeployLifiReceiver is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        // Deploy LifiReceiver
        LifiReceiver receiver = new LifiReceiver();
        console.log("LifiReceiver deployed to:", address(receiver));

        vm.stopBroadcast();
    }
}
