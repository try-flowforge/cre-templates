// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IReceiver} from "./keystone/IReceiver.sol";
import {IERC165} from "./keystone/IERC165.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title SwapReceiver - CRE receiver that executes Uniswap V4 swap from report payload
/// @notice User must approve this contract for tokenIn (source currency) before CRE workflow runs.
/// @dev Uses Uniswap V4 PoolSwapTest (official test router) for swaps. Report format:
///      (currency0, currency1, fee, tickSpacing, hooks, zeroForOne, amountIn, amountOutMin, hookData, recipient, deadline, poolSwapTestAddress, poolManagerAddress, sqrtPriceLimitX96)
contract SwapReceiver is IReceiver {
    function onReport(bytes calldata /* metadata */, bytes calldata report) external override {
        (
            address currency0Addr,
            address currency1Addr,
            uint24 fee,
            int24 tickSpacing,
            address hooksAddr,
            bool zeroForOne,
            uint256 amountIn,
            uint256 amountOutMin,
            bytes memory hookData,
            address recipient,
            uint256 deadline,
            address poolSwapTestAddress,
            address poolManagerAddress,
            uint160 sqrtPriceLimitX96
        ) = abi.decode(
            report,
            (address, address, uint24, int24, address, bool, uint256, uint256, bytes, address, uint256, address, address, uint160)
        );

        require(block.timestamp <= deadline, "SwapReceiver: deadline exceeded");
        require(poolSwapTestAddress != address(0), "SwapReceiver: poolSwapTestAddress required");
        require(poolManagerAddress != address(0), "SwapReceiver: poolManagerAddress required");

        Currency currency0 = Currency.wrap(currency0Addr);
        Currency currency1 = Currency.wrap(currency1Addr);
        IHooks hooks = IHooks(hooksAddr);

        PoolKey memory poolKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: hooks
        });

        address tokenIn = zeroForOne ? currency0Addr : currency1Addr;

        // Pull tokenIn from recipient (user must have approved this contract)
        require(
            IERC20(tokenIn).transferFrom(recipient, address(this), amountIn),
            "SwapReceiver: transferFrom failed"
        );

        // PoolSwapTest settles from msg.sender (this) to PoolManager; approve PoolManager
        require(
            IERC20(tokenIn).approve(poolManagerAddress, amountIn),
            "SwapReceiver: approve failed"
        );

        SwapParams memory params = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: sqrtPriceLimitX96
        });

        PoolSwapTest.TestSettings memory testSettings = PoolSwapTest.TestSettings({
            takeClaims: false,
            settleUsingBurn: false
        });

        bytes memory hookDataParam = hookData.length > 0 ? hookData : new bytes(0);
        PoolSwapTest(payable(poolSwapTestAddress)).swap(
            poolKey,
            params,
            testSettings,
            hookDataParam
        );

        // Output tokens are taken to recipient by PoolSwapTest (take uses data.sender = msg.sender = this)
        // Actually PoolSwapTest takes to data.sender which is msg.sender of swap() = this contract.
        // So we receive the output tokens. We need to forward them to recipient.
        // Let me check PoolSwapTest again - data.sender is msg.sender of swap(), so it's SwapReceiver.
        // The take(manager, data.sender, amount) sends tokens from PoolManager to data.sender = SwapReceiver.
        // So SwapReceiver receives the output tokens. We need to transfer them to recipient!
        address tokenOut = zeroForOne ? currency1Addr : currency0Addr;
        uint256 balanceOut = IERC20(tokenOut).balanceOf(address(this));
        if (balanceOut > 0) {
            require(
                IERC20(tokenOut).transfer(recipient, balanceOut),
                "SwapReceiver: transfer out failed"
            );
        }
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return
            interfaceId == type(IReceiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }
}
