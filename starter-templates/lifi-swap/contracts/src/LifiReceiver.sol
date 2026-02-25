// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IReceiver} from "../keystone/IReceiver.sol";
import {IERC165} from "../keystone/IERC165.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @title LifiReceiver - CRE receiver that executes single or cross-chain swap from LI.FI API
/// @notice User must approve this contract for tokenIn before CRE workflow runs.
/// @dev Decodes report as (address target, bytes callData, uint256 value, address tokenIn, uint256 amountIn, address recipient).
contract LifiReceiver is IReceiver {
    event SwapExecuted(address indexed target, address indexed tokenIn, uint256 amountIn);
    event NativeSwapExecuted(address indexed target, uint256 value);

    function onReport(bytes calldata /* metadata */, bytes calldata report) external override {
        (
            address target,
            bytes memory callData,
            uint256 value,
            address tokenIn,
            uint256 amountIn,
            address recipient
        ) = abi.decode(
            report,
            (address, bytes, uint256, address, uint256, address)
        );

        // If the swap requires an ERC20 token input
        if (tokenIn != address(0) && amountIn > 0) {
            // 1. Pull tokenIn from recipient (user must have approved this contract)
            require(
                IERC20(tokenIn).transferFrom(recipient, address(this), amountIn),
                "LifiReceiver: transferFrom failed"
            );

            // 2. Approve the LI.FI target router (usually Diamond) to spend tokenIn
            require(
                IERC20(tokenIn).approve(target, amountIn),
                "LifiReceiver: approve failed"
            );
        }

        // 3. Execute the low-level call returned from LI.FI
        (bool success, bytes memory revertData) = target.call{value: value}(callData);
        if (!success) {
            assembly {
                revert(add(revertData, 32), mload(revertData))
            }
        }

        if (tokenIn != address(0)) {
            emit SwapExecuted(target, tokenIn, amountIn);
        } else {
            emit NativeSwapExecuted(target, value);
        }
    }

    // Needed to properly handle native token sweeps if the swap returns native tokens directly here (though usually it returns to 'recipient' per LI.FI payload)
    receive() external payable {}

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return
            interfaceId == type(IReceiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }
}
