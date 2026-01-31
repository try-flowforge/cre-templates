// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Script, console} from "forge-std/Script.sol";
import {SwapReceiver} from "../src/SwapReceiver.sol";

contract DeploySwapReceiver is Script {
    function run() external {
        vm.startBroadcast();
        SwapReceiver receiver = new SwapReceiver();
        console.log("SwapReceiver deployed at:", address(receiver));
        vm.stopBroadcast();
    }
}
