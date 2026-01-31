// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IReceiver} from "./keystone/IReceiver.sol";
import {IERC165} from "./keystone/IERC165.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice Uniswap V3 SwapRouter02 exactInputSingle params
struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
}

interface ISwapRouter {
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title SwapReceiver - CRE receiver that executes Uniswap V3 swap from report payload
/// @notice User must approve this contract for tokenIn before CRE workflow runs.
/// @dev Decodes report as (tokenIn, tokenOut, fee, recipient, amountIn, amountOutMin, deadline, routerAddress).
contract SwapReceiver is IReceiver {
    function onReport(bytes calldata /* metadata */, bytes calldata report) external override {
        (
            address tokenIn,
            address tokenOut,
            uint24 fee,
            address recipient,
            uint256 amountIn,
            uint256 amountOutMinimum,
            uint256 deadline,
            address routerAddress
        ) = abi.decode(
            report,
            (address, address, uint24, address, uint256, uint256, uint256, address)
        );

        require(block.timestamp <= deadline, "SwapReceiver: deadline exceeded");

        // Pull tokenIn from recipient (user must have approved this contract)
        require(
            IERC20(tokenIn).transferFrom(recipient, address(this), amountIn),
            "SwapReceiver: transferFrom failed"
        );

        // Approve router to spend tokenIn
        require(
            IERC20(tokenIn).approve(routerAddress, amountIn),
            "SwapReceiver: approve failed"
        );

        // Execute swap; output tokens go to recipient
        ExactInputSingleParams memory params = ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: recipient,
            amountIn: amountIn,
            amountOutMinimum: amountOutMinimum,
            sqrtPriceLimitX96: 0
        });

        ISwapRouter(routerAddress).exactInputSingle(params);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return
            interfaceId == type(IReceiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }
}
