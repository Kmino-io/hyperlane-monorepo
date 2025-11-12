// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20} from "../HypERC20.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {TokenMessage} from "../libs/TokenMessage.sol";

/**
 * @title ExampleCustomToken
 * @notice An example custom token demonstrating how to create custom warp routes
 * @dev This contract extends HypERC20 with custom functionality like fee collection and max supply
 */
/**
 * NOTE: HypERC20 no longer exposes virtual hooks like `_transferTo`. Always override `_handle`
 * to plug in any custom mint/fee logic for inbound messages.
 */
contract ExampleCustomToken is HypERC20 {
    using TypeCasts for bytes32;
    using TokenMessage for bytes;
    // ============ Custom State Variables ============

    /// @notice Address that receives transfer fees
    address public feeCollector;

    /// @notice Fee percentage in basis points (100 = 1%)
    uint256 public feeBps;

    /// @notice Maximum token supply allowed
    uint256 public maxSupply;

    /// @notice Whether the contract is paused
    bool public paused;

    // ============ Events ============

    event FeeCollected(address indexed from, uint256 amount);
    event PauseToggled(bool paused);
    event FeeUpdated(uint256 newFeeBps);

    // ============ Errors ============

    error MaxSupplyExceeded();
    error ContractPaused();
    error InvalidFeeCollector();
    error FeeTooHigh();

    // ============ Constructor ============

    /**
     * @param _decimals Number of decimals for the token (typically 18)
     * @param _mailbox Address of the Hyperlane mailbox for cross-chain messaging
     * @param _feeCollector Address that will receive transfer fees
     * @param _feeBps Initial fee in basis points (100 = 1%, max 1000 = 10%)
     * @param _maxSupply Maximum total supply allowed (in token units with decimals)
     */
    constructor(
        uint8 _decimals,
        address _mailbox,
        address _feeCollector,
        uint256 _feeBps,
        uint256 _maxSupply
    ) HypERC20(_decimals, 1, _mailbox) {
        if (_feeCollector == address(0)) revert InvalidFeeCollector();
        if (_feeBps > 1000) revert FeeTooHigh(); // Max 10% fee

        feeCollector = _feeCollector;
        feeBps = _feeBps;
        maxSupply = _maxSupply;
        paused = false;

        _disableInitializers();
    }

    // ============ Custom Functions ============

    /**
     * @notice Toggle pause status of the contract
     * @dev Only owner can pause/unpause
     */
    function togglePause() external onlyOwner {
        paused = !paused;
        emit PauseToggled(paused);
    }

    /**
     * @notice Update the fee percentage
     * @param _newFeeBps New fee in basis points (max 1000 = 10%)
     */
    function updateFee(uint256 _newFeeBps) external onlyOwner {
        if (_newFeeBps > 1000) revert FeeTooHigh();
        feeBps = _newFeeBps;
        emit FeeUpdated(_newFeeBps);
    }

    /**
     * @notice Update fee collector address
     * @param _newCollector New address to receive fees
     */
    function updateFeeCollector(address _newCollector) external onlyOwner {
        if (_newCollector == address(0)) revert InvalidFeeCollector();
        feeCollector = _newCollector;
    }

    // ============ Overrides ============

    /**
     * @dev Override transfer to add fee collection and pause check
     */
    function _transfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        if (paused) revert ContractPaused();

        if (feeBps > 0) {
            uint256 fee = (amount * feeBps) / 10000;
            if (fee > 0) {
                super._transfer(from, feeCollector, fee);
                emit FeeCollected(from, fee);
            }
            super._transfer(from, to, amount - fee);
        } else {
            super._transfer(from, to, amount);
        }
    }

    /**
     * @dev Override mint to enforce max supply
     */
    function _mint(address account, uint256 amount) internal virtual override {
        if (totalSupply() + amount > maxSupply) revert MaxSupplyExceeded();
        super._mint(account, amount);
    }

    /**
     * @dev Override handle to apply fees and respect pause state on inbound transfers.
     */
    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal virtual override {
        // All custom bridging logic must happen here. HypERC20 does not allow overriding the lower-level hooks.
        if (paused) revert ContractPaused();

        bytes32 recipientBytes = _message.recipient();
        uint256 amount = _message.amount();

        emit ReceivedTransferRemote(_origin, recipientBytes, amount);

        address recipient = recipientBytes.bytes32ToAddress();
        uint256 localAmount = _inboundAmount(amount);
        uint256 fee = (localAmount * feeBps) / 10000;

        if (fee > 0) {
            _mint(feeCollector, fee);
            emit FeeCollected(recipient, fee);
        }

        _mint(recipient, localAmount - fee);
    }
}
