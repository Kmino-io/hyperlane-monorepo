# Custom Token Contracts

This directory contains custom token implementations that can be automatically discovered and deployed by the Hyperlane CLI.

## How It Works

The CLI automatically scans this directory for Solidity contracts and extracts deployment information from:

- Constructor parameters
- `initialize()` function parameters
- NatSpec documentation (`@param` comments)

## Requirements

Your custom contract MUST:

1. **Extend `TokenRouter` or compatible base**
2. **Have a constructor** with required parameters
3. **Have an `initialize()` function** (if using proxy pattern)
4. **Include NatSpec comments** for better UX

## Example Custom Contract

```solidity
// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import { TokenRouter } from '../TokenRouter.sol';

/**
 * @title MyCustomToken
 * @notice A custom token with special features for XYZ protocol
 */
contract MyCustomToken is TokenRouter {
  address public specialVault;
  uint256 public maxSupply;

  /**
   * @param _decimals Token decimals (usually 18)
   * @param _mailbox Hyperlane mailbox address for cross-chain messaging
   * @param _specialVault Address of the special vault for this token
   * @param _maxSupply Maximum token supply allowed
   */
  constructor(
    uint8 _decimals,
    address _mailbox,
    address _specialVault,
    uint256 _maxSupply
  ) {
    // Constructor logic
    specialVault = _specialVault;
    maxSupply = _maxSupply;
  }

  /**
   * @param _initialSupply Initial token supply to mint
   * @param _name Token name (e.g., "My Custom Token")
   * @param _symbol Token symbol (e.g., "MCT")
   * @param _hook Post dispatch hook address
   * @param _ism Interchain security module address
   * @param _owner Contract owner address
   */
  function initialize(
    uint256 _initialSupply,
    string memory _name,
    string memory _symbol,
    address _hook,
    address _ism,
    address _owner
  ) public initializer {
    // Initialize logic
  }
}
```

## Using Custom Contracts

1. **Place your contract** in this directory
2. **Run** `hyperlane warp init`
3. **Select** your custom contract from the list
4. **Answer prompts** for constructor/initialize parameters
5. **Deploy** with `hyperlane warp deploy`

The CLI will automatically:

- Discover your contract
- Parse NatSpec comments
- Generate interactive prompts
- Handle deployment

## NatSpec Tags

Use these tags in your comments:

- `@title` - Contract title
- `@notice` - User-friendly description
- `@dev` - Developer notes
- `@param paramName` - Parameter description (MOST IMPORTANT)
- `@return` - Return value description

## Common Parameters

Your contract will typically need these standard parameters:

### Constructor

- `_decimals` - Token decimals
- `_mailbox` - Hyperlane mailbox address
- Custom parameters specific to your token

### Initialize

- `_initialSupply` - Initial token supply
- `_name` - Token name
- `_symbol` - Token symbol
- `_hook` - Post dispatch hook
- `_ism` - Interchain security module
- `_owner` - Contract owner

## Notes

- File names should match contract names
- Only `.sol` files are scanned
- Contracts are compiled automatically during deployment
- ABIs are generated and cached
