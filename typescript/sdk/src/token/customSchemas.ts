/**
 * Dynamic Zod Schema Generation for Custom Contracts
 *
 * This module generates Zod validation schemas dynamically based on
 * custom contract metadata extracted from Solidity files.
 */
import { z } from 'zod';

import { GasRouterConfigSchema } from '../router/types.js';

import { CustomContractMetadata } from './customContracts.js';
import { TokenMetadataSchema } from './types.js';

/**
 * Converts a Solidity type to a Zod schema
 */
export function solidityTypeToZod(solidityType: string): z.ZodTypeAny {
  // Handle arrays
  if (solidityType.endsWith('[]')) {
    const baseType = solidityType.slice(0, -2);
    return z.array(solidityTypeToZod(baseType));
  }

  // Handle mappings (not typically used in constructor/initialize but just in case)
  if (solidityType.startsWith('mapping')) {
    return z.record(z.string());
  }

  // Handle specific types
  if (solidityType.startsWith('uint') || solidityType.startsWith('int')) {
    // Accept both number and string for big numbers
    return z.union([z.number(), z.string()]);
  }

  if (solidityType === 'address') {
    return z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');
  }

  if (solidityType === 'bool') {
    return z.boolean();
  }

  if (solidityType === 'string') {
    return z.string();
  }

  if (solidityType === 'bytes' || solidityType.match(/^bytes\d+$/)) {
    return z.string().regex(/^0x[a-fA-F0-9]*$/, 'Invalid hex string');
  }

  // Default: string
  return z.string();
}

/**
 * Generates a Zod schema for a custom contract's configuration
 */
export function generateCustomContractSchema(
  metadata: CustomContractMetadata,
): z.ZodObject<any> {
  const schemaShape: Record<string, z.ZodTypeAny> = {
    // Type identifier for this custom contract
    type: z.literal(metadata.name),

    // Standard fields required for all token routers
    owner: z.string(),
    mailbox: z.string().optional(),
    proxyAdmin: z
      .object({
        address: z.string(),
      })
      .optional(),
    interchainSecurityModule: z.any().optional(), // Can be string or IsmConfig

    // Origin token metadata (required for custom contracts)
    originTokenName: z.string(),
    originTokenSymbol: z.string(),
    originTokenDecimals: z.number(),

    // Initial token supply
    totalSupply: z.union([z.number(), z.string()]).optional(),
  };

  // Add constructor parameters (except standard ones)
  const standardConstructorParams = new Set([
    '_decimals',
    '_mailbox',
    'decimals',
    'mailbox',
  ]);

  for (const param of metadata.constructorParams) {
    if (!standardConstructorParams.has(param.name)) {
      const zodType = solidityTypeToZod(param.type);
      // Remove leading underscore from param name for config
      const configKey = param.name.startsWith('_')
        ? param.name.slice(1)
        : param.name;

      schemaShape[configKey] = param.description
        ? zodType.describe(param.description)
        : zodType;
    }
  }

  // Add initialize parameters (except standard ones)
  const standardInitializeParams = new Set([
    '_totalSupply',
    '_name',
    '_symbol',
    '_hook',
    '_interchainSecurityModule',
    '_ism',
    '_owner',
    'totalSupply',
    'initialSupply',
    'name',
    'symbol',
    'hook',
    'interchainSecurityModule',
    'ism',
    'owner',
  ]);

  for (const param of metadata.initializeParams) {
    if (!standardInitializeParams.has(param.name)) {
      const zodType = solidityTypeToZod(param.type);
      // Remove leading underscore from param name for config
      const configKey = param.name.startsWith('_')
        ? param.name.slice(1)
        : param.name;

      // Don't override if already added from constructor
      if (!schemaShape[configKey]) {
        schemaShape[configKey] = param.description
          ? zodType.describe(param.description)
          : zodType;
      }
    }
  }

  return z.object(schemaShape);
}

/**
 * Generates a full warp route config schema including custom contracts
 */
export function generateCustomTokenConfigSchema(
  metadata: CustomContractMetadata,
): z.ZodObject<any> {
  const baseSchema = generateCustomContractSchema(metadata);

  // Merge with token metadata and gas router schemas
  return baseSchema
    .merge(TokenMetadataSchema.partial())
    .merge(GasRouterConfigSchema);
}

/**
 * Creates a union schema of all custom contracts
 */
export function createCustomContractsUnion(
  customContracts: CustomContractMetadata[],
): z.ZodDiscriminatedUnion<'type', any> | null {
  if (customContracts.length === 0) return null;

  const schemas = customContracts.map((metadata) =>
    generateCustomTokenConfigSchema(metadata),
  );

  if (schemas.length === 1) {
    // If only one custom contract, return it wrapped in a discriminated union
    return z.discriminatedUnion('type', [schemas[0]] as any);
  }

  return z.discriminatedUnion('type', schemas as any);
}

/**
 * Helper to get custom contract config from a type string
 */
export function getCustomContractFromType(
  customContracts: CustomContractMetadata[],
  type: string,
): CustomContractMetadata | undefined {
  return customContracts.find((c) => c.name === type);
}
